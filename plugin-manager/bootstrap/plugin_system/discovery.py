from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, List

from .compatibility import compatibility_error, normalize_manifest
from .models import PluginRecord
from .state_store import PluginStateStore


def discover_plugins(
    plugins_root: Path | str,
    core_version: str,
    capabilities: Iterable[str] = (),
    state_store: PluginStateStore | None = None,
) -> List[PluginRecord]:
    root = Path(plugins_root)
    if not root.is_dir():
        return []
    records: List[PluginRecord] = []
    for manifest_path in sorted(root.glob("*/plugin.json")):
        plugin_root = manifest_path.parent
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            manifest, schema, legacy = normalize_manifest(raw, plugin_root)
            plugin_id = manifest["id"]
            initial = bool(raw.get("enabled", True)) if schema == 1 else False
            enabled = state_store.enabled(plugin_id, initial) if state_store else initial
            if state_store and not state_store.has(plugin_id):
                # One-time v1/default migration. From this point onward the
                # host state file is the only source of truth.
                state_store.set_enabled(plugin_id, enabled)
            reason = compatibility_error(manifest, core_version, capabilities)
            record = PluginRecord(
                plugin_id=plugin_id,
                name=str(manifest.get("name") or plugin_id),
                description=str(manifest.get("description") or ""),
                version=str(manifest.get("version") or "0.0.0"),
                author=str(manifest.get("author") or ""),
                icon=str(manifest.get("icon") or ""),
                root=plugin_root,
                manifest=manifest,
                schema_version=schema,
                legacy_manifest=legacy,
                enabled=enabled,
                compatible=not reason,
                compatibility_reason=reason,
                restart_required=bool(manifest.get("restart_required", False)),
                health="disabled" if not enabled else "pending",
            )
            records.append(record)
        except Exception as exc:
            records.append(PluginRecord(
                plugin_id=plugin_root.name,
                name=plugin_root.name,
                version="0.0.0",
                root=plugin_root,
                manifest={},
                manifest_valid=False,
                compatible=False,
                enabled=False,
                health="error",
                error_code="MANIFEST_INVALID",
                error_message=str(exc),
            ))
    return records
