from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class PluginRecord:
    plugin_id: str
    name: str
    version: str
    root: Path
    manifest: Dict[str, Any]
    schema_version: int = 1
    description: str = ""
    author: str = ""
    icon: str = ""
    installed: bool = True
    manifest_valid: bool = True
    compatible: bool = True
    enabled: bool = False
    backend_registered: bool = False
    frontend_active: bool = False
    health: str = "unknown"
    error_code: str = ""
    error_message: str = ""
    compatibility_reason: str = ""
    refresh_required: bool = False
    restart_required: bool = False
    legacy_manifest: bool = False
    plugin_object: Optional[Any] = field(default=None, repr=False)

    @property
    def loaded(self) -> bool:
        return self.backend_registered and self.compatible and not self.error_message

    @property
    def reason(self) -> str:
        return self.compatibility_reason

    @property
    def error(self) -> str:
        return self.error_message

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.plugin_id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "icon": f"/plugins/{self.plugin_id}/{self.icon}" if self.icon else "",
            "schema_version": self.schema_version,
            "legacy_manifest": self.legacy_manifest,
            "installed": self.installed,
            "manifest_valid": self.manifest_valid,
            "compatible": self.compatible,
            "enabled": self.enabled,
            "backend_registered": self.backend_registered,
            "frontend_active": self.frontend_active,
            "health": self.health,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "reason": self.compatibility_reason,
            "refresh_required": self.refresh_required,
            "restart_required": self.restart_required,
            # Compatibility fields consumed by the v1 diagnostics/tests.
            "loaded": self.loaded,
            "error": self.error_message,
        }
