from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


PLUGIN_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
EXCLUDED_NAMES = {
    ".git",
    ".github",
    "__pycache__",
    "tests",
    "tests-js",
    "plugin-data",
    "data",
    "output",
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp"}


def included_files(root: Path):
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED_NAMES for part in relative.parts):
            continue
        if path.suffix.lower() in EXCLUDED_SUFFIXES:
            continue
        yield path, relative


def build_plugin(plugin_root: Path, output: Path, repository: str) -> dict:
    manifest_path = plugin_root / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    plugin_id = str(manifest.get("id") or "").strip()
    version = str(manifest.get("version") or "").strip()
    if not PLUGIN_ID_RE.fullmatch(plugin_id) or plugin_root.name != plugin_id:
        raise ValueError(f"插件目录或 ID 无效：{plugin_root}")
    if not VERSION_RE.fullmatch(version):
        raise ValueError(f"插件 {plugin_id} 必须使用 x.y.z 版本号")
    files = list(included_files(plugin_root))
    if not files:
        raise ValueError(f"插件 {plugin_id} 没有可发布文件")
    filename = f"{plugin_id}-v{version}.zip"
    archive_path = output / filename
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, relative in files:
            name = PurePosixPath(plugin_id, *relative.parts).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    payload = archive_path.read_bytes()
    tag = f"{plugin_id}-v{version}"
    return {
        "id": plugin_id,
        "name": str(manifest.get("name") or plugin_id),
        "description": str(manifest.get("description") or ""),
        "author": str(manifest.get("author") or ""),
        "version": version,
        "min_core_version": manifest.get("min_core_version"),
        "max_core_version": manifest.get("max_core_version"),
        "requires_capabilities": list(manifest.get("requires_capabilities") or []),
        "download_url": f"https://github.com/{repository}/releases/download/{tag}/{filename}",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "size": len(payload),
        "published_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "changelog": list(manifest.get("release_notes") or []),
        "tag": tag,
        "asset": filename,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugins", default="plugins")
    parser.add_argument("--output", default="build/releases")
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    plugins_root = Path(args.plugins).resolve()
    output = Path(args.output).resolve()
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    entries = []
    for root in sorted(path for path in plugins_root.iterdir() if path.is_dir()):
        if (root / "plugin.json").is_file():
            entries.append(build_plugin(root, output, args.repository))
    if not entries:
        raise SystemExit("没有发现可发布插件")
    public_entries = [
        {key: value for key, value in entry.items() if key not in {"tag", "asset"}}
        for entry in entries
    ]
    catalog = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "plugins": public_entries,
    }
    (output / "plugins-index.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output / "release-manifest.json").write_text(
        json.dumps({"plugins": entries}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"built {len(entries)} plugins in {output}")


if __name__ == "__main__":
    main()
