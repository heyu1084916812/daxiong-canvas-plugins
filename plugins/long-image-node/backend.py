from __future__ import annotations

import asyncio
import os
import re
import threading
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field

from long_image_ops import (
    LongImageValidationError,
    SourceChangedError,
    compose_long_image,
    inspect_source,
)


class ComposeItem(BaseModel):
    item_id: str = ""
    url: str
    expected_fingerprint: str = ""


class ComposeRequest(BaseModel):
    node_id: str = ""
    request_id: str = ""
    revision: int = Field(default=1, ge=1)
    target_width_mode: str = "min-source"
    target_width: int | None = None
    allow_upscale: bool = False
    items: List[ComposeItem] = Field(min_length=2, max_length=100)


def _env_int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _safe_node_fragment(node_id: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(node_id or "long_image"))
    return value[:48] or "long_image"


class LongImagePlugin:
    DATA_VERSION = 1

    def __init__(self, host):
        self.host = host
        self.enabled = False
        self._source_cache = {}
        self._source_cache_lock = threading.Lock()

    def _inspect_source_cached(
        self,
        item_id: str,
        path: Path,
        expected_fingerprint: str,
        max_source_pixels: int,
    ):
        stat = path.stat()
        cache_key = (
            str(path.resolve()),
            int(stat.st_size),
            int(stat.st_mtime_ns),
            int(max_source_pixels),
        )
        with self._source_cache_lock:
            cached = self._source_cache.get(cache_key)
        if cached is not None:
            expected = str(expected_fingerprint or "").strip().lower()
            if expected and cached.fingerprint.lower() != expected:
                raise SourceChangedError(f"来源图片已变化：{path.name}")
            return replace(cached, item_id=str(item_id or ""))

        inspected = inspect_source(
            item_id,
            path,
            expected_fingerprint,
            max_source_pixels=max_source_pixels,
        )
        after = path.stat()
        if int(after.st_size) == int(stat.st_size) and int(after.st_mtime_ns) == int(stat.st_mtime_ns):
            with self._source_cache_lock:
                if len(self._source_cache) >= 512:
                    self._source_cache.clear()
                self._source_cache[cache_key] = inspected
        return inspected

    def register(self, app: FastAPI) -> None:
        router = APIRouter(prefix="/api/plugins/long-image-node", tags=["long-image-node"])

        @router.post("/compose")
        async def compose(payload: ComposeRequest):
            source_paths = []
            for item in payload.items:
                url = str(item.url or "").strip()
                if not (url.startswith("/assets/") or url.startswith("/output/")):
                    raise HTTPException(
                        status_code=400,
                        detail="仅支持项目内已管理的 /assets/ 或 /output/ 图片",
                    )
                path_value = self.host.images["resolveProjectImage"](url)
                path = Path(path_value) if path_value else None
                if not path or not path.is_file():
                    raise HTTPException(status_code=400, detail="图片地址无效、越界或文件不存在")
                source_paths.append((item, path))

            max_source_pixels = _env_int(
                "LONG_IMAGE_MAX_SOURCE_PIXELS", 100_000_000, 1_000_000
            )
            inspect_limit = asyncio.Semaphore(4)

            async def inspect_item(item, path):
                async with inspect_limit:
                    return await asyncio.to_thread(
                        self._inspect_source_cached,
                        item.item_id,
                        path,
                        item.expected_fingerprint,
                        max_source_pixels,
                    )

            try:
                resolved = await asyncio.gather(
                    *(inspect_item(item, path) for item, path in source_paths)
                )
            except SourceChangedError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except LongImageValidationError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            filename = (
                f"long_image_{_safe_node_fragment(payload.node_id)}_r{payload.revision}_"
                f"{uuid.uuid4().hex[:10]}.png"
            )
            final_path = Path(self.host.images["outputPathFor"](filename, "output"))
            part_path = final_path.with_name(final_path.name + f".{uuid.uuid4().hex}.part")
            try:
                width, height, digest = await asyncio.to_thread(
                    compose_long_image,
                    resolved,
                    part_path,
                    target_width_mode=payload.target_width_mode,
                    target_width=payload.target_width,
                    allow_upscale=payload.allow_upscale,
                    max_height=_env_int("LONG_IMAGE_MAX_HEIGHT", 100_000, 1024),
                    max_output_pixels=_env_int(
                        "LONG_IMAGE_MAX_OUTPUT_PIXELS", 120_000_000, 1_000_000
                    ),
                )
                with part_path.open("r+b") as stream:
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(part_path, final_path)
                stat = final_path.stat()
                return {
                    "request_id": payload.request_id,
                    "revision": payload.revision,
                    "render_key": digest,
                    "file": {
                        "url": self.host.images["outputUrlFor"](filename, "output"),
                        "name": filename,
                        "kind": "image",
                        "natural_w": width,
                        "natural_h": height,
                        "size": stat.st_size,
                        "longImageComposite": True,
                    },
                    "items": [
                        {
                            "item_id": source.item_id,
                            "natural_w": source.width,
                            "natural_h": source.height,
                            "fingerprint": source.fingerprint,
                            "format": source.format,
                        }
                        for source in resolved
                    ],
                }
            except LongImageValidationError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"长图拼接失败：{exc}") from exc
            finally:
                part_path.unlink(missing_ok=True)

        app.include_router(router)

    def on_enable(self) -> None:
        metadata = self.host.storage.read("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        current = int(metadata.get("data_version") or 0)
        if current > self.DATA_VERSION:
            raise RuntimeError(
                f"插件数据版本 {current} 高于当前支持版本 {self.DATA_VERSION}"
            )
        if current != self.DATA_VERSION:
            metadata.update(
                {
                    "schema_version": 1,
                    "data_version": self.DATA_VERSION,
                    "plugin_id": self.host.plugin_id,
                }
            )
            self.host.storage.write("metadata", metadata)
        self.enabled = True

    def on_disable(self) -> None:
        self.enabled = False

    def health_check(self) -> Dict[str, Any]:
        required = [
            "web/long-image-core.js",
            "web/long-image-classic.js",
            "web/long-image-smart.js",
            "web/long-image.css",
        ]
        missing = [name for name in required if not (self.host.root / name).is_file()]
        output_parent = Path(
            self.host.images["outputPathFor"](".long-image-health", "output")
        ).parent
        writable = output_parent.is_dir() and os.access(output_parent, os.W_OK)
        if not self.enabled:
            status = "disabled"
        else:
            status = "healthy" if not missing and writable else "error"
        return {
            "status": status,
            "backend_entry": True,
            "data_version": self.DATA_VERSION,
            "core_version": self.host.core_version,
            "adapter_baseline": "core-2026.08.04",
            "missing_assets": missing,
            "output_writable": writable,
            "capabilities": sorted(self.host.capabilities),
        }


def create_plugin(host) -> LongImagePlugin:
    return LongImagePlugin(host)
