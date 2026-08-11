from __future__ import annotations

import datetime as dt
import html as html_module
import os
import re
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .api import create_manager_router
from .capability_bridge import DEFAULT_CAPABILITIES, PluginHostContext
from .compatibility import contained_file
from .discovery import discover_plugins
from .lifecycle import disable, enable, health, load_backend
from .models import PluginRecord
from .state_store import PluginStateStore


class PluginHost:
    def __init__(self, app: FastAPI, main_module: Any, base_dir: Path | str):
        self.app = app
        self.main_module = main_module
        self.base_dir = Path(base_dir).resolve()
        self.plugins_root = self.base_dir / "plugins"
        self.data_root = self.base_dir / "plugin-data"
        self.log_root = self.base_dir / "data" / "plugin-logs"
        self.state_store = PluginStateStore(self.base_dir / "data" / "plugin-state.json")
        self.core_version = self._read_core_version()
        capabilities = set(DEFAULT_CAPABILITIES)
        if hasattr(main_module, "canvas_llm"):
            capabilities.add("llm.canvas.v1")
        if hasattr(main_module, "CanvasLLMRequest"):
            capabilities.add("models.canvas_llm_request.v1")
        if hasattr(main_module, "manager"):
            capabilities.add("events.v1")
        if hasattr(main_module, "create_canvas_image_task") or hasattr(main_module, "canvas_image_tasks"):
            capabilities.add("tasks.canvas-image.v1")
        self.capabilities = frozenset(capabilities)
        self.records: Dict[str, PluginRecord] = {}
        self._registered: Dict[str, PluginRecord] = {}
        self._lock = threading.RLock()
        self._install_routes_and_middleware()
        self.rescan()

    def _read_version_text(self, path: Path) -> str:
        try:
            if not path.is_file():
                return ""
            text = path.read_text(encoding="utf-8", errors="replace").strip()
            if not text:
                return ""
            return text.splitlines()[0].strip()
        except OSError:
            return ""

    def _read_main_app_version(self) -> str:
        path = self.base_dir / "main.py"
        if not path.is_file():
            return ""
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:8000]
        except OSError:
            return ""
        match = re.search(r"APP_VERSION\s*=\s*[\'\"]([^\'\"]+)[\'\"]", text)
        return str(match.group(1)).strip() if match else ""

    def _scan_backup_versions(self) -> list[dict]:
        backup_root = self.base_dir / "data" / "update_backups"
        if not backup_root.is_dir():
            return []
        items: list[dict] = []
        try:
            children = sorted(backup_root.iterdir(), key=lambda p: p.name, reverse=True)
        except OSError:
            return []
        for child in children[:80]:
            if not child.is_dir():
                continue
            version = self._read_version_text(child / "VERSION")
            if not version:
                continue
            rel = str((child / "VERSION").relative_to(self.base_dir)).replace("\\", "/")
            items.append({"path": rel, "version": version})
        return items

    def _pick_latest_version(self, versions: list[str]) -> str:
        from .compatibility import version_tuple
        best = ""
        best_key = (-1,)
        for raw in versions:
            value = str(raw or "").strip()
            if not value:
                continue
            key = version_tuple(value)
            if key > best_key:
                best_key = key
                best = value
        return best or "0"

    def inspect_core_version(self) -> dict:
        """Resolve live canvas core version and always re-bind to latest active source.

        Active sources: root VERSION, main.py APP_VERSION.
        Backup VERSION files under data/update_backups are reported only and never bound.
        """
        from .compatibility import version_tuple

        root_version = self._read_version_text(self.base_dir / "VERSION")
        main_version = self._read_main_app_version()
        backups = self._scan_backup_versions()
        backup_versions = [item.get("version") or "" for item in backups]
        latest_backup = self._pick_latest_version(backup_versions)
        active_candidates = [root_version, main_version]
        effective = self._pick_latest_version(active_candidates)
        stale_backups = []
        for item in backups:
            ver = str(item.get("version") or "")
            if ver and version_tuple(ver) < version_tuple(effective):
                stale_backups.append(item)
        previous = str(getattr(self, "core_version", "") or "")
        rebound = previous != effective
        self.core_version = effective
        return {
            "core_version": effective,
            "previous_core_version": previous,
            "rebound": rebound,
            "sources": {
                "version_file": root_version or None,
                "main_app_version": main_version or None,
                "active_candidates": [v for v in active_candidates if v],
                "latest_backup_version": latest_backup if latest_backup != "0" else None,
                "backup_count": len(backups),
                "stale_backup_count": len(stale_backups),
                "stale_backups_sample": stale_backups[:8],
            },
            "binding_rule": "always_bind_latest_active_source",
            "note": "data/update_backups 中的旧 VERSION 仅作历史备份，不会作为当前核心版本。",
        }

    def _read_core_version(self) -> str:
        return str(self.inspect_core_version().get("core_version") or "0")

    def _install_routes_and_middleware(self) -> None:
        self.app.include_router(create_manager_router(self))

        @self.app.get("/api/plugins")
        async def legacy_plugin_list():
            return self.public_status()

        @self.app.get("/plugins/{plugin_id}/{asset_path:path}")
        async def plugin_asset(plugin_id: str, asset_path: str):
            record = self.require(plugin_id)
            try:
                path = contained_file(record.root, asset_path)
            except ValueError as exc:
                raise HTTPException(status_code=404, detail="插件资源不存在") from exc
            suffix = path.suffix.lower()
            if suffix == ".svg":
                media_type = "image/svg+xml"
            elif suffix == ".js":
                media_type = "application/javascript; charset=utf-8"
            elif suffix == ".css":
                media_type = "text/css; charset=utf-8"
            elif suffix in {".html", ".htm"}:
                media_type = "text/html; charset=utf-8"
            elif suffix == ".json":
                media_type = "application/json; charset=utf-8"
            else:
                media_type = None
            return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})

        @self.app.middleware("http")
        async def plugin_runtime_middleware(request: Request, call_next):
            match = re.match(r"^/api/plugins/([a-z0-9_-]+)(?:/|$)", request.url.path)
            if match:
                plugin_id = match.group(1)
                record = self.records.get(plugin_id)
                if not record or not record.backend_registered:
                    return JSONResponse(status_code=404, content={"detail": "插件后端未注册"})
                if not record.enabled:
                    return JSONResponse(status_code=403, content={"detail": "插件已停用", "plugin_id": plugin_id})
                if not record.compatible:
                    return JSONResponse(status_code=409, content={"detail": record.compatibility_reason, "plugin_id": plugin_id})
            target = {
                "/static/canvas.html": (self.base_dir / "static" / "canvas.html", "classic_canvas"),
                "/static/smart-canvas.html": (self.base_dir / "static" / "smart-canvas.html", "smart_canvas"),
            }.get(request.url.path)
            if target and target[0].is_file():
                html = target[0].read_text(encoding="utf-8", errors="replace")
                return HTMLResponse(self.inject_assets(html, target[1]), media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})
            return await call_next(request)

    def rescan(self) -> List[PluginRecord]:
        with self._lock:
            # Re-bind core version every scan so upgraded VERSION takes effect
            # even when historical backup VERSION files still exist.
            self.inspect_core_version()
            discovered = discover_plugins(
                self.plugins_root, self.core_version, self.capabilities, self.state_store
            )
            new_records = {record.plugin_id: record for record in discovered}
            for record in discovered:
                old = self._registered.get(record.plugin_id)
                if old is not None:
                    record.backend_registered = old.backend_registered
                    record.plugin_object = old.plugin_object
                    if old.version != record.version and record.manifest.get("backend"):
                        record.restart_required = True
                    continue
                if not record.manifest_valid or not record.compatible:
                    continue
                try:
                    context = PluginHostContext(self, record, self.main_module)
                    load_backend(record, self.app, context)
                    self._registered[record.plugin_id] = record
                    if record.enabled:
                        enable(record)
                    backup = self.base_dir / f".plugin-backup-{record.plugin_id}"
                    if backup.is_dir():
                        shutil.rmtree(backup)
                    self.log(record, "register", "PLUGIN_REGISTERED", "插件后端已注册")
                except Exception as exc:
                    record.backend_registered = False
                    record.health = "error"
                    record.error_code = "BACKEND_LOAD_FAILED"
                    record.error_message = str(exc)
                    self.log(record, "register", record.error_code, record.error_message)
                    backup = self.base_dir / f".plugin-backup-{record.plugin_id}"
                    if backup.is_dir():
                        try:
                            if record.root.is_dir():
                                shutil.rmtree(record.root)
                            os.replace(backup, record.root)
                            self.log(record, "rollback", "UPGRADE_ROLLED_BACK", "升级启动失败，已恢复上一版本")
                            return self.rescan()
                        except Exception as rollback_exc:
                            record.error_code = "UPGRADE_ROLLBACK_FAILED"
                            record.error_message = f"{exc}; rollback: {rollback_exc}"
            self.records = new_records
            for record in self.records.values():
                record.frontend_active = self._frontend_active(record)
            return list(self.records.values())

    def _frontend_active(self, record: PluginRecord) -> bool:
        return bool(record.enabled and record.compatible and record.manifest_valid and record.manifest.get("frontend"))

    def set_enabled(self, plugin_id: str, value: bool) -> PluginRecord:
        with self._lock:
            record = self.require(plugin_id)
            if value and (not record.manifest_valid or not record.compatible or not record.backend_registered):
                detail = record.error_message or record.compatibility_reason or "插件后端未注册"
                raise HTTPException(status_code=409, detail=detail)
            try:
                if value:
                    enable(record)
                else:
                    disable(record)
                self.state_store.set_enabled(plugin_id, value)
                record.enabled = value
                record.frontend_active = self._frontend_active(record)
                record.refresh_required = bool(record.manifest.get("frontend"))
                self.log(record, "enable" if value else "disable", "OK", "生命周期执行成功")
                registered = self._registered.get(plugin_id)
                if registered is not None:
                    registered.enabled = value
                return record
            except Exception as exc:
                record.health = "error"
                record.error_code = "LIFECYCLE_FAILED"
                record.error_message = str(exc)
                self.log(record, "enable" if value else "disable", record.error_code, str(exc))
                raise HTTPException(status_code=500, detail=str(exc)) from exc

    def inject_assets(self, html: str, target_name: str) -> str:
        css_tags: List[str] = []
        js_tags: List[str] = []
        for record in sorted(self.records.values(), key=lambda item: item.plugin_id):
            if not record.enabled or not record.compatible or not record.manifest_valid:
                continue
            target = (record.manifest.get("frontend") or {}).get(target_name) or {}
            plugin_id = html_module.escape(record.plugin_id, quote=True)
            version = html_module.escape(record.version, quote=True)
            for relative in target.get("css") or []:
                relative = html_module.escape(str(relative), quote=True)
                css_tags.append(
                    f'<link rel="stylesheet" data-plugin-id="{plugin_id}" '
                    f'href="/plugins/{plugin_id}/{relative}?v={version}">'
                )
            for relative in target.get("js") or []:
                relative = html_module.escape(str(relative), quote=True)
                js_tags.append(
                    f'<script data-plugin-id="{plugin_id}" '
                    f'src="/plugins/{plugin_id}/{relative}?v={version}" charset="utf-8"></script>'
                )
        if css_tags:
            html = html.replace("</head>", "\n".join(css_tags) + "\n</head>")
        if js_tags:
            html = html.replace("</body>", "\n".join(js_tags) + "\n</body>")
        return html

    def require(self, plugin_id: str) -> PluginRecord:
        record = self.records.get(plugin_id)
        if not record:
            raise HTTPException(status_code=404, detail=f"插件不存在: {plugin_id}")
        return record

    def public_status(self) -> dict:
        version_info = self.inspect_core_version()
        return {
            "schema_version": 1,
            "core_version": self.core_version,
            "core_version_info": version_info,
            "capabilities": sorted(self.capabilities),
            "plugins": [record.public_dict() for record in sorted(self.records.values(), key=lambda item: item.plugin_id)],
        }

    def check_health(self, plugin_id: str) -> dict:
        record = self.require(plugin_id)
        try:
            result = health(record)
            record.health = str(result.get("status") or "unknown")
            return {"plugin_id": plugin_id, **result}
        except Exception as exc:
            record.health = "error"
            record.error_code = "HEALTH_CHECK_FAILED"
            record.error_message = str(exc)
            self.log(record, "health", record.error_code, str(exc))
            return {"plugin_id": plugin_id, "status": "error", "details": str(exc)}

    def log(self, record: PluginRecord, phase: str, code: str, message: str) -> None:
        try:
            self.log_root.mkdir(parents=True, exist_ok=True)
            timestamp = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
            safe = str(message).replace("\r", " ").replace("\n", " ")[:2000]
            line = f"{timestamp}\t{record.plugin_id}\t{record.version}\t{self.core_version}\t{phase}\t{code}\t{safe}\n"
            with (self.log_root / f"{record.plugin_id}.log").open("a", encoding="utf-8") as stream:
                stream.write(line)
        except OSError:
            pass

    def read_logs(self, plugin_id: str, limit: int) -> list[str]:
        path = self.log_root / f"{plugin_id}.log"
        if not path.is_file():
            return []
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]


def install_plugins(app: FastAPI, main_module: Any, base_dir: Path | str) -> PluginHost:
    return PluginHost(app, main_module, base_dir)
