"""SVG technical preview with hidden-line removal.

Uses OpenCASCADE's HLR algorithm through build123d's
``Shape.project_to_viewport()``: visible edges are drawn solid, hidden edges
dashed. One view per build (``iso`` | ``front`` | ``top`` | ``right``), written
as ``preview.svg`` (see docs/CAD_RUNTIME_PROTOCOL.md §4.4.2).
"""

from __future__ import annotations

import io
import math
import re
from typing import Any

from .errors import export_failed, invalid_argument
from .protocol import PREVIEW_VIEWS

#: Camera direction (``look_from``) and up vector per view.
VIEWS: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {
    "iso": ((1.0, -1.0, 1.0), (0.0, 0.0, 1.0)),
    "front": ((0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    "top": ((0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    "right": ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
}

DEFAULT_WIDTH = 1200
DEFAULT_HEIGHT = 900
MIN_PX = 200
MAX_PX = 4000


def validate_preview(preview: Any) -> dict[str, Any]:
    """Validate/normalise the ``preview`` param of ``model.build``."""
    if preview is None:
        return {"view": "iso", "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT}
    if not isinstance(preview, dict):
        raise invalid_argument("preview must be an object", path="/preview")
    view = preview.get("view", "iso")
    if view not in PREVIEW_VIEWS:
        raise invalid_argument(f"preview.view must be one of {list(PREVIEW_VIEWS)}", path="/preview/view")
    width = preview.get("width", DEFAULT_WIDTH)
    height = preview.get("height", DEFAULT_HEIGHT)
    for name, value in (("width", width), ("height", height)):
        if isinstance(value, bool) or not isinstance(value, int) or not (MIN_PX <= value <= MAX_PX):
            raise invalid_argument(f"preview.{name} must be an integer between {MIN_PX} and {MAX_PX}", path=f"/preview/{name}")
    return {"view": view, "width": int(width), "height": int(height)}


def render_svg(shape: Any, *, view: str = "iso", width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> bytes:
    """Render one hidden-line SVG view of ``shape``."""
    if view not in VIEWS:
        raise invalid_argument(f"unknown preview view {view!r}", path="/preview/view")
    import build123d as B  # noqa: PLC0415 - lazy

    look_from, look_up = VIEWS[view]
    try:
        visible, hidden = shape.project_to_viewport(look_from, viewport_up=look_up, look_at=shape.center())
    except Exception as exc:  # noqa: BLE001 - surface as export failure
        raise export_failed(f"hidden-line projection failed for view {view}: {exc}") from exc

    exporter = B.ExportSVG(unit=B.Unit.MM, scale=1.0, line_weight=0.25)
    exporter.add_layer("visible", line_weight=0.35, line_type=B.LineType.CONTINUOUS)
    exporter.add_layer("hidden", line_weight=0.15, line_type=B.LineType.DASHED)
    if visible:
        exporter.add_shape(visible, layer="visible")
    if hidden:
        exporter.add_shape(hidden, layer="hidden")
    buffer = io.BytesIO()
    try:
        exporter.write(buffer)
    except Exception as exc:  # noqa: BLE001
        raise export_failed(f"SVG export failed for view {view}: {exc}") from exc
    data = buffer.getvalue()
    if not data:
        raise export_failed("SVG exporter returned no data")
    return _with_pixel_size(data, width, height)


def _with_pixel_size(svg: bytes, width: int, height: int) -> bytes:
    """Set the root ``width``/``height`` in px while keeping the mm viewBox."""
    text = svg.decode("utf-8", errors="strict")
    # Replace (or drop) the exporter's own root size attributes, then add ours.
    text = re.sub(r'(<svg\b[^>]*?)\swidth="[^"]*"', r"\1", text, count=1)
    text = re.sub(r'(<svg\b[^>]*?)\sheight="[^"]*"', r"\1", text, count=1)
    text = re.sub(r"(<svg\b)", f'\\1 width="{int(width)}" height="{int(height)}"', text, count=1)
    if 'preserveAspectRatio=' not in text:
        text = re.sub(r"(<svg\b)", '\\1 preserveAspectRatio="xMidYMid meet"', text, count=1)
    return text.encode("utf-8")


def fit_height(shape: Any, width: int) -> int:
    """Derive a preview height from the projected aspect ratio (fallback 900)."""
    if not math.isfinite(float(width)) or width <= 0:
        return DEFAULT_HEIGHT
    try:
        visible, hidden = shape.project_to_viewport(VIEWS["iso"][0], viewport_up=VIEWS["iso"][1], look_at=shape.center())
        edges = list(visible) + list(hidden)
        if not edges:
            return DEFAULT_HEIGHT
        box = edges[0].bounding_box()
        for edge in edges[1:]:
            box = box.add(edge.bounding_box())
        size_x = float(box.size.X)
        size_y = float(box.size.Y)
        if size_x <= 0:
            return DEFAULT_HEIGHT
        height = int(round(width * size_y / size_x))
        return max(MIN_PX, min(MAX_PX, height))
    except Exception:  # noqa: BLE001 - cosmetic only
        return DEFAULT_HEIGHT
