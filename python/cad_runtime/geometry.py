"""Declarative geometry engine: build a B-rep from ``dsh.cad/document@1``.

Only the closed feature catalogue from ``docs/research/SPEC_P0.md`` §3.1 runs
here. There is no expression evaluation, no ``eval``/``exec``, no file import and
no network access: every operation is a hard-coded call into build123d/OCCT with
already validated numeric parameters.

The engine is a pure function of ``(document, limits)``: it creates a new shape
from scratch on every call (the host owns revisions), honours a cooperative
cancellation event between features, reports progress, evaluates the eight
geometry checks and assembles the geometry report of SPEC §5.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from .document import AXES, CadDocument, Feature
from .errors import (
    CadRuntimeError,
    build_failed,
    cancelled as cancelled_error,
    invalid_geometry,
)
from .protocol import CHECK_IDS, DEFAULT_LIMITS, ERROR_CODES, REPORT_SCHEMA

ProgressFn = Callable[[str, int, str], None]


def _bd():
    """Import build123d lazily (never at module import time)."""
    import build123d  # noqa: PLC0415 - deliberately lazy (~80 s cold import)

    return build123d


# ---------------------------------------------------------------------------
# Result data
# ---------------------------------------------------------------------------


@dataclass
class FeatureEffect:
    """What a feature was expected to change, measured before/after."""

    feature_id: str
    op: str
    kind: str  # "cylinders" | "faces"
    expected: int
    radius: float | None
    before: int
    after: int
    ok: bool
    detail: str


@dataclass
class MeshData:
    vertices: Any  # numpy.ndarray (n, 3) in CAD coordinates (mm, Z-up)
    faces: Any  # numpy.ndarray (m, 3) welded triangle indices
    watertight: bool  # strict trimesh 2-manifold test
    closed: bool  # no boundary edges (each edge used an even number of times)
    non_manifold_edges: int
    winding_consistent: bool
    volume: float
    tolerance: float
    angular_tolerance: float

    @property
    def vertex_count(self) -> int:
        return int(len(self.vertices))

    @property
    def triangle_count(self) -> int:
        return int(len(self.faces))

    def stats(self) -> dict[str, Any]:
        return {
            "vertices": self.vertex_count,
            "triangles": self.triangle_count,
            "watertight": self.watertight,
            "closed": self.closed,
            "nonManifoldEdges": self.non_manifold_edges,
            "windingConsistent": self.winding_consistent,
            "volume": _round(self.volume),
            "toleranceMm": self.tolerance,
            "angularToleranceRad": self.angular_tolerance,
        }


@dataclass
class BuildOutcome:
    """Everything the caller needs to answer ``model.build``/``model.validate``."""

    shape: Any | None
    report: dict[str, Any]
    checks: list[dict[str, Any]]
    feature_reports: list[dict[str, Any]]
    warnings: list[str]
    error: CadRuntimeError | None
    mesh: MeshData | None
    timings: dict[str, Any]
    limits: dict[str, Any] = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return self.error is None and not any(c["status"] == "fail" for c in self.checks)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _round(value: float, digits: int = 6) -> float:
    if value is None or not math.isfinite(float(value)):
        return 0.0
    rounded = round(float(value), digits)
    return 0.0 if rounded == 0 else rounded  # normalise -0.0


def _vec3(vector: Any) -> list[float]:
    return [_round(float(vector.X)), _round(float(vector.Y)), _round(float(vector.Z))]


def _axis_index(axis: str) -> int:
    return AXES[axis]


def _place(shape: Any, center: Any) -> Any:
    """Move an origin-centred primitive to ``center`` ([x,y] means z=0)."""
    if center is None:
        return shape
    coords = [float(c) for c in center]
    if len(coords) == 2:
        coords.append(0.0)
    elif len(coords) != 3:
        raise invalid_geometry(f"center must have 2 or 3 coordinates, got {len(coords)}")
    B = _bd()
    return shape.move(B.Location(tuple(coords)))


def _rotated_cylinder(radius: float, height: float, axis: str) -> Any:
    B = _bd()
    cylinder = B.Cylinder(radius, height)
    if axis == "x":
        cylinder = cylinder.rotate(B.Axis.Y, 90)
    elif axis == "y":
        cylinder = cylinder.rotate(B.Axis.X, 90)
    elif axis != "z":
        raise invalid_geometry(f"unsupported axis {axis!r}")
    return cylinder


def _primitive_shape(spec: Mapping[str, Any]) -> Any:
    B = _bd()
    if spec["op"] == "box":
        primitive = B.Box(float(spec["length"]), float(spec["width"]), float(spec["height"]))
    elif spec["op"] == "cylinder":
        primitive = _rotated_cylinder(float(spec["diameter"]) / 2.0, float(spec["height"]), spec.get("axis", "z"))
    else:  # pragma: no cover - validation guarantees the catalogue
        raise invalid_geometry(f"unsupported primitive op {spec['op']!r}")
    return _place(primitive, spec.get("center"))


def _bbox(shape: Any) -> Any:
    return shape.bounding_box()


def _bbox_arrays(shape: Any) -> tuple[list[float], list[float], list[float]]:
    box = _bbox(shape)
    return _vec3(box.min), _vec3(box.max), _vec3(box.size)


def _solid_list(shape: Any) -> list[Any]:
    try:
        return list(shape.solids())
    except Exception:  # pragma: no cover - defensive for empty compounds
        return []


def _volume_and_area(shape: Any) -> tuple[float, float]:
    solids = _solid_list(shape)
    volume = 0.0
    area = 0.0
    for solid in solids:
        try:
            volume += float(solid.volume)
        except Exception:  # pragma: no cover - defensive
            pass
        try:
            area += float(solid.area)
        except Exception:  # pragma: no cover - defensive
            pass
    return volume, area


def _centroid(shape: Any) -> list[float]:
    solids = _solid_list(shape)
    if not solids:
        return [0.0, 0.0, 0.0]
    total = 0.0
    acc = [0.0, 0.0, 0.0]
    for solid in solids:
        try:
            volume = float(solid.volume)
            center = solid.center(_bd().CenterOf.MASS)
        except Exception:  # pragma: no cover - defensive
            continue
        if not math.isfinite(volume) or volume <= 0:
            continue
        total += volume
        acc[0] += float(center.X) * volume
        acc[1] += float(center.Y) * volume
        acc[2] += float(center.Z) * volume
    if total <= 0:
        return [0.0, 0.0, 0.0]
    return [_round(acc[0] / total), _round(acc[1] / total), _round(acc[2] / total)]


def _topology(shape: Any) -> dict[str, int]:
    def count(fn: Callable[[], Any]) -> int:
        try:
            return len(fn())
        except Exception:  # pragma: no cover - defensive
            return 0

    return {
        "faces": count(shape.faces),
        "edges": count(shape.edges),
        "vertices": count(shape.vertices),
        "solids": len(_solid_list(shape)),
    }


def cylindrical_face_radii(shape: Any) -> list[float]:
    """Radii of every cylindrical B-rep face (hole detection used by checks/tests)."""
    B = _bd()
    radii: list[float] = []
    try:
        faces = list(shape.faces())
    except Exception:  # pragma: no cover - defensive
        return radii
    for face in faces:
        try:
            if face.geom_type == B.GeomType.CYLINDER:
                radius = getattr(face, "radius", None)
                if radius is not None:
                    radii.append(float(radius))
        except Exception:  # pragma: no cover - defensive
            continue
    return radii


def _cylinder_counts(shape: Any, digits: int = 4) -> dict[float, int]:
    counts: dict[float, int] = {}
    for radius in cylindrical_face_radii(shape):
        key = round(radius, digits)
        counts[key] = counts.get(key, 0) + 1
    return counts


def _face_count(shape: Any) -> int:
    try:
        return len(shape.faces())
    except Exception:  # pragma: no cover - defensive
        return 0


def _holes_in(feature: Feature, bbox_size: tuple[float, float, float]) -> list[tuple[float, float, float]]:
    """All hole positions (x, y, radius) a feature will punch, for wall_thickness."""
    params = feature.params
    if feature.op == "hole":
        radius = float(params["diameter"]) / 2.0
        axis = params.get("axis", "z")
        at = params.get("at", (0.0, 0.0))
        if axis == "z":
            return [(float(at[0]), float(at[1]), radius)]
        if axis == "x":
            return [(float(at[0]), float(at[1]), radius)]  # (y, z) - handled by caller
        return [(float(at[0]), float(at[1]), radius)]  # (x, z)
    if feature.op == "hole_pattern":
        radius = float(params["diameter"]) / 2.0
        positions = _pattern_positions(feature, bbox_size)
        return [(x, y, radius) for (x, y) in positions]
    return []


def _pattern_positions(feature: Feature, bbox_size: tuple[float, float, float]) -> list[tuple[float, float]]:
    """Resolve a hole_pattern to explicit (x, y) hole centres."""
    params = feature.params
    pattern = params["pattern"]
    if pattern == "rect_corners":
        span = params.get("span") or (bbox_size[0], bbox_size[1])
        inset = float(params["inset"])
        hx = float(span[0]) / 2.0 - inset
        hy = float(span[1]) / 2.0 - inset
        return [(hx, hy), (-hx, hy), (hx, -hy), (-hx, -hy)]
    if pattern == "grid":
        nx, ny = params["count"]
        dx, dy = params["spacing"]
        cx, cy = params.get("center", (0.0, 0.0))
        return [
            (float(cx) + (i - (nx - 1) / 2.0) * float(dx), float(cy) + (j - (ny - 1) / 2.0) * float(dy))
            for i in range(int(nx))
            for j in range(int(ny))
        ]
    if pattern == "bolt_circle":
        count = int(params["count"])
        radius = float(params["pitch_diameter"]) / 2.0
        cx, cy = params.get("center", (0.0, 0.0))
        return [
            (float(cx) + radius * math.cos(2.0 * math.pi * k / count), float(cy) + radius * math.sin(2.0 * math.pi * k / count))
            for k in range(count)
        ]
    raise invalid_geometry(f"unsupported hole pattern {pattern!r}")


def _hole_tool(shape: Any, *, radius: float, axis: str, at: tuple[float, float], through: bool, depth: float | None, face: str) -> Any:
    """Build the cutting cylinder for one hole in the body's current bbox."""
    B = _bd()
    box = _bbox(shape)
    minimum = [float(box.min.X), float(box.min.Y), float(box.min.Z)]
    maximum = [float(box.max.X), float(box.max.Y), float(box.max.Z)]
    axis_index = _axis_index(axis)
    span = maximum[axis_index] - minimum[axis_index]
    margin = 1.0
    if through:
        length = span + 2.0 * margin
        centre_axis = (minimum[axis_index] + maximum[axis_index]) / 2.0
    else:
        if depth is None or depth <= 0:
            raise invalid_geometry("non-through hole requires a positive depth")
        length = float(depth)
        if face == "bottom":
            centre_axis = minimum[axis_index] + length / 2.0
        else:
            centre_axis = maximum[axis_index] - length / 2.0
    tool = _rotated_cylinder(radius, length, axis)
    others = [i for i in (0, 1, 2) if i != axis_index]
    coords = [0.0, 0.0, 0.0]
    coords[others[0]] = float(at[0])
    coords[others[1]] = float(at[1])
    coords[axis_index] = centre_axis
    return tool.move(B.Location(tuple(coords)))


def _cut_holes(shape: Any, tools: list[Any], cancel_event: threading.Event | None = None, batch_size: int = 10) -> Any:
    """Subtract many hole tools with one boolean per batch (fast, cancellable).

    A single OCCT boolean is atomic, so holes are cut in small batches and the
    cancellation event is checked between batches: a 100-hole pattern stays
    cancellable to within ~10 ms instead of one long uninterruptible call.
    """
    for start in range(0, len(tools), batch_size):
        if cancel_event is not None and cancel_event.is_set():
            raise cancelled_error("build cancelled while cutting holes")
        shape = shape.cut(*tools[start : start + batch_size])
    return shape


def _select_edges(shape: Any, target: str) -> Any:
    B = _bd()
    edges = shape.edges()
    if target == "all_edges":
        return edges
    if target == "vertical_edges":
        return edges.filter_by(B.Axis.Z)
    box = _bbox(shape)
    eps = 1e-6
    if target == "top_edges":
        return edges.filter_by_position(B.Axis.Z, float(box.max.Z) - eps, float(box.max.Z) + eps)
    if target == "bottom_edges":
        return edges.filter_by_position(B.Axis.Z, float(box.min.Z) - eps, float(box.min.Z) + eps)
    raise invalid_geometry(f"unsupported edge target {target!r}")


# ---------------------------------------------------------------------------
# Feature application
# ---------------------------------------------------------------------------


def _apply_feature(
    shape: Any | None,
    feature: Feature,
    limits: Mapping[str, Any],
    cancel_event: threading.Event | None = None,
) -> tuple[Any, str, FeatureEffect | None]:
    """Apply one feature, returning (new_shape, detail, effect-or-None)."""
    B = _bd()
    params = feature.params
    op = feature.op
    before_faces = _face_count(shape) if shape is not None else 0

    if op == "box":
        primitive = _place(
            B.Box(float(params["length"]), float(params["width"]), float(params["height"])),
            params.get("center"),
        )
        detail = f"box {params['length']:g} x {params['width']:g} x {params['height']:g} mm"
        if shape is None:
            return primitive, detail, None
        return shape + primitive, detail + " (unioned)", _faces_effect(feature, before_faces, shape + primitive)

    if op == "cylinder":
        primitive = _place(
            _rotated_cylinder(float(params["diameter"]) / 2.0, float(params["height"]), params.get("axis", "z")),
            params.get("center"),
        )
        detail = f"cylinder d{params['diameter']:g} x h{params['height']:g} mm axis {params.get('axis', 'z')}"
        if shape is None:
            return primitive, detail, None
        return shape + primitive, detail + " (unioned)", _faces_effect(feature, before_faces, shape + primitive)

    if shape is None:
        raise invalid_geometry(f"feature \"{feature.id}\" needs existing material; the first feature must create it")

    if op == "hole":
        radius = float(params["diameter"]) / 2.0
        axis = params.get("axis", "z")
        at = params.get("at", (0.0, 0.0))
        tool = _hole_tool(
            shape,
            radius=radius,
            axis=axis,
            at=(float(at[0]), float(at[1])),
            through=bool(params.get("through", True)),
            depth=float(params["depth"]) if "depth" in params else None,
            face=params.get("face", "top"),
        )
        new_shape = _cut_holes(shape, [tool], cancel_event)
        detail = f"through hole d{params['diameter']:g} mm at ({at[0]:g}, {at[1]:g}) axis {axis}"
        if not params.get("through", True):
            detail = f"blind hole d{params['diameter']:g} x depth {params['depth']:g} mm from {params.get('face', 'top')}"
        effect = _cylinders_effect(feature, shape, new_shape, expected=1, radius=radius)
        return new_shape, detail, effect

    if op == "hole_pattern":
        radius = float(params["diameter"]) / 2.0
        box = _bbox(shape)
        size = (float(box.size.X), float(box.size.Y), float(box.size.Z))
        positions = _pattern_positions(feature, size)
        tools = [
            _hole_tool(
                shape,
                radius=radius,
                axis="z",
                at=(x, y),
                through=bool(params.get("through", True)),
                depth=float(params["depth"]) if "depth" in params else None,
                face=params.get("face", "top"),
            )
            for (x, y) in positions
        ]
        new_shape = _cut_holes(shape, tools, cancel_event)
        detail = f"{params['pattern']} pattern: {len(positions)} x d{params['diameter']:g} mm through z"
        effect = _cylinders_effect(feature, shape, new_shape, expected=len(positions), radius=radius)
        return new_shape, detail, effect

    if op in ("fillet", "chamfer"):
        target = params.get("target", "vertical_edges")
        edges = _select_edges(shape, target)
        edge_count = len(edges)
        if edge_count == 0:
            raise invalid_geometry(f"feature \"{feature.id}\": no \"{target}\" edges found to {op}")
        try:
            if op == "fillet":
                new_shape = B.fillet(edges, radius=float(params["radius"]))
                detail = f"fillet r{params['radius']:g} mm on {edge_count} {target}"
            else:
                new_shape = B.chamfer(edges, length=float(params["distance"]))
                detail = f"chamfer {params['distance']:g} mm on {edge_count} {target}"
        except CadRuntimeError:
            raise
        except Exception as exc:  # OCC raises ValueError for impossible radii
            raise invalid_geometry(
                f"feature \"{feature.id}\": {op} of {edge_count} {target} failed: {exc}",
                featureId=feature.id,
                featureIndex=feature.index,
            ) from exc
        if new_shape is None or len(_solid_list(new_shape)) == 0:
            raise invalid_geometry(f"feature \"{feature.id}\": {op} produced an empty body")
        return new_shape, detail, _faces_effect(feature, before_faces, new_shape)

    if op in ("cut", "union"):
        primitive = _primitive_shape(params["shape"])
        if op == "cut":
            new_shape = shape - primitive
            detail = "cut nested primitive"
        else:
            new_shape = shape + primitive
            detail = "union nested primitive"
        spec = params["shape"]
        if spec["op"] == "cylinder":
            effect = _cylinders_effect(feature, shape, new_shape, expected=1, radius=float(spec["diameter"]) / 2.0)
        else:
            effect = _faces_effect(feature, before_faces, new_shape)
        return new_shape, detail, effect

    raise invalid_geometry(f"unsupported feature op {op!r}")  # pragma: no cover


def _cylinders_effect(feature: Feature, before_shape: Any, after_shape: Any, *, expected: int, radius: float) -> FeatureEffect:
    before = _cylinder_counts(before_shape).get(round(radius, 4), 0)
    after = _cylinder_counts(after_shape).get(round(radius, 4), 0)
    delta = after - before
    ok = delta >= expected
    detail = f"{delta} cylindrical face(s) r={radius:g} mm appeared (expected {expected})"
    return FeatureEffect(feature.id, feature.op, "cylinders", expected, radius, before, after, ok, detail)


def _faces_effect(feature: Feature, before_faces: int, after_shape: Any) -> FeatureEffect:
    after_faces = _face_count(after_shape)
    ok = after_faces != before_faces
    detail = f"face count {before_faces} -> {after_faces}"
    return FeatureEffect(feature.id, feature.op, "faces", 1, None, before_faces, after_faces, ok, detail)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


@dataclass
class _CheckContext:
    doc: CadDocument
    shape: Any | None
    limits: dict[str, Any]
    effects: list[FeatureEffect]
    failure: CadRuntimeError | None
    warnings: list[str]
    mesh: MeshData | None
    mesh_error: str | None
    volume: float
    bbox_size: list[float]
    checks_requested: tuple[str, ...]


def _check(check_id: str, status: str, message: str) -> dict[str, Any]:
    return {"id": check_id, "status": status, "message": message}


def _evaluate_checks(ctx: _CheckContext) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for check_id in CHECK_IDS:
        if check_id not in ctx.checks_requested:
            continue
        checks.append(_evaluate_check(check_id, ctx))
    return checks


def _evaluate_check(check_id: str, ctx: _CheckContext) -> dict[str, Any]:
    shape = ctx.shape
    if check_id == "document_schema":
        return _check(
            check_id,
            "pass",
            f"document accepted: {len(ctx.doc.features)} feature(s), {len(ctx.doc.parameters)} parameter(s), schema {ctx.doc.schema}",
        )

    if check_id == "single_solid":
        if shape is None:
            return _check(check_id, "fail", "no geometry was produced")
        solids = len(_solid_list(shape))
        if solids == 1:
            return _check(check_id, "pass", "exactly one solid")
        return _check(check_id, "fail", f"expected exactly 1 solid, found {solids}")

    if check_id == "brep_valid":
        if shape is None:
            return _check(check_id, "fail", "no geometry was produced")
        try:
            valid = bool(shape.is_valid)
        except Exception as exc:  # pragma: no cover - defensive
            return _check(check_id, "fail", f"B-rep validity could not be evaluated: {exc}")
        return _check(check_id, "pass", "OpenCASCADE B-rep is valid") if valid else _check(check_id, "fail", "OpenCASCADE B-rep is invalid")

    if check_id == "positive_volume":
        if shape is None:
            return _check(check_id, "fail", "no geometry was produced")
        if math.isfinite(ctx.volume) and ctx.volume > 0:
            return _check(check_id, "pass", f"volume {ctx.volume:.3f} mm^3")
        return _check(check_id, "fail", f"volume must be positive, got {ctx.volume!r}")

    if check_id == "closed_shell":
        if ctx.mesh is None:
            reason = ctx.mesh_error or "no geometry was produced"
            if ctx.failure is not None and ctx.failure.code == ERROR_CODES["cancelled"]:
                return _check(check_id, "warn", f"mesh not evaluated: {reason}")
            return _check(check_id, "fail", f"mesh could not be tessellated: {reason}")
        if ctx.mesh.closed:
            note = ""
            if ctx.mesh.non_manifold_edges:
                note = f"; {ctx.mesh.non_manifold_edges} edge(s) shared by more than 2 triangles (closed, non-manifold)"
                ctx.warnings.append(f"tessellation has {ctx.mesh.non_manifold_edges} non-manifold edge(s); the shell is still closed")
            return _check(
                check_id,
                "pass",
                f"closed watertight mesh: {ctx.mesh.vertex_count} vertices, {ctx.mesh.triangle_count} triangles{note}",
            )
        return _check(
            check_id,
            "fail",
            f"mesh has open boundary edges after welding ({ctx.mesh.vertex_count} vertices, {ctx.mesh.triangle_count} triangles)",
        )

    if check_id == "bounding_box":
        if shape is None:
            return _check(check_id, "fail", "no geometry was produced")
        limit = float(ctx.limits.get("maxBoundingBoxMm", DEFAULT_LIMITS["maxBoundingBoxMm"]))
        size = ctx.bbox_size
        if any((not math.isfinite(v)) or v < 0 for v in size):
            return _check(check_id, "fail", f"bounding box size is not finite/non-negative: {size}")
        largest = max(size) if size else 0.0
        if largest <= limit:
            return _check(check_id, "pass", f"bbox {size[0]:g} x {size[1]:g} x {size[2]:g} mm within {limit:g} mm")
        return _check(check_id, "fail", f"bbox largest dimension {largest:g} mm exceeds limit {limit:g} mm")

    if check_id == "feature_effects":
        if ctx.failure is not None and ctx.failure.code in (ERROR_CODES["invalidGeometry"], ERROR_CODES["buildFailed"]):
            return _check(check_id, "fail", ctx.failure.message)
        if not ctx.effects:
            return _check(check_id, "pass", "no subtractive/effect-bearing features to verify")
        failures = [effect for effect in ctx.effects if not effect.ok]
        if not failures:
            return _check(check_id, "pass", f"{len(ctx.effects)} feature effect(s) verified")
        return _check(
            check_id,
            "fail",
            "feature effects not observed: " + "; ".join(f"{e.feature_id}: {e.detail}" for e in failures),
        )

    if check_id == "wall_thickness":
        minimum = float(ctx.limits.get("minWallThicknessMm", DEFAULT_LIMITS["minWallThicknessMm"]))
        if shape is None:
            return _check(check_id, "pass", "no geometry to evaluate")
        box = _bbox(shape)
        spans = (float(box.size.X), float(box.size.Y), float(box.size.Z))
        minimums = (float(box.min.X), float(box.min.Y), float(box.min.Z))
        maximums = (float(box.max.X), float(box.max.Y), float(box.max.Z))
        thin: list[str] = []
        checked = 0
        for feature in ctx.doc.features:
            if feature.op not in ("hole", "hole_pattern"):
                continue
            params = feature.params
            axis = params.get("axis", "z") if feature.op == "hole" else "z"
            axis_index = _axis_index(axis)
            plane_axes = [i for i in (0, 1, 2) if i != axis_index]
            positions = _holes_in(feature, spans) if feature.op == "hole_pattern" else _holes_in(feature, spans)
            for (a, b, radius) in positions:
                checked += 1
                clearance = min(
                    a - minimums[plane_axes[0]],
                    maximums[plane_axes[0]] - a,
                    b - minimums[plane_axes[1]],
                    maximums[plane_axes[1]] - b,
                ) - radius
                if clearance < minimum:
                    thin.append(f"{feature.id} hole near ({a:g}, {b:g}) leaves {clearance:.3f} mm")
        if thin:
            ctx.warnings.append("thin wall warning: " + "; ".join(thin[:4]))
            return _check(check_id, "warn", f"thin wall (< {minimum:g} mm): " + "; ".join(thin[:4]))
        if checked == 0:
            return _check(check_id, "pass", "no holes to evaluate")
        return _check(check_id, "pass", f"{checked} hole(s) keep >= {minimum:g} mm material")

    return _check(check_id, "warn", "unknown check id")  # pragma: no cover


# ---------------------------------------------------------------------------
# Tessellation
# ---------------------------------------------------------------------------


def tessellate(shape: Any, tolerance: float, angular_tolerance: float) -> MeshData:
    """Tessellate a shape into a welded trimesh mesh (CAD coordinates, mm)."""
    import numpy as np
    import trimesh  # noqa: PLC0415 - lazy

    vertices, triangles = shape.tessellate(float(tolerance), float(angular_tolerance))
    if not vertices or not triangles:
        raise invalid_geometry("tessellation produced no triangles")
    points = np.array([(float(v.X), float(v.Y), float(v.Z)) for v in vertices], dtype=np.float64)
    faces = np.array([tuple(int(i) for i in tri) for tri in triangles], dtype=np.int64)
    mesh = trimesh.Trimesh(vertices=points, faces=faces, process=False)
    mesh.merge_vertices()
    # OCC fillets can emit a handful of zero-area triangles at tangent seams;
    # dropping them (they carry no surface) makes the welded shell closed.
    keep = mesh.nondegenerate_faces()
    if not bool(keep.all()):
        mesh.update_faces(keep)
        mesh.remove_unreferenced_vertices()
        mesh.merge_vertices()
    edge_uses: dict[tuple[int, int], int] = {}
    for edge in np.asarray(mesh.edges_sorted):
        key = (int(edge[0]), int(edge[1]))
        edge_uses[key] = edge_uses.get(key, 0) + 1
    non_manifold = sum(1 for uses in edge_uses.values() if uses != 2)
    closed = bool(edge_uses) and all(uses % 2 == 0 for uses in edge_uses.values())
    return MeshData(
        vertices=np.asarray(mesh.vertices),
        faces=np.asarray(mesh.faces),
        watertight=bool(mesh.is_watertight),
        closed=bool(closed),
        non_manifold_edges=int(non_manifold),
        winding_consistent=bool(mesh.is_winding_consistent),
        volume=float(mesh.volume) if mesh.is_volume else 0.0,
        tolerance=float(tolerance),
        angular_tolerance=float(angular_tolerance),
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def build_geometry(
    doc: CadDocument,
    *,
    limits: Mapping[str, Any] | None = None,
    cancel_event: threading.Event | None = None,
    progress: ProgressFn | None = None,
    checks: list[str] | None = None,
) -> BuildOutcome:
    """Build the B-rep for ``doc`` and evaluate the geometry checks.

    Args:
        doc: validated document (see :mod:`cad_runtime.document`).
        limits: resolved limit overrides.
        cancel_event: set to request cooperative cancellation between features.
        progress: callback ``(phase, percent, message)``.
        checks: subset of check ids to echo (all are always evaluated).
    """
    started = time.perf_counter()
    merged_limits = dict(DEFAULT_LIMITS)
    if limits:
        merged_limits.update(limits)
    requested = tuple(checks) if checks else CHECK_IDS
    warnings = list(doc.warnings)
    _emit(progress, "validating", 2, "validated document")

    shape: Any | None = None
    feature_reports: list[dict[str, Any]] = []
    effects: list[FeatureEffect] = []
    failure: CadRuntimeError | None = None
    total = len(doc.features)
    feature_timings: list[float] = []

    for feature in doc.features:
        if cancel_event is not None and cancel_event.is_set():
            failure = cancelled_error("build cancelled before feature was applied", featureId=feature.id, featureIndex=feature.index)
            feature_reports.append(
                {"id": feature.id, "op": feature.op, "status": "warn", "detail": "cancelled before this feature ran"}
            )
            break
        _emit(progress, "building", 5 + int(85 * feature.index / total), f"feature {feature.index + 1}/{total} {feature.id}")
        feature_started = time.perf_counter()
        try:
            shape, detail, effect = _apply_feature(shape, feature, merged_limits, cancel_event)
            feature_timings.append((time.perf_counter() - feature_started) * 1000.0)
            feature_reports.append({"id": feature.id, "op": feature.op, "status": "pass", "detail": detail})
            if effect is not None:
                effects.append(effect)
        except CadRuntimeError as exc:
            feature_timings.append((time.perf_counter() - feature_started) * 1000.0)
            if exc.code == ERROR_CODES["cancelled"]:
                failure = exc
                feature_reports.append({"id": feature.id, "op": feature.op, "status": "warn", "detail": exc.message})
            else:
                failure = exc if exc.code == ERROR_CODES["invalidGeometry"] else build_failed(
                    f"feature \"{feature.id}\" failed unexpectedly: {exc.message}",
                    featureId=feature.id,
                    featureIndex=feature.index,
                )
                detail = exc.message
                feature_reports.append({"id": feature.id, "op": feature.op, "status": "fail", "detail": detail})
            break
        except Exception as exc:  # noqa: BLE001 - convert everything to a structured build failure
            feature_timings.append((time.perf_counter() - feature_started) * 1000.0)
            message = f"feature \"{feature.id}\" ({feature.op}) failed: {exc}"
            failure = build_failed(message, featureId=feature.id, featureIndex=feature.index, exception=type(exc).__name__)
            feature_reports.append({"id": feature.id, "op": feature.op, "status": "fail", "detail": message})
            break

    if failure is not None:
        for skipped in doc.features[len(feature_reports):]:
            feature_reports.append(
                {"id": skipped.id, "op": skipped.op, "status": "warn", "detail": "not executed (earlier feature failed)"}
            )

    if failure is None and cancel_event is not None and cancel_event.is_set():
        # Cancelled after the last feature but before checks/tessellation.
        failure = cancelled_error("build cancelled after the last feature")

    build_ms = (time.perf_counter() - started) * 1000.0

    # Geometry summary ---------------------------------------------------------
    solids: list[Any] = _solid_list(shape) if shape is not None else []
    volume, area = _volume_and_area(shape) if shape is not None else (0.0, 0.0)
    if shape is not None:
        bbox_min, bbox_max, bbox_size = _bbox_arrays(shape)
    else:
        bbox_min, bbox_max, bbox_size = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    topology = _topology(shape) if shape is not None else {"faces": 0, "edges": 0, "vertices": 0, "solids": 0}
    centroid = _centroid(shape) if shape is not None else [0.0, 0.0, 0.0]

    # Mesh + closed_shell ------------------------------------------------------
    mesh: MeshData | None = None
    mesh_error: str | None = None
    if shape is not None and any(_solid_list(shape)):
        cancelled_build = failure is not None and failure.code == ERROR_CODES["cancelled"]
        if cancelled_build:
            # A cancelled build settles fast: tessellation of a partial body is
            # the most expensive step and its result is discarded anyway.
            mesh_error = "not evaluated (build cancelled)"
        else:
            try:
                _emit(progress, "building", 90, "tessellating")
                mesh = tessellate(
                    shape,
                    float(merged_limits.get("meshToleranceMm", DEFAULT_LIMITS["meshToleranceMm"])),
                    float(merged_limits.get("meshAngularToleranceRad", DEFAULT_LIMITS["meshAngularToleranceRad"])),
                )
            except Exception as exc:  # noqa: BLE001 - reported through closed_shell
                mesh_error = str(exc)

    checks_requested = tuple(checks) if checks else CHECK_IDS
    ctx = _CheckContext(
        doc=doc,
        shape=shape,
        limits=merged_limits,
        effects=effects,
        failure=failure,
        warnings=warnings,
        mesh=mesh,
        mesh_error=mesh_error,
        volume=volume,
        bbox_size=bbox_size,
        checks_requested=checks_requested,
    )
    check_list = _evaluate_checks(ctx)

    failed_checks = [c for c in check_list if c["status"] == "fail"]
    if failure is None and failed_checks:
        failure = invalid_geometry(
            "geometry checks failed: " + ", ".join(c["id"] for c in failed_checks),
            checks=[{"id": c["id"], "status": c["status"], "message": c["message"]} for c in failed_checks],
        )

    report = {
        "schema": REPORT_SCHEMA,
        "valid": failure is None and not failed_checks,
        "volume": _round(volume),
        "surfaceArea": _round(area),
        "boundingBox": {"min": bbox_min, "max": bbox_max, "size": bbox_size},
        "centroid": centroid,
        "topology": topology,
        "checks": check_list,
        "featureReports": feature_reports,
        "warnings": warnings,
        "timings": {
            "totalMs": 0,  # filled by the caller (artifacts included)
            "buildMs": round(build_ms, 1),
            "exportMs": 0,
        },
    }
    if mesh is not None:
        report["mesh"] = mesh.stats()

    timings = {
        "buildMs": round(build_ms, 1),
        "featuresMs": [round(value, 1) for value in feature_timings],
        "geometryMs": round((time.perf_counter() - started) * 1000.0, 1),
    }

    return BuildOutcome(
        shape=shape,
        report=report,
        checks=check_list,
        feature_reports=feature_reports,
        warnings=warnings,
        error=failure,
        mesh=mesh,
        timings=timings,
        limits=merged_limits,
    )


def _emit(progress: ProgressFn | None, phase: str, percent: int, message: str) -> None:
    if progress is None:
        return
    try:
        progress(phase, max(0, min(100, int(percent))), message)
    except Exception:  # pragma: no cover - progress must never fail a build
        pass
