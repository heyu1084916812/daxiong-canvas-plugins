from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field

from local_patch_ops import (
    LocalPatchValidationError,
    SourceChangedError,
    crop_local_patch,
    file_fingerprint,
    merge_local_patches,
)


class SelectionRequest(BaseModel):
    x: int
    y: int
    w: int
    h: int
    source_width: int
    source_height: int


class CropRequest(BaseModel):
    source_url: str
    selection: SelectionRequest
    padding_ratio: float = Field(default=0.1, ge=0.0, le=0.5)
    crop_node_id: str = ""


class MergePatchRequest(BaseModel):
    patch_url: str
    crop_context: Dict[str, Any]


class MergeRequest(BaseModel):
    original_url: str
    patch_url: Optional[str] = None
    crop_context: Optional[Dict[str, Any]] = None
    patches: Optional[List[MergePatchRequest]] = None
    color_match: bool = True
    feather_mode: str = "smoothstep"


class FingerprintRequest(BaseModel):
    source_url: str


def _max_pixels() -> int:
    try:
        return max(1_000_000, int(os.getenv("LOCAL_PATCH_MAX_PIXELS", "100000000")))
    except ValueError:
        return 100_000_000


def register(app: FastAPI, context: Dict[str, Any]) -> None:
    resolve_asset_url = context["resolve_asset_url"]
    output_path_for = context["output_path_for"]
    output_url_for = context["output_url_for"]
    router = APIRouter(prefix="/api/plugins/local-patch", tags=["local-patch"])

    def resolve_image(url: str) -> Path:
        text = str(url or "").strip()
        if not (text.startswith("/assets/") or text.startswith("/output/")):
            raise HTTPException(status_code=400, detail="仅支持项目内已导入的 /assets/ 或 /output/ 图片")
        path = resolve_asset_url(text)
        if not path or not Path(path).is_file():
            raise HTTPException(status_code=400, detail="图片地址无效、越界或文件不存在")
        return Path(path)

    def save_png(image, prefix: str) -> Dict[str, Any]:
        filename = f"{prefix}{uuid.uuid4().hex[:12]}.png"
        path = Path(output_path_for(filename, "output"))
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, format="PNG")
        return {
            "url": output_url_for(filename, "output"),
            "name": filename,
            "kind": "image",
            "natural_w": image.width,
            "natural_h": image.height,
        }

    @router.post("/crop")
    async def crop(payload: CropRequest):
        source_path = resolve_image(payload.source_url)
        try:
            image, crop_context = await asyncio.to_thread(
                crop_local_patch,
                source_path,
                payload.selection.model_dump(),
                payload.padding_ratio,
                payload.crop_node_id,
                _max_pixels(),
            )
            crop_context["source"]["url"] = payload.source_url
            item = save_png(image, "local_crop_")
            item["cropContext"] = crop_context
            return {"file": item}
        except SourceChangedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except LocalPatchValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"局部裁剪失败：{exc}") from exc

    @router.post("/merge")
    async def merge(payload: MergeRequest):
        original_path = resolve_image(payload.original_url)
        try:
            patch_specs = list(payload.patches or [])
            if not patch_specs and payload.patch_url and payload.crop_context:
                patch_specs = [MergePatchRequest(patch_url=payload.patch_url, crop_context=payload.crop_context)]
            if not patch_specs:
                raise LocalPatchValidationError("至少需要一张局部修改图")
            if len(patch_specs) > 16:
                raise LocalPatchValidationError("一次最多融合 16 张局部修改图")
            resolved_patches = [(resolve_image(item.patch_url), item.crop_context) for item in patch_specs]
            image, warnings = await asyncio.to_thread(
                merge_local_patches,
                original_path,
                resolved_patches,
                payload.color_match,
                payload.feather_mode,
                _max_pixels(),
            )
            item = save_png(image, "local_merge_")
            item["localPatchFullImage"] = True
            item["localPatchContextReset"] = True
            return {"file": item, "warnings": warnings}
        except SourceChangedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except LocalPatchValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"无缝拼接失败：{exc}") from exc

    @router.post("/fingerprint")
    async def fingerprint(payload: FingerprintRequest):
        source_path = resolve_image(payload.source_url)
        try:
            digest = await asyncio.to_thread(file_fingerprint, source_path)
            return {"fingerprint": digest, "size": source_path.stat().st_size}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"文件指纹计算失败：{exc}") from exc

    app.include_router(router)


class LocalPatchPlugin:
    """Schema-v2 lifecycle wrapper around the stable v2.6 backend behavior."""

    DATA_VERSION = 1

    def __init__(self, host):
        self.host = host
        self.enabled = False

    def register(self, app: FastAPI) -> None:
        images = self.host.images
        register(app, {
            "core_version": self.host.core_version,
            "plugin": self.host.record,
            "plugin_data_dir": self.host.data_root,
            "resolve_asset_url": images["resolveProjectImage"],
            "output_path_for": images["outputPathFor"],
            "output_url_for": images["outputUrlFor"],
        })

    def on_enable(self) -> None:
        self.migrate_data()
        self.enabled = True

    def on_disable(self) -> None:
        self.enabled = False

    def migrate_data(self) -> None:
        """Idempotently record the plugin-owned data format without touching canvas data."""
        metadata = self.host.storage.read("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        current = int(metadata.get("data_version") or 0)
        if current > self.DATA_VERSION:
            raise RuntimeError(
                f"插件数据版本 {current} 高于当前插件支持的版本 {self.DATA_VERSION}"
            )
        if current != self.DATA_VERSION:
            metadata.update({
                "schema_version": 1,
                "data_version": self.DATA_VERSION,
                "plugin_id": self.host.plugin_id,
            })
            self.host.storage.write("metadata", metadata)

    def health_check(self) -> Dict[str, Any]:
        required_assets = [
            "web/local-patch-core.js", "web/local-patch.js", "web/local-patch.css",
            "web/local-patch-classic.js", "web/local-patch-classic.css",
        ]
        missing = [name for name in required_assets if not (self.host.root / name).is_file()]
        output_probe = Path(self.host.images["outputPathFor"](".local-patch-health", "output")).parent
        writable = output_probe.is_dir() and os.access(output_probe, os.W_OK)
        return {
            "status": "healthy" if not missing and writable else "error",
            "backend_entry": True,
            "data_version": self.DATA_VERSION,
            "missing_assets": missing,
            "output_writable": writable,
            "capabilities": sorted(self.host.capabilities),
        }


def create_plugin(host) -> LocalPatchPlugin:
    return LocalPatchPlugin(host)
