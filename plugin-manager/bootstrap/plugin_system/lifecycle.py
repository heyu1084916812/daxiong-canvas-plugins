from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path
from typing import Any

from .compatibility import contained_file
from .models import PluginRecord


def _call_lifecycle(target: Any, name: str) -> Any:
    callback = getattr(target, name, None)
    if not callable(callback):
        return None
    value = callback()
    if inspect.isawaitable(value):
        raise RuntimeError(f"{name}() 当前必须是同步函数")
    return value


def load_backend(record: PluginRecord, app: Any, host_context: Any) -> None:
    backend = record.manifest.get("backend") or {}
    entry = str(backend.get("entry") or "").strip()
    if not entry:
        record.backend_registered = True
        record.plugin_object = None
        return
    module_rel, _, callable_name = entry.partition(":")
    module_path = contained_file(record.root, module_rel)
    module_name = f"infinite_canvas_plugin_{record.plugin_id.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if not spec or not spec.loader:
        raise ImportError(f"无法加载插件模块: {module_rel}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    plugin_path = str(record.root.resolve())
    inserted = plugin_path not in sys.path
    if inserted:
        sys.path.insert(0, plugin_path)
    try:
        spec.loader.exec_module(module)
        entrypoint = getattr(module, callable_name or ("create_plugin" if record.schema_version == 2 else "register"))
        if record.schema_version == 1 or (callable_name or "register") == "register":
            entrypoint(app, host_context.legacy_context())
            plugin_object = module
        else:
            plugin_object = entrypoint(host_context)
            register = getattr(plugin_object, "register", None)
            if callable(register):
                register(app)
        record.plugin_object = plugin_object
        record.backend_registered = True
    finally:
        if inserted:
            try:
                sys.path.remove(plugin_path)
            except ValueError:
                pass


def enable(record: PluginRecord) -> None:
    if record.plugin_object is not None:
        _call_lifecycle(record.plugin_object, "on_enable")
    record.health = "healthy"


def disable(record: PluginRecord) -> None:
    if record.plugin_object is not None:
        _call_lifecycle(record.plugin_object, "on_disable")
    record.health = "disabled"


def health(record: PluginRecord) -> dict:
    if not record.manifest_valid:
        return {"status": "error", "details": record.error_message}
    if not record.compatible:
        return {"status": "incompatible", "details": record.compatibility_reason}
    callback = getattr(record.plugin_object, "health_check", None)
    if callable(callback):
        result = callback()
        if inspect.isawaitable(result):
            raise RuntimeError("health_check() 当前必须是同步函数")
        if isinstance(result, dict):
            return result
        return {"status": "healthy" if result is not False else "error"}
    missing = []
    for target in (record.manifest.get("frontend") or {}).values():
        for kind in ("css", "js"):
            for relative in target.get(kind) or []:
                if not (record.root / relative).is_file():
                    missing.append(relative)
    return {"status": "healthy" if not missing else "error", "missing_assets": missing}
