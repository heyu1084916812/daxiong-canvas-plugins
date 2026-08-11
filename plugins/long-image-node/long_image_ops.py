from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image, ImageOps, UnidentifiedImageError


class LongImageValidationError(ValueError):
    pass


class SourceChangedError(LongImageValidationError):
    pass


@dataclass(frozen=True)
class SourceInfo:
    item_id: str
    path: Path
    width: int
    height: int
    fingerprint: str
    has_alpha: bool
    format: str


ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}


def file_fingerprint(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)


def inspect_source(
    item_id: str,
    path: Path,
    expected_fingerprint: str = "",
    *,
    max_source_pixels: int = 100_000_000,
) -> SourceInfo:
    try:
        with Image.open(path) as raw:
            image_format = str(raw.format or "").upper()
            if image_format not in ALLOWED_FORMATS:
                raise LongImageValidationError(f"不支持的图片格式：{image_format or path.suffix}")
            if int(getattr(raw, "n_frames", 1) or 1) != 1:
                raise LongImageValidationError("暂不支持动画或多帧图片")
            with ImageOps.exif_transpose(raw) as oriented:
                width, height = map(int, oriented.size)
                alpha = _has_alpha(oriented)
    except LongImageValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise LongImageValidationError(f"图片无法解码：{path.name}") from exc
    if width <= 0 or height <= 0:
        raise LongImageValidationError(f"图片尺寸无效：{path.name}")
    if width * height > max_source_pixels:
        raise LongImageValidationError(
            f"来源图片像素超过限制：{path.name}（{width}×{height}）"
        )
    fingerprint = file_fingerprint(path)
    expected = str(expected_fingerprint or "").strip().lower()
    if expected and fingerprint.lower() != expected:
        raise SourceChangedError(f"来源图片已变化：{path.name}")
    return SourceInfo(
        item_id=str(item_id or ""),
        path=path,
        width=width,
        height=height,
        fingerprint=fingerprint,
        has_alpha=alpha,
        format=image_format.lower(),
    )


def calculate_layout(
    sources: Sequence[SourceInfo],
    target_width_mode: str = "min-source",
    target_width: int | None = None,
    allow_upscale: bool = False,
    *,
    min_width: int = 64,
    max_width: int = 8192,
    max_height: int = 100_000,
    max_output_pixels: int = 120_000_000,
) -> tuple[int, list[int]]:
    if len(sources) < 2:
        raise LongImageValidationError("至少需要 2 张有效图片")
    if len(sources) > 100:
        raise LongImageValidationError("单个长图最多包含 100 张图片")
    mode = str(target_width_mode or "min-source").strip().lower()
    if mode not in {"min-source", "custom"}:
        raise LongImageValidationError("未知的统一宽度模式")
    if mode == "min-source":
        width = min(source.width for source in sources)
    else:
        try:
            width = int(target_width or 0)
        except (TypeError, ValueError) as exc:
            raise LongImageValidationError("自定义宽度必须是整数") from exc
    if width < min_width or width > max_width:
        raise LongImageValidationError(f"输出宽度必须在 {min_width}～{max_width} 像素之间")
    upscale_count = sum(1 for source in sources if width > source.width)
    if upscale_count and not allow_upscale:
        raise LongImageValidationError(
            f"目标宽度会放大 {upscale_count} 张图片，请降低宽度或明确允许放大"
        )
    heights = [max(1, int(math.floor(source.height * width / source.width + 0.5))) for source in sources]
    total_height = sum(heights)
    if total_height > max_height or width * total_height > max_output_pixels:
        ratios = sum(source.height / source.width for source in sources)
        max_by_height = int(max_height / ratios) if ratios else width
        max_by_pixels = int(math.sqrt(max_output_pixels / ratios)) if ratios else width
        suggested = max(min_width, min(width, max_by_height, max_by_pixels, max_width))
        raise LongImageValidationError(
            f"输出尺寸 {width}×{total_height} 超过限制，建议把宽度降到 {suggested} 像素或更低"
        )
    return width, heights


def render_key(sources: Iterable[SourceInfo], width: int, allow_upscale: bool) -> str:
    payload = {
        "format": "png",
        "target_width": int(width),
        "allow_upscale": bool(allow_upscale),
        "sources": [source.fingerprint for source in sources],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def compose_long_image(
    sources: Sequence[SourceInfo],
    output_path: Path,
    *,
    target_width_mode: str = "min-source",
    target_width: int | None = None,
    allow_upscale: bool = False,
    max_height: int = 100_000,
    max_output_pixels: int = 120_000_000,
) -> tuple[int, int, str]:
    width, heights = calculate_layout(
        sources,
        target_width_mode,
        target_width,
        allow_upscale,
        max_height=max_height,
        max_output_pixels=max_output_pixels,
    )
    height = sum(heights)
    output_mode = "RGBA" if any(source.has_alpha for source in sources) else "RGB"
    background = (0, 0, 0, 0) if output_mode == "RGBA" else (255, 255, 255)
    canvas = Image.new(output_mode, (width, height), background)
    y = 0
    try:
        for source, item_height in zip(sources, heights):
            with Image.open(source.path) as raw:
                with ImageOps.exif_transpose(raw) as oriented:
                    image = oriented.convert(output_mode)
                    if image.size != (width, item_height):
                        resized = image.resize(
                            (width, item_height),
                            Image.Resampling.LANCZOS,
                            reducing_gap=3.0,
                        )
                        image.close()
                        image = resized
                    try:
                        canvas.paste(image, (0, y), image if output_mode == "RGBA" else None)
                    finally:
                        image.close()
            y += item_height
        output_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(output_path, format="PNG", optimize=False)
    finally:
        canvas.close()
    return width, height, render_key(sources, width, allow_upscale)
