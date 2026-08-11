from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Optional


class PluginStateStore:
    """Host-owned plugin enablement state with atomic persistence."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = RLock()
        self._state: Dict[str, Any] = {"schema_version": 1, "plugins": {}}
        self.reload()

    def reload(self) -> None:
        with self._lock:
            if not self.path.is_file():
                return
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(value, dict) and isinstance(value.get("plugins"), dict):
                    self._state = value
            except (OSError, ValueError):
                # A damaged state file must not prevent the core from starting.
                self._state = {"schema_version": 1, "plugins": {}}

    def enabled(self, plugin_id: str, initial: Optional[bool] = None) -> bool:
        with self._lock:
            item = self._state["plugins"].get(plugin_id)
            if isinstance(item, dict) and "enabled" in item:
                return bool(item["enabled"])
            return bool(initial) if initial is not None else False

    def has(self, plugin_id: str) -> bool:
        with self._lock:
            return plugin_id in self._state["plugins"]

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        with self._lock:
            current = dict(self._state["plugins"].get(plugin_id) or {})
            current["enabled"] = bool(enabled)
            self._state["plugins"][plugin_id] = current
            self._write_atomic()

    def remove(self, plugin_id: str) -> None:
        with self._lock:
            self._state["plugins"].pop(plugin_id, None)
            self._write_atomic()

    def _write_atomic(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(prefix="plugin-state-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(self._state, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.path)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
