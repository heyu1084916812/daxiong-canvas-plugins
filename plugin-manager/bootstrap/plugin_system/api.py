from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from .installer import PluginInstallError, install_or_upgrade, uninstall_plugin
from .remote_repository import PluginRepositoryError, RemotePluginRepository


def create_manager_router(host) -> APIRouter:
    router = APIRouter(prefix="/api/plugin-manager", tags=["plugin-manager"])
    repository = RemotePluginRepository(host)

    @router.get("/plugins")
    async def list_plugins():
        return host.public_status()

    @router.get("/core-version")
    async def core_version():
        info = host.inspect_core_version()
        host.rescan()
        status = host.public_status()
        return {
            "ok": True,
            "core_version": status.get("core_version"),
            "version": info,
            "plugins": status.get("plugins") or [],
            "incompatible_plugins": [
                item for item in (status.get("plugins") or [])
                if not item.get("compatible", True)
            ],
        }

    @router.post("/core-version/detect")
    async def detect_core_version():
        return await core_version()

    @router.post("/rescan")
    async def rescan():
        host.rescan()
        return host.public_status()

    @router.get("/updates")
    async def updates(force: bool = Query(default=False)):
        try:
            return repository.list_updates(force=force)
        except PluginRepositoryError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.post("/updates/check")
    async def check_updates():
        try:
            return repository.list_updates(force=True)
        except PluginRepositoryError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    async def receive_zip(upload: UploadFile) -> Path:
        suffix = Path(upload.filename or "plugin.zip").suffix.lower()
        if suffix != ".zip":
            raise HTTPException(status_code=400, detail="只能上传 ZIP 插件包")
        handle = tempfile.NamedTemporaryFile(prefix="plugin-upload-", suffix=".zip", delete=False)
        path = Path(handle.name)
        try:
            with handle:
                shutil.copyfileobj(upload.file, handle)
            return path
        finally:
            await upload.close()

    @router.post("/install")
    async def install(file: UploadFile = File(...)):
        path = await receive_zip(file)
        try:
            plugin_id = install_or_upgrade(path, host.plugins_root, upgrade=False)
            host.rescan()
            return {"ok": True, "plugin_id": plugin_id, "plugin": host.require(plugin_id).public_dict()}
        except (PluginInstallError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            path.unlink(missing_ok=True)

    @router.post("/{plugin_id}/enable")
    async def enable(plugin_id: str):
        return {"ok": True, "plugin": host.set_enabled(plugin_id, True).public_dict()}

    @router.post("/{plugin_id}/disable")
    async def disable(plugin_id: str):
        return {"ok": True, "plugin": host.set_enabled(plugin_id, False).public_dict()}

    @router.post("/{plugin_id}/upgrade")
    async def upgrade(plugin_id: str, file: UploadFile = File(...)):
        host.require(plugin_id)
        path = await receive_zip(file)
        try:
            installed_id = install_or_upgrade(
                path, host.plugins_root, upgrade=True, expected_id=plugin_id
            )
            host.rescan()
            record = host.require(plugin_id)
            record.restart_required = bool(record.manifest.get("backend"))
            record.refresh_required = not record.restart_required
            return {"ok": True, "plugin": record.public_dict()}
        except (PluginInstallError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            path.unlink(missing_ok=True)

    @router.post("/{plugin_id}/update-from-repository")
    async def update_from_repository(plugin_id: str):
        try:
            return repository.update_plugin(plugin_id)
        except (PluginRepositoryError, PluginInstallError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/{plugin_id}/install-from-repository")
    async def install_from_repository(plugin_id: str):
        try:
            return repository.install_plugin(plugin_id)
        except (PluginRepositoryError, PluginInstallError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.delete("/{plugin_id}")
    async def uninstall(plugin_id: str, delete_data: bool = Query(default=False)):
        record = host.require(plugin_id)
        if record.enabled:
            host.set_enabled(plugin_id, False)
        uninstall_plugin(record.root, host.data_root / plugin_id, delete_data=delete_data)
        shutil.rmtree(host.base_dir / f".plugin-backup-{plugin_id}", ignore_errors=True)
        host.state_store.remove(plugin_id)
        host.rescan()
        return {"ok": True, "plugin_id": plugin_id, "data_deleted": delete_data}

    @router.get("/{plugin_id}/health")
    async def health(plugin_id: str):
        return host.check_health(plugin_id)

    @router.get("/{plugin_id}/logs")
    async def logs(plugin_id: str, limit: int = Query(default=200, ge=1, le=1000)):
        host.require(plugin_id)
        return {"plugin_id": plugin_id, "lines": host.read_logs(plugin_id, limit)}

    return router
