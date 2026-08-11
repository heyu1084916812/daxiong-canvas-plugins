from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Any, Dict


DEFAULT_CAPABILITIES = frozenset({
    "canvas.smart.v1",
    "canvas.classic.v1",
    "image.files.v1",
    "plugin.websocket.v1",
    "host.storage.v1",
})


class PluginStorage:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()

    def _path(self, key: str) -> Path:
        clean = str(key or "").strip().replace("\\", "/")
        if not clean or clean.startswith("/") or ".." in clean.split("/"):
            raise ValueError("无效的插件存储键")
        path = (self.root / f"{clean}.json").resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError("插件存储路径越界")
        return path

    def read(self, key: str, default: Any = None) -> Any:
        path = self._path(key)
        if not path.is_file():
            return default
        with self._lock:
            return json.loads(path.read_text(encoding="utf-8"))

    def write(self, key: str, value: Any) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            fd, temp_name = tempfile.mkstemp(prefix="plugin-data-", suffix=".tmp", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                    json.dump(value, stream, ensure_ascii=False, indent=2)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp_name, path)
            finally:
                Path(temp_name).unlink(missing_ok=True)


class PluginHostContext:
    """Stable, versioned capabilities passed to v2 plugins."""

    schema_version = 1

    def __init__(self, host: Any, record: Any, main_module: Any):
        self._host = host
        self.record = record
        self.plugin_id = record.plugin_id
        self.root = record.root
        self.data_root = host.data_root / record.plugin_id
        self.storage = PluginStorage(self.data_root)
        self.core_version = host.core_version
        self.capabilities = {
            name: None for name in host.capabilities
        }
        if hasattr(main_module, "canvas_llm"):
            self.capabilities["llm.canvas.v1"] = main_module.canvas_llm
        if hasattr(main_module, "CanvasLLMRequest"):
            self.capabilities["models.canvas_llm_request.v1"] = main_module.CanvasLLMRequest
        if hasattr(main_module, "manager"):
            self.capabilities["events.v1"] = main_module.manager
        # Explicit compatibility adapter; plugins receive only these named operations.
        self.images = {
            "schemaVersion": 1,
            "resolveProjectImage": main_module.output_file_from_url,
            "outputPathFor": main_module.output_path_for,
            "outputUrlFor": main_module.output_url_for,
        }

    def __getitem__(self, key: str) -> Any:
        """Temporary mapping adapter for early schema-v2 plugin packages."""
        values = {
            "base_dir": self._host.base_dir,
            "plugin_data_root": self._host.data_root,
            "core_version": self.core_version,
            "plugin": self.record,
            "capabilities": self.capabilities,
            "is_plugin_enabled": lambda plugin_id: self._host.state_store.enabled(plugin_id, False),
            "resolve_asset_url": self.images["resolveProjectImage"],
            "output_path_for": self.images["outputPathFor"],
            "output_url_for": self.images["outputUrlFor"],
        }
        if key not in values:
            raise KeyError(key)
        return values[key]

    def legacy_context(self) -> Dict[str, Any]:
        return {
            "base_dir": self._host.base_dir,
            "core_version": self.core_version,
            "plugin": self.record,
            "resolve_asset_url": self.images["resolveProjectImage"],
            "output_path_for": self.images["outputPathFor"],
            "output_url_for": self.images["outputUrlFor"],
            "plugin_data_dir": self.data_root,
            "plugin_data_root": self._host.data_root,
            "is_plugin_enabled": lambda plugin_id: self._host.state_store.enabled(plugin_id, False),
            "capabilities": self.capabilities,
        }
