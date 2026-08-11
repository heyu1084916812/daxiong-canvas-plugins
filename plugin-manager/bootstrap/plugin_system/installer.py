from __future__ import annotations

import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Tuple

from .compatibility import PLUGIN_ID_RE, normalize_manifest
import json


MAX_ZIP_BYTES = 256 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_FILES = 10_000


class PluginInstallError(ValueError):
    pass


def _validated_members(archive: zipfile.ZipFile):
    infos = archive.infolist()
    if len(infos) > MAX_FILES:
        raise PluginInstallError("ZIP 文件数量超过限制")
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        path = PurePosixPath(name)
        if not name or name.startswith("/") or ".." in path.parts or path.is_absolute():
            raise PluginInstallError(f"ZIP 包含越界路径: {name}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise PluginInstallError(f"ZIP 不允许软链接: {name}")
        total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise PluginInstallError("ZIP 解压后体积超过限制")
        yield info


def _find_plugin_root(stage: Path) -> Path:
    direct = stage / "plugin.json"
    if direct.is_file():
        return stage
    children = [item for item in stage.iterdir() if item.is_dir() and (item / "plugin.json").is_file()]
    extras = [item for item in stage.iterdir() if item.name not in {"__MACOSX"}]
    if len(children) == 1 and len(extras) == 1:
        return children[0]
    raise PluginInstallError("ZIP 根目录或唯一顶层目录中必须包含 plugin.json")


def stage_plugin_zip(zip_path: Path, work_root: Path) -> Tuple[Path, dict]:
    if not zip_path.is_file() or zip_path.stat().st_size > MAX_ZIP_BYTES:
        raise PluginInstallError("ZIP 不存在或体积超过限制")
    stage = Path(tempfile.mkdtemp(prefix="plugin-stage-", dir=work_root))
    try:
        with zipfile.ZipFile(zip_path) as archive:
            members = list(_validated_members(archive))
            for info in members:
                target = (stage / info.filename).resolve()
                if stage.resolve() not in target.parents and target != stage.resolve():
                    raise PluginInstallError("ZIP 解压路径越界")
                archive.extract(info, stage)
        root = _find_plugin_root(stage)
        raw = json.loads((root / "plugin.json").read_text(encoding="utf-8-sig"))
        plugin_id = str(raw.get("id") or root.name).strip()
        if not PLUGIN_ID_RE.fullmatch(plugin_id):
            raise PluginInstallError("插件 ID 无效")
        # Full path/entry validation runs after the staged folder is normalized
        # to its immutable plugin ID.
        return root, {**raw, "id": plugin_id}
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def install_or_upgrade(
    zip_path: Path, plugins_root: Path, *, upgrade: bool, expected_id: str | None = None
) -> str:
    plugins_root.mkdir(parents=True, exist_ok=True)
    work_root = plugins_root.parent
    staged_root, manifest = stage_plugin_zip(zip_path, work_root)
    plugin_id = manifest["id"]
    if expected_id is not None and plugin_id != expected_id:
        stage_parent = staged_root.parent
        if stage_parent.name.startswith("plugin-stage-"):
            shutil.rmtree(stage_parent, ignore_errors=True)
        raise PluginInstallError(f"升级包 ID 为 {plugin_id}，与目标插件 {expected_id} 不一致")
    target = plugins_root / plugin_id
    raw = json.loads((staged_root / "plugin.json").read_text(encoding="utf-8-sig"))
    # A ZIP may place plugin.json directly at archive root or inside one
    # top-level folder. The final atomic destination always supplies the
    # immutable ID directory name, so staging itself need not be renamed.
    manifest, _, _ = normalize_manifest(raw, staged_root, enforce_directory_id=False)
    backup = plugins_root.parent / f".plugin-backup-{plugin_id}"
    try:
        if target.exists() and not upgrade:
            raise PluginInstallError(f"插件 {plugin_id} 已存在，请使用升级")
        if not target.exists() and upgrade:
            raise PluginInstallError(f"插件 {plugin_id} 尚未安装")
        if target.exists():
            if backup.exists():
                raise PluginInstallError("上一次升级仍在等待重启验证，请先重启大雄画布")
            os.replace(target, backup)
        try:
            os.replace(staged_root, target)
        except Exception:
            if backup.exists() and not target.exists():
                os.replace(backup, target)
            raise
        # Keep an upgrade backup until a fresh host process imports and
        # registers the new backend successfully. PluginHost removes it after
        # validation or restores it when startup fails.
        return plugin_id
    finally:
        stage_parent = staged_root.parent
        if stage_parent.name.startswith("plugin-stage-"):
            shutil.rmtree(stage_parent, ignore_errors=True)
        if backup.exists() and not target.exists():
            os.replace(backup, target)


def uninstall_plugin(plugin_root: Path, data_root: Path, *, delete_data: bool) -> None:
    if plugin_root.is_dir():
        shutil.rmtree(plugin_root)
    if delete_data and data_root.is_dir():
        shutil.rmtree(data_root)
