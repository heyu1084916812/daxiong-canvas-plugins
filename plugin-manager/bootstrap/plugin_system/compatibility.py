from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, Tuple


PLUGIN_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")


def version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", str(value or ""))) or (0,)


def contained_file(root: Path, relative: str, *, required: bool = True) -> Path:
    text = str(relative or "").strip().replace("\\", "/")
    if not text or text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise ValueError("入口路径无效")
    target = (root / text).resolve()
    base = root.resolve()
    if target != base and base not in target.parents:
        raise ValueError(f"入口越界: {relative}")
    if required and not target.is_file():
        raise ValueError(f"入口文件不存在: {relative}")
    return target


def normalize_manifest(
    raw: Dict[str, Any], root: Path, *, enforce_directory_id: bool = True
) -> Tuple[Dict[str, Any], int, bool]:
    if not isinstance(raw, dict):
        raise ValueError("plugin.json 必须是 JSON 对象")
    manifest = dict(raw)
    schema = int(manifest.get("schema_version") or 1)
    if schema not in (1, 2):
        raise ValueError(f"不支持的 schema_version: {schema}")
    plugin_id = str(manifest.get("id") or root.name).strip()
    if not PLUGIN_ID_RE.fullmatch(plugin_id):
        raise ValueError("插件 ID 只能包含小写字母、数字、_ 或 -")
    if enforce_directory_id and root.name != plugin_id:
        raise ValueError("插件目录名必须与插件 ID 一致")
    manifest["id"] = plugin_id
    manifest.setdefault("name", plugin_id)
    manifest.setdefault("version", "0.0.0")
    backend = manifest.get("backend")
    if isinstance(backend, str):
        manifest["backend"] = {"entry": backend, "route_prefix": f"/api/plugins/{plugin_id}"}
    elif backend is None:
        manifest["backend"] = {}
    elif not isinstance(backend, dict):
        raise ValueError("backend 必须是对象或旧版入口字符串")
    entry = str(manifest["backend"].get("entry") or "").strip()
    if entry:
        module_path = entry.partition(":")[0]
        contained_file(root, module_path)
        prefix = str(manifest["backend"].get("route_prefix") or f"/api/plugins/{plugin_id}").rstrip("/")
        expected = f"/api/plugins/{plugin_id}"
        if prefix != expected:
            raise ValueError(f"后端路由必须位于 {expected}/ 下")
        manifest["backend"]["route_prefix"] = expected
    frontend = manifest.get("frontend") or {}
    if not isinstance(frontend, dict):
        raise ValueError("frontend 必须是对象")
    for target_name, target in frontend.items():
        if target_name not in ("classic_canvas", "smart_canvas") or not isinstance(target, dict):
            raise ValueError(f"未知前端目标: {target_name}")
        for kind in ("css", "js"):
            values = target.get(kind) or []
            if not isinstance(values, list):
                raise ValueError(f"frontend.{target_name}.{kind} 必须是数组")
            for relative in values:
                contained_file(root, str(relative))
    icon = str(manifest.get("icon") or "").strip()
    if icon:
        contained_file(root, icon)
    return manifest, schema, schema == 1


def compatibility_error(
    manifest: Dict[str, Any], core_version: str, capabilities: Iterable[str]
) -> str:
    minimum = str(manifest.get("min_core_version") or "")
    maximum = str(manifest.get("max_core_version") or "")
    if minimum and version_tuple(core_version) < version_tuple(minimum):
        return f"需要核心版本 {minimum} 或更高，当前为 {core_version}"
    if maximum and version_tuple(core_version) > version_tuple(maximum):
        return f"最高支持核心版本 {maximum}，当前为 {core_version}"
    missing = sorted(set(manifest.get("requires_capabilities") or []) - set(capabilities))
    if missing:
        return "缺少宿主能力: " + ", ".join(missing)
    return ""
