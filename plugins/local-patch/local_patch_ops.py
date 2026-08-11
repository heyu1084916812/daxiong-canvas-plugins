from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat


class LocalPatchError(ValueError):
    """Base error for local patch operations."""


class LocalPatchValidationError(LocalPatchError):
    """The request cannot be processed safely."""


class SourceChangedError(LocalPatchError):
    """The original image no longer matches the stored crop context."""


def _int(value: Any, name: str) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError) as exc:
        raise LocalPatchValidationError(f"{name} 必须是整数") from exc


def _rect(value: Mapping[str, Any], name: str = "选区") -> Dict[str, int]:
    if not isinstance(value, Mapping):
        raise LocalPatchValidationError(f"{name}无效")
    return {key: _int(value.get(key), f"{name}.{key}") for key in ("x", "y", "w", "h")}


def file_fingerprint(path: os.PathLike[str] | str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_oriented_rgba(path: os.PathLike[str] | str, max_pixels: int = 100_000_000) -> Image.Image:
    try:
        with Image.open(path) as source:
            width, height = source.size
            if width <= 0 or height <= 0:
                raise LocalPatchValidationError("图片尺寸无效")
            if width * height > max_pixels:
                raise LocalPatchValidationError(f"图片超过最大解码像素数 {max_pixels}")
            return ImageOps.exif_transpose(source).convert("RGBA")
    except LocalPatchError:
        raise
    except Exception as exc:
        raise LocalPatchValidationError(f"图片无法解码：{exc}") from exc


def compute_padded_rect(
    rect_value: Mapping[str, Any], image_size: Tuple[int, int], padding_ratio: float = 0.1
) -> Dict[str, int]:
    rect = _rect(rect_value)
    image_width, image_height = map(int, image_size)
    try:
        ratio = float(padding_ratio)
    except (TypeError, ValueError) as exc:
        raise LocalPatchValidationError("padding_ratio 无效") from exc
    if not 0 <= ratio <= 0.5:
        raise LocalPatchValidationError("padding_ratio 必须位于 0 到 0.5")
    if rect["w"] <= 0 or rect["h"] <= 0:
        raise LocalPatchValidationError("选区尺寸无效")
    if rect["x"] < 0 or rect["y"] < 0 or rect["x"] + rect["w"] > image_width or rect["y"] + rect["h"] > image_height:
        raise LocalPatchValidationError("选区越界")
    pad_x = round(rect["w"] * ratio)
    pad_y = round(rect["h"] * ratio)
    left = max(0, rect["x"] - pad_x)
    top = max(0, rect["y"] - pad_y)
    right = min(image_width, rect["x"] + rect["w"] + pad_x)
    bottom = min(image_height, rect["y"] + rect["h"] + pad_y)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def crop_local_patch(
    source_path: os.PathLike[str] | str,
    selection_value: Mapping[str, Any],
    padding_ratio: float,
    crop_node_id: str,
    max_pixels: int = 100_000_000,
) -> Tuple[Image.Image, Dict[str, Any]]:
    source = load_oriented_rgba(source_path, max_pixels=max_pixels)
    selection = _rect(selection_value)
    if selection["w"] < 32 or selection["h"] < 32:
        raise LocalPatchValidationError("选区宽高均不得小于 32 像素")
    client_width = _int(selection_value.get("source_width"), "source_width")
    client_height = _int(selection_value.get("source_height"), "source_height")
    if (client_width, client_height) != source.size:
        raise SourceChangedError("原图尺寸已变化，请重新框选")
    padded = compute_padded_rect(selection, source.size, padding_ratio)
    cropped = source.crop((padded["x"], padded["y"], padded["x"] + padded["w"], padded["y"] + padded["h"]))
    context = {
        "version": 2,
        "contextId": uuid.uuid4().hex,
        "source": {
            "url": "",
            "width": source.width,
            "height": source.height,
            "fingerprint": file_fingerprint(source_path),
        },
        "rect": selection,
        "paddedRect": padded,
        "paddingRatio": float(padding_ratio),
    }
    if crop_node_id:
        context["cropNodeId"] = str(crop_node_id)
    return cropped, context


def validate_crop_context(context: Mapping[str, Any]) -> Tuple[Dict[str, int], Dict[str, int], Mapping[str, Any]]:
    if not isinstance(context, Mapping) or context.get("version") not in (1, 2):
        raise LocalPatchValidationError("cropContext 版本无效")
    source = context.get("source")
    if not isinstance(source, Mapping) or not source.get("fingerprint"):
        raise LocalPatchValidationError("cropContext 缺少来源信息")
    rect = _rect(context.get("rect"), "rect")
    padded = _rect(context.get("paddedRect"), "paddedRect")
    if rect["x"] < padded["x"] or rect["y"] < padded["y"]:
        raise LocalPatchValidationError("rect 不在 paddedRect 内")
    if rect["x"] + rect["w"] > padded["x"] + padded["w"] or rect["y"] + rect["h"] > padded["y"] + padded["h"]:
        raise LocalPatchValidationError("rect 不在 paddedRect 内")
    return rect, padded, source


def build_feather_mask(rect_value: Mapping[str, Any], padded_value: Mapping[str, Any]) -> Image.Image:
    rect = _rect(rect_value, "rect")
    padded = _rect(padded_value, "paddedRect")
    width, height = padded["w"], padded["h"]
    if width <= 0 or height <= 0:
        raise LocalPatchValidationError("paddedRect 尺寸无效")
    inner_left = rect["x"] - padded["x"]
    inner_top = rect["y"] - padded["y"]
    inner_right = inner_left + rect["w"]
    inner_bottom = inner_top + rect["h"]
    pixels = bytearray(width * height)

    def smoothstep(value: float) -> float:
        value = max(0.0, min(1.0, value))
        return value * value * (3.0 - 2.0 * value)

    for y in range(height):
        if y < inner_top:
            wy = y / max(1, inner_top)
        elif y >= inner_bottom:
            wy = (height - 1 - y) / max(1, height - inner_bottom)
        else:
            wy = 1.0
        for x in range(width):
            if x < inner_left:
                wx = x / max(1, inner_left)
            elif x >= inner_right:
                wx = (width - 1 - x) / max(1, width - inner_right)
            else:
                wx = 1.0
            pixels[y * width + x] = round(255 * smoothstep(min(wx, wy)))
    mask = Image.frombytes("L", (width, height), bytes(pixels)).filter(ImageFilter.GaussianBlur(0.8))
    if inner_right > inner_left and inner_bottom > inner_top:
        mask.paste(255, (inner_left, inner_top, inner_right, inner_bottom))
    return mask


def _ring_mask(rect: Dict[str, int], padded: Dict[str, int]) -> Image.Image:
    mask = Image.new("L", (padded["w"], padded["h"]), 255)
    left = rect["x"] - padded["x"]
    top = rect["y"] - padded["y"]
    mask.paste(0, (left, top, left + rect["w"], top + rect["h"]))
    return mask


def _apply_limited_color_match(original_patch: Image.Image, patch: Image.Image, ring: Image.Image) -> Image.Image:
    if not ring.getbbox():
        return patch
    original_stat = ImageStat.Stat(original_patch.convert("RGB"), ring)
    patch_stat = ImageStat.Stat(patch.convert("RGB"), ring)
    offsets = [max(-24, min(24, round(a - b))) for a, b in zip(original_stat.mean, patch_stat.mean)]
    red, green, blue, alpha = patch.convert("RGBA").split()
    channels = []
    for channel, offset in zip((red, green, blue), offsets):
        channels.append(channel.point(lambda value, delta=offset: max(0, min(255, value + delta))))
    return Image.merge("RGBA", (*channels, alpha))


def merge_local_patch(
    original_path: os.PathLike[str] | str,
    patch_path: os.PathLike[str] | str,
    crop_context: Mapping[str, Any],
    color_match: bool = True,
    feather_mode: str = "smoothstep",
    max_pixels: int = 100_000_000,
) -> Tuple[Image.Image, list[str]]:
    if feather_mode != "smoothstep":
        raise LocalPatchValidationError("仅支持 smoothstep 羽化")
    rect, padded, source_meta = validate_crop_context(crop_context)
    original = load_oriented_rgba(original_path, max_pixels=max_pixels)
    if original.size != (_int(source_meta.get("width"), "source.width"), _int(source_meta.get("height"), "source.height")):
        raise SourceChangedError("原图尺寸与裁剪来源不一致")
    if file_fingerprint(original_path) != source_meta.get("fingerprint"):
        raise SourceChangedError("原图指纹与裁剪来源不一致")
    if padded["x"] < 0 or padded["y"] < 0 or padded["x"] + padded["w"] > original.width or padded["y"] + padded["h"] > original.height:
        raise LocalPatchValidationError("paddedRect 超出原图边界")
    patch = load_oriented_rgba(patch_path, max_pixels=max_pixels)
    target_ratio = padded["w"] / padded["h"]
    patch_ratio = patch.width / patch.height
    if abs(patch_ratio / target_ratio - 1.0) > 0.01:
        raise LocalPatchValidationError("局部图宽高比已改变，无法安全还原")
    patch = patch.resize((padded["w"], padded["h"]), Image.Resampling.LANCZOS)
    original_patch = original.crop((padded["x"], padded["y"], padded["x"] + padded["w"], padded["y"] + padded["h"]))
    ring = _ring_mask(rect, padded)
    if color_match:
        patch = _apply_limited_color_match(original_patch, patch, ring)
    feather = build_feather_mask(rect, padded)
    patch_alpha = ImageChops.multiply(patch.getchannel("A"), feather)
    patch.putalpha(patch_alpha)
    result = original.copy()
    result.alpha_composite(patch, (padded["x"], padded["y"]))
    return result, []


def merge_local_patches(
    original_path: os.PathLike[str] | str,
    patches: Sequence[Tuple[os.PathLike[str] | str, Mapping[str, Any]]],
    color_match: bool = True,
    feather_mode: str = "smoothstep",
    max_pixels: int = 100_000_000,
) -> Tuple[Image.Image, list[str]]:
    """Merge several independently cropped patches onto one original image."""
    if feather_mode != "smoothstep":
        raise LocalPatchValidationError("仅支持 smoothstep 羽化")
    if not patches:
        raise LocalPatchValidationError("至少需要一张局部修改图")
    original = load_oriented_rgba(original_path, max_pixels=max_pixels)
    original_fingerprint = file_fingerprint(original_path)
    result = original.copy()
    for index, (patch_path, crop_context) in enumerate(patches, start=1):
        try:
            rect, padded, source_meta = validate_crop_context(crop_context)
            expected_size = (
                _int(source_meta.get("width"), "source.width"),
                _int(source_meta.get("height"), "source.height"),
            )
            if original.size != expected_size:
                raise SourceChangedError("原图尺寸与裁剪来源不一致")
            if original_fingerprint != source_meta.get("fingerprint"):
                raise SourceChangedError("原图指纹与裁剪来源不一致")
            if padded["x"] < 0 or padded["y"] < 0 or padded["x"] + padded["w"] > original.width or padded["y"] + padded["h"] > original.height:
                raise LocalPatchValidationError("paddedRect 超出原图边界")
            patch = load_oriented_rgba(patch_path, max_pixels=max_pixels)
            target_ratio = padded["w"] / padded["h"]
            patch_ratio = patch.width / patch.height
            if abs(patch_ratio / target_ratio - 1.0) > 0.01:
                raise LocalPatchValidationError("局部图宽高比已改变，无法安全还原")
            patch = patch.resize((padded["w"], padded["h"]), Image.Resampling.LANCZOS)
            current_patch = result.crop((padded["x"], padded["y"], padded["x"] + padded["w"], padded["y"] + padded["h"]))
            ring = _ring_mask(rect, padded)
            if color_match:
                patch = _apply_limited_color_match(current_patch, patch, ring)
            feather = build_feather_mask(rect, padded)
            patch.putalpha(ImageChops.multiply(patch.getchannel("A"), feather))
            result.alpha_composite(patch, (padded["x"], padded["y"]))
        except (LocalPatchValidationError, SourceChangedError) as exc:
            exc.args = (f"第 {index} 张局部图：{exc}",)
            raise
    return result, []
