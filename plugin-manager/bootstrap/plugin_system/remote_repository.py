from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlparse

import requests

from .compatibility import compatibility_error, normalize_manifest, version_tuple
from .installer import MAX_ZIP_BYTES, PluginInstallError, install_or_upgrade, stage_plugin_zip


DEFAULT_PLUGIN_INDEX_URL = (
    "https://raw.githubusercontent.com/heyu1084916812/"
    "daxiong-canvas-plugins/updates/plugins-index.json"
)
DEFAULT_RELEASE_PREFIX = (
    "https://github.com/heyu1084916812/daxiong-canvas-plugins/releases/download/"
)
CACHE_SECONDS = 600


class PluginRepositoryError(RuntimeError):
    pass


class RemotePluginRepository:
    """Read a signed-by-location catalog and feed verified ZIPs to the installer."""

    def __init__(self, host) -> None:
        self.host = host
        self.index_url = os.environ.get("DAXIONG_PLUGIN_INDEX_URL", DEFAULT_PLUGIN_INDEX_URL).strip()
        self.release_prefix = os.environ.get(
            "DAXIONG_PLUGIN_RELEASE_PREFIX", DEFAULT_RELEASE_PREFIX
        ).strip()
        self._etag = ""
        self._catalog: Dict[str, Any] | None = None
        self._catalog_at = 0.0
        self._catalog_stale = False
        self._lock = threading.Lock()

    @staticmethod
    def _validate_catalog(payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict) or int(payload.get("schema_version") or 0) != 1:
            raise PluginRepositoryError("插件仓库索引格式不受支持")
        raw_plugins = payload.get("plugins")
        if not isinstance(raw_plugins, list):
            raise PluginRepositoryError("插件仓库索引缺少 plugins 数组")
        plugins: Dict[str, Dict[str, Any]] = {}
        for raw in raw_plugins:
            if not isinstance(raw, dict):
                continue
            plugin_id = str(raw.get("id") or "").strip()
            version = str(raw.get("version") or "").strip()
            url = str(raw.get("download_url") or "").strip()
            digest = str(raw.get("sha256") or "").strip().lower()
            if not plugin_id or not version or not url or len(digest) != 64:
                raise PluginRepositoryError(f"插件 {plugin_id or '<unknown>'} 的发布信息不完整")
            if plugin_id in plugins:
                raise PluginRepositoryError(f"插件仓库索引包含重复 ID：{plugin_id}")
            plugins[plugin_id] = dict(raw)
        return {**payload, "plugins_by_id": plugins}

    def _fetch_catalog(self, *, force: bool = False) -> Dict[str, Any]:
        now = time.time()
        if not force and self._catalog and now - self._catalog_at < CACHE_SECONDS:
            return self._catalog
        headers = {
            "Accept": "application/json",
            "User-Agent": "Daxiong-Canvas-Plugin-Updater",
        }
        if self._etag:
            headers["If-None-Match"] = self._etag
        try:
            response = requests.get(
                self.index_url,
                headers=headers,
                timeout=(5, 15),
                proxies=None,
            )
            if response.status_code == 304 and self._catalog:
                self._catalog_at = now
                self._catalog_stale = False
                return self._catalog
            response.raise_for_status()
            if len(response.content) > 2 * 1024 * 1024:
                raise PluginRepositoryError("插件仓库索引体积异常")
            catalog = self._validate_catalog(response.json())
            self._catalog = catalog
            self._catalog_at = now
            self._catalog_stale = False
            self._etag = response.headers.get("ETag", "")
            return catalog
        except Exception as exc:
            if self._catalog:
                self._catalog_stale = True
                return self._catalog
            if isinstance(exc, PluginRepositoryError):
                raise
            raise PluginRepositoryError(f"无法读取插件仓库：{exc}") from exc

    def list_updates(self, *, force: bool = False) -> Dict[str, Any]:
        catalog = self._fetch_catalog(force=force)
        remote = catalog.get("plugins_by_id") or {}
        status = self.host.public_status()
        installed_ids = {str(item.get("id") or "") for item in (status.get("plugins") or [])}
        update_count = 0
        compatible_update_count = 0
        for plugin in status.get("plugins") or []:
            item = remote.get(plugin.get("id"))
            plugin.update(
                {
                    "update_available": False,
                    "update_compatible": False,
                    "latest_version": "",
                    "update_changelog": [],
                    "update_download_size": 0,
                }
            )
            if not item:
                continue
            latest = str(item.get("version") or "")
            plugin["latest_version"] = latest
            plugin["update_changelog"] = list(item.get("changelog") or [])[:20]
            plugin["update_download_size"] = int(item.get("size") or 0)
            available = version_tuple(latest) > version_tuple(str(plugin.get("version") or "0"))
            reason = compatibility_error(item, self.host.core_version, self.host.capabilities)
            plugin["update_available"] = available
            plugin["update_compatible"] = not bool(reason)
            plugin["update_reason"] = reason
            if available:
                update_count += 1
                if not reason:
                    compatible_update_count += 1
        available_plugins = []
        for plugin_id, item in sorted(remote.items()):
            if plugin_id in installed_ids:
                continue
            reason = compatibility_error(item, self.host.core_version, self.host.capabilities)
            available_plugins.append(
                {
                    "id": plugin_id,
                    "name": str(item.get("name") or plugin_id),
                    "description": str(item.get("description") or "可从插件仓库一键安装"),
                    "author": str(item.get("author") or "daxiong-canvas-plugins"),
                    "version": str(item.get("version") or ""),
                    "latest_version": str(item.get("version") or ""),
                    "installed": False,
                    "manifest_valid": True,
                    "compatible": not bool(reason),
                    "enabled": False,
                    "backend_registered": False,
                    "frontend_active": False,
                    "health": "not_installed",
                    "reason": reason,
                    "install_available": True,
                    "install_compatible": not bool(reason),
                    "update_available": False,
                    "update_compatible": False,
                    "update_changelog": list(item.get("changelog") or [])[:20],
                    "update_download_size": int(item.get("size") or 0),
                }
            )
        status.update(
            {
                "repository_url": self.index_url,
                "catalog_generated_at": catalog.get("generated_at") or "",
                "catalog_stale": self._catalog_stale,
                "update_count": update_count,
                "compatible_update_count": compatible_update_count,
                "available_plugins": available_plugins,
                "available_count": len(available_plugins),
            }
        )
        return status

    def _validate_release_url(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not url.startswith(self.release_prefix):
            raise PluginRepositoryError("插件下载地址不属于已配置的 GitHub 发布仓库")

    def _download(self, item: Dict[str, Any]) -> Path:
        url = str(item.get("download_url") or "")
        self._validate_release_url(url)
        declared_size = int(item.get("size") or 0)
        if declared_size < 1 or declared_size > MAX_ZIP_BYTES:
            raise PluginRepositoryError("插件安装包声明的体积异常")
        digest = hashlib.sha256()
        handle = tempfile.NamedTemporaryFile(prefix="plugin-repository-", suffix=".zip", delete=False)
        path = Path(handle.name)
        total = 0
        try:
            with handle, requests.get(
                url,
                headers={"User-Agent": "Daxiong-Canvas-Plugin-Updater"},
                stream=True,
                timeout=(10, 120),
                proxies=None,
            ) as response:
                response.raise_for_status()
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_ZIP_BYTES:
                        raise PluginRepositoryError("插件安装包体积超过限制")
                    digest.update(chunk)
                    handle.write(chunk)
            if total != declared_size:
                raise PluginRepositoryError("插件安装包体积与发布索引不一致")
            expected = str(item.get("sha256") or "").lower()
            if digest.hexdigest() != expected:
                raise PluginRepositoryError("插件安装包 SHA-256 校验失败")
            return path
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def _install_release(
        self, plugin_id: str, item: Dict[str, Any], *, upgrade: bool, from_version: str = ""
    ) -> Dict[str, Any]:
        latest = str(item.get("version") or "")
        reason = compatibility_error(item, self.host.core_version, self.host.capabilities)
        if reason:
            raise PluginRepositoryError(f"插件与当前画布不兼容：{reason}")
        package = self._download(item)
        staged_root: Path | None = None
        try:
            staged_root, raw = stage_plugin_zip(package, self.host.base_dir)
            manifest, _, _ = normalize_manifest(raw, staged_root, enforce_directory_id=False)
            if str(manifest.get("id") or "") != plugin_id:
                raise PluginInstallError("远程安装包的插件 ID 与目标插件不一致")
            if str(manifest.get("version") or "") != latest:
                raise PluginInstallError("远程安装包版本与发布索引不一致")
            reason = compatibility_error(manifest, self.host.core_version, self.host.capabilities)
            if reason:
                raise PluginInstallError(f"远程安装包与当前画布不兼容：{reason}")
            if staged_root.parent.name.startswith("plugin-stage-"):
                shutil.rmtree(staged_root.parent, ignore_errors=True)
            staged_root = None
            install_or_upgrade(
                package,
                self.host.plugins_root,
                upgrade=upgrade,
                expected_id=plugin_id,
            )
            self.host.rescan()
            installed = self.host.require(plugin_id)
            installed.restart_required = bool(upgrade and installed.manifest.get("backend"))
            installed.refresh_required = not installed.restart_required
            return {
                "ok": True,
                "plugin": installed.public_dict(),
                "from_version": from_version,
                "version": latest,
                "installed_from_repository": not upgrade,
                "restart_required": installed.restart_required,
                "refresh_required": installed.refresh_required,
            }
        finally:
            if staged_root is not None and staged_root.parent.name.startswith("plugin-stage-"):
                shutil.rmtree(staged_root.parent, ignore_errors=True)
            package.unlink(missing_ok=True)

    def install_plugin(self, plugin_id: str) -> Dict[str, Any]:
        with self._lock:
            if plugin_id in self.host.records:
                raise PluginRepositoryError("插件已经安装，请使用一键更新")
            catalog = self._fetch_catalog(force=True)
            item = (catalog.get("plugins_by_id") or {}).get(plugin_id)
            if not item:
                raise PluginRepositoryError("插件仓库没有这个插件的发布记录")
            return self._install_release(plugin_id, item, upgrade=False)

    def update_plugin(self, plugin_id: str) -> Dict[str, Any]:
        with self._lock:
            record = self.host.require(plugin_id)
            catalog = self._fetch_catalog(force=True)
            item = (catalog.get("plugins_by_id") or {}).get(plugin_id)
            if not item:
                raise PluginRepositoryError("插件仓库没有这个插件的发布记录")
            latest = str(item.get("version") or "")
            if version_tuple(latest) <= version_tuple(record.version):
                raise PluginRepositoryError(f"{record.name} 已是最新版本 {record.version}")
            return self._install_release(
                plugin_id, item, upgrade=True, from_version=record.version
            )
