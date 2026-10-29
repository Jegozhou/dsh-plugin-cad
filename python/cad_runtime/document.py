"""Strict, side-effect-free validation of ``dsh.cad/document@1``.

The runtime executes **only** what is described by this module: a closed
catalogue of declarative features with numeric fields. There is no expression
evaluator, no ``eval``/``exec``, no file import and no network access anywhere in
the runtime. Anything outside the catalogue is rejected with
``invalid_document`` and an RFC 6901 JSON-pointer path.

Validation is complete before geometry: a document is either accepted whole or
rejected whole (SPEC_P0.md §3: "There is no partial application").
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from .errors import bracket_path, invalid_document, json_pointer
from .protocol import DEFAULT_LIMITS, DOCUMENT_SCHEMA, ERROR_CODES, FEATURE_OPS

#: Parameter names: ``^[A-Za-z][A-Za-z0-9_]{0,39}$`` (SPEC §3).
PARAMETER_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")

#: Feature ids: ``^[A-Za-z][A-Za-z0-9_-]{0,39}$`` (SPEC §3).
FEATURE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,39}$")

#: Hard bound on any numeric field (mm or degrees). Not a design rule: a guard
#: against documents that would make OpenCASCADE allocate absurd tolerances.
MAX_ABS_VALUE = 1.0e6

DOCUMENT_FIELDS = frozenset({"schema", "units", "parameters", "features", "name", "description"})

COMMON_FEATURE_FIELDS = frozenset({"id", "op"})

FEATURE_FIELDS: Mapping[str, frozenset[str]] = {
    "box": frozenset({"length", "width", "height", "center"}),
    "cylinder": frozenset({"diameter", "height", "center", "axis"}),
    "hole": frozenset({"diameter", "at", "through", "depth", "axis", "face"}),
    "hole_pattern": frozenset(
        {
            "pattern",
            "diameter",
            "through",
            "depth",
            "inset",
            "span",
            "count",
            "spacing",
            "center",
            "pitch_diameter",
        }
    ),
    "fillet": frozenset({"radius", "target"}),
    "chamfer": frozenset({"distance", "target"}),
    "cut": frozenset({"shape"}),
    "union": frozenset({"shape"}),
}

REQUIRED_FIELDS: Mapping[str, frozenset[str]] = {
    "box": frozenset({"length", "width", "height"}),
    "cylinder": frozenset({"diameter", "height"}),
    "hole": frozenset({"diameter"}),
    "hole_pattern": frozenset({"pattern", "diameter"}),
    "fillet": frozenset({"radius"}),
    "chamfer": frozenset({"distance"}),
    "cut": frozenset({"shape"}),
    "union": frozenset({"shape"}),
}

PATTERN_FIELDS: Mapping[str, frozenset[str]] = {
    "rect_corners": frozenset({"inset", "span"}),
    "grid": frozenset({"count", "spacing", "center"}),
    "bolt_circle": frozenset({"count", "pitch_diameter", "center"}),
}

PATTERN_REQUIRED: Mapping[str, frozenset[str]] = {
    "rect_corners": frozenset({"inset"}),
    "grid": frozenset({"count", "spacing"}),
    "bolt_circle": frozenset({"count", "pitch_diameter"}),
}

EDGE_TARGETS = ("vertical_edges", "top_edges", "bottom_edges", "all_edges")
HOLE_AXES = ("x", "y", "z")
HOLE_FACES = ("top", "bottom")

AXES = {"x": 0, "y": 1, "z": 2}

#: Operations that add material. The first feature of a document must create
#: material (SPEC §3: "the body starts empty and the first feature must create
#: material").
MATERIAL_OPS = frozenset({"box", "cylinder", "union"})

PRIMITIVE_OPS = frozenset({"box", "cylinder"})


@dataclass(frozen=True)
class Feature:
    """One validated, parameter-resolved feature."""

    index: int
    id: str
    op: str
    params: dict[str, Any]
    path: str


@dataclass(frozen=True)
class CadDocument:
    """A fully validated CAD document."""

    schema: str
    units: str
    parameters: dict[str, float]
    features: tuple[Feature, ...]
    name: str | None = None
    description: str | None = None
    warnings: tuple[str, ...] = field(default=())

    def parameter_summary(self) -> dict[str, float]:
        return dict(self.parameters)


class _Violations:
    """Accumulates every structural violation so one response lists them all."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def add(self, path: str, message: str, *, parts: Iterable[object] | None = None) -> None:
        entry = {"path": path, "message": message}
        if parts is not None:
            entry["field"] = bracket_path(*parts)
        self.items.append(entry)

    @property
    def first_path(self) -> str:
        return self.items[0]["path"] if self.items else ""

    def raise_if_any(self) -> None:
        if not self.items:
            return
        first = self.items[0]
        raise invalid_document(
            f"{first['message']} (at {first['path'] or 'document'})",
            path=first["path"],
            violations=self.items,
        )


def _is_number(value: Any) -> bool:
    # bool is an int subclass in Python; JSON booleans must never pass as numbers.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _fmt(value: Any) -> str:
    if isinstance(value, str):
        return repr(value)
    return str(value)


class _Validator:
    def __init__(self, raw: Any, limits: Mapping[str, Any] | None) -> None:
        self.raw = raw
        self.limits = dict(DEFAULT_LIMITS)
        if limits:
            self.limits.update(limits)
        self.v = _Violations()
        self.warnings: list[str] = []
        self.parameters: dict[str, float] = {}
        self.features: list[Feature] = []

    # -- primitives ----------------------------------------------------------

    def number(
        self,
        value: Any,
        parts: tuple[object, ...],
        *,
        what: str,
        positive: bool = False,
        non_negative: bool = False,
        integer: bool = False,
        min_value: float | None = None,
        max_value: float | None = None,
    ) -> float | int | None:
        """Resolve a number-or-``$param`` field and range-check it."""
        path = json_pointer(*parts)
        resolved: Any = value
        if isinstance(value, str):
            if not value.startswith("$") or len(value) < 2:
                self.v.add(path, f"{what} must be a number or a parameter reference like \"$name\", got {_fmt(value)}", parts=parts)
                return None
            name = value[1:]
            if name not in self.parameters:
                self.v.add(path, f"{what} references unknown parameter \"${name}\"", parts=parts)
                return None
            resolved = self.parameters[name]
        elif not _is_number(value):
            self.v.add(path, f"{what} must be a finite number, got {type(value).__name__}", parts=parts)
            return None

        num = float(resolved)
        if not math.isfinite(num):
            self.v.add(path, f"{what} must be finite, got {num}", parts=parts)
            return None
        if abs(num) > MAX_ABS_VALUE:
            self.v.add(path, f"{what} magnitude exceeds the supported limit {MAX_ABS_VALUE:g}", parts=parts)
            return None
        if positive and not num > 0:
            self.v.add(path, f"{what} must be greater than 0, got {num:g}", parts=parts)
            return None
        if non_negative and num < 0:
            self.v.add(path, f"{what} must be 0 or greater, got {num:g}", parts=parts)
            return None
        if integer:
            if not float(num).is_integer():
                self.v.add(path, f"{what} must be an integer, got {num:g}", parts=parts)
                return None
            num = int(num)
        if min_value is not None and num < min_value:
            self.v.add(path, f"{what} must be at least {min_value:g}, got {num:g}", parts=parts)
            return None
        if max_value is not None and num > max_value:
            self.v.add(path, f"{what} must be at most {max_value:g}, got {num:g}", parts=parts)
            return None
        return num

    def number_tuple(
        self,
        value: Any,
        parts: tuple[object, ...],
        *,
        what: str,
        lengths: tuple[int, ...],
        positive: bool = False,
        non_negative: bool = False,
    ) -> tuple[float, ...] | None:
        path = json_pointer(*parts)
        if not isinstance(value, (list, tuple)):
            self.v.add(path, f"{what} must be an array of {lengths} numbers", parts=parts)
            return None
        if len(value) not in lengths:
            allowed = " or ".join(str(n) for n in lengths)
            self.v.add(path, f"{what} must contain {allowed} numbers, got {len(value)}", parts=parts)
            return None
        out: list[float] = []
        ok = True
        for i, item in enumerate(value):
            num = self.number(
                item,
                parts + (i,),
                what=f"{what}[{i}]",
                positive=positive,
                non_negative=non_negative,
            )
            if num is None:
                ok = False
            else:
                out.append(float(num))
        return tuple(out) if ok else None

    def boolean(self, value: Any, parts: tuple[object, ...], *, what: str, default: bool) -> bool:
        if value is None:
            return default
        if not isinstance(value, bool):
            self.v.add(json_pointer(*parts), f"{what} must be true or false", parts=parts)
            return default
        return value

    def enum(self, value: Any, allowed: tuple[str, ...], parts: tuple[object, ...], *, what: str, default: str) -> str:
        if value is None:
            return default
        if not isinstance(value, str) or value not in allowed:
            self.v.add(
                json_pointer(*parts),
                f"{what} must be one of {list(allowed)}, got {_fmt(value)}",
                parts=parts,
            )
            return default
        return value

    def unknown_fields(self, obj: Mapping[str, Any], allowed: frozenset[str], parts: tuple[object, ...], *, what: str) -> None:
        for key in obj:
            if key not in allowed:
                self.v.add(
                    json_pointer(*parts, key),
                    f"unknown field \"{key}\" on {what}",
                    parts=parts + (key,),
                )

    # -- document ------------------------------------------------------------

    def document(self) -> CadDocument:
        raw = self.raw
        if not isinstance(raw, dict):
            raise invalid_document(
                f"document must be a JSON object, got {type(raw).__name__}",
                path="",
                violations=[{"path": "", "message": "document must be a JSON object"}],
            )

        self.unknown_fields(raw, DOCUMENT_FIELDS, (), what="document")

        # schema -------------------------------------------------------------
        schema = raw.get("schema")
        if schema is None:
            self.warnings.append("document has no \"schema\"; assumed dsh.cad/document@1")
            schema = DOCUMENT_SCHEMA
        elif not isinstance(schema, str) or schema != DOCUMENT_SCHEMA:
            self.v.add(
                "/schema",
                f"schema must be \"{DOCUMENT_SCHEMA}\", got {_fmt(schema)}",
                parts=("schema",),
            )
            schema = DOCUMENT_SCHEMA

        # units --------------------------------------------------------------
        units = raw.get("units")
        if units is None:
            self.warnings.append("document has no \"units\"; assumed \"mm\"")
            units = "mm"
        elif units != "mm":
            self.v.add("/units", f"units must be \"mm\", got {_fmt(units)}", parts=("units",))
            units = "mm"

        # metadata -----------------------------------------------------------
        name = raw.get("name")
        if name is not None and (not isinstance(name, str) or len(name) > 200):
            self.v.add("/name", "name must be a string of at most 200 characters", parts=("name",))
            name = None
        description = raw.get("description")
        if description is not None and (not isinstance(description, str) or len(description) > 4000):
            self.v.add("/description", "description must be a string of at most 4000 characters", parts=("description",))
            description = None

        # parameters ---------------------------------------------------------
        raw_params = raw.get("parameters", {})
        max_params = int(self.limits.get("maxParameters", 64))
        if raw_params is None:
            raw_params = {}
        if not isinstance(raw_params, dict):
            self.v.add("/parameters", "parameters must be an object of name -> number", parts=("parameters",))
            raw_params = {}
        elif len(raw_params) > max_params:
            self.v.add(
                "/parameters",
                f"at most {max_params} parameters are allowed, got {len(raw_params)}",
                parts=("parameters",),
            )
        for pname, pvalue in raw_params.items():
            ppath = ("parameters", pname)
            if not isinstance(pname, str) or not PARAMETER_NAME_RE.match(pname):
                self.v.add(
                    json_pointer(*ppath),
                    f"parameter name {_fmt(pname)} must match {PARAMETER_NAME_RE.pattern}",
                    parts=ppath,
                )
                continue
            if isinstance(pvalue, bool) or not _is_number(pvalue):
                self.v.add(json_pointer(*ppath), f"parameter \"{pname}\" must be a finite number", parts=ppath)
                continue
            value = float(pvalue)
            if not math.isfinite(value):
                self.v.add(json_pointer(*ppath), f"parameter \"{pname}\" must be finite", parts=ppath)
                continue
            if abs(value) > MAX_ABS_VALUE:
                self.v.add(json_pointer(*ppath), f"parameter \"{pname}\" magnitude exceeds {MAX_ABS_VALUE:g}", parts=ppath)
                continue
            self.parameters[pname] = value

        # features -----------------------------------------------------------
        self._validate_features(raw.get("features"))

        if self.features and self.features[0].op not in MATERIAL_OPS and not self._first_feature_in_error():
            self.v.add(
                "/features/0/op",
                f"the first feature must create material (box, cylinder or union), got \"{self.features[0].op}\"",
                parts=("features", 0, "op"),
            )

        self.v.raise_if_any()

        return CadDocument(
            schema=schema,
            units=units,
            parameters=dict(self.parameters),
            features=tuple(self.features),
            name=name,
            description=description,
            warnings=tuple(self.warnings),
        )

    def _first_feature_in_error(self) -> bool:
        return any(item["path"].startswith("/features/0") for item in self.v.items)

    def _validate_features(self, raw_features: Any) -> None:
        max_features = int(self.limits.get("maxFeatures", 64))
        if raw_features is None:
            self.v.add("/features", "features is required", parts=("features",))
            return
        if not isinstance(raw_features, list):
            self.v.add("/features", "features must be an array", parts=("features",))
            return
        if not raw_features:
            self.v.add("/features", "at least one feature is required", parts=("features",))
            return
        if len(raw_features) > max_features:
            self.v.add(
                "/features",
                f"at most {max_features} features are allowed, got {len(raw_features)}",
                parts=("features",),
            )
            return
        ids: dict[str, int] = {}
        for index, raw_feature in enumerate(raw_features):
            feature = self.feature(raw_feature, index, ids)
            if feature is not None:
                self.features.append(feature)

    # -- features ------------------------------------------------------------

    def feature(self, raw: Any, index: int, ids: dict[str, int]) -> Feature | None:
        parts = ("features", index)
        path = json_pointer(*parts)
        if not isinstance(raw, dict):
            self.v.add(path, f"feature must be an object, got {type(raw).__name__}", parts=parts)
            return None

        start = len(self.v.items)

        # id ------------------------------------------------------------------
        feature_id = raw.get("id")
        if feature_id is None:
            self.v.add(json_pointer(*parts, "id"), "feature id is required", parts=parts + ("id",))
        elif not isinstance(feature_id, str) or not FEATURE_ID_RE.match(feature_id):
            self.v.add(
                json_pointer(*parts, "id"),
                f"feature id {_fmt(feature_id)} must match {FEATURE_ID_RE.pattern}",
                parts=parts + ("id",),
            )
            feature_id = None
        elif feature_id in ids:
            self.v.add(
                json_pointer(*parts, "id"),
                f"duplicate feature id \"{feature_id}\" (first used by features[{ids[feature_id]}])",
                parts=parts + ("id",),
            )
            feature_id = None
        else:
            ids[feature_id] = index

        # op ------------------------------------------------------------------
        op = raw.get("op")
        if op is None:
            self.v.add(json_pointer(*parts, "op"), "feature op is required", parts=parts + ("op",))
            return None
        if not isinstance(op, str) or op not in FEATURE_OPS:
            self.v.add(
                json_pointer(*parts, "op"),
                f"unknown feature op {_fmt(op)}; expected one of {list(FEATURE_OPS)}",
                parts=parts + ("op",),
            )
            return None

        allowed = COMMON_FEATURE_FIELDS | FEATURE_FIELDS[op]
        self.unknown_fields(raw, allowed, parts, what=f"\"{op}\" feature")

        # missing required ----------------------------------------------------
        for key in sorted(REQUIRED_FIELDS[op] - set(raw)):
            self.v.add(json_pointer(*parts, key), f"field \"{key}\" is required for op \"{op}\"", parts=parts + (key,))

        params: dict[str, Any] = {}
        if op == "box":
            self._op_box(raw, parts, params)
        elif op == "cylinder":
            self._op_cylinder(raw, parts, params)
        elif op == "hole":
            self._op_hole(raw, parts, params)
        elif op == "hole_pattern":
            self._op_hole_pattern(raw, parts, params)
        elif op == "fillet":
            self._op_fillet(raw, parts, params)
        elif op == "chamfer":
            self._op_chamfer(raw, parts, params)
        elif op in ("cut", "union"):
            primitive = self._primitive(raw.get("shape"), parts + ("shape",), required=True)
            if primitive is not None:
                params["shape"] = primitive

        if len(self.v.items) > start:
            return None
        assert feature_id is not None
        return Feature(index=index, id=feature_id, op=op, params=params, path=path)

    # -- individual ops ------------------------------------------------------

    def _op_box(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        for key in ("length", "width", "height"):
            if key in raw:
                num = self.number(raw[key], parts + (key,), what=key, positive=True)
                if num is not None:
                    params[key] = num
        if "center" in raw:
            center = self.number_tuple(raw["center"], parts + ("center",), what="center", lengths=(2, 3))
            if center is not None:
                params["center"] = center

    def _op_cylinder(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        for key in ("diameter", "height"):
            if key in raw:
                num = self.number(raw[key], parts + (key,), what=key, positive=True)
                if num is not None:
                    params[key] = num
        if "center" in raw:
            center = self.number_tuple(raw["center"], parts + ("center",), what="center", lengths=(2, 3))
            if center is not None:
                params["center"] = center
        params["axis"] = self.enum(raw.get("axis"), HOLE_AXES, parts + ("axis",), what="axis", default="z")

    def _op_hole(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        if "diameter" in raw:
            num = self.number(raw["diameter"], parts + ("diameter",), what="diameter", positive=True)
            if num is not None:
                params["diameter"] = num
        at = self.number_tuple(raw.get("at", [0, 0]), parts + ("at",), what="at", lengths=(2,), non_negative=False)
        params["at"] = at if at is not None else (0.0, 0.0)
        params["through"] = self.boolean(raw.get("through"), parts + ("through",), what="through", default=True)
        params["axis"] = self.enum(raw.get("axis"), HOLE_AXES, parts + ("axis",), what="axis", default="z")
        params["face"] = self.enum(raw.get("face"), HOLE_FACES, parts + ("face",), what="face", default="top")
        if "depth" in raw:
            depth = self.number(raw["depth"], parts + ("depth",), what="depth", positive=True)
            if depth is not None:
                params["depth"] = depth
        elif params["through"] is False:
            self.v.add(
                json_pointer(*parts, "depth"),
                "depth is required when through is false",
                parts=parts + ("depth",),
            )

    def _op_hole_pattern(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        pattern = self.enum(raw.get("pattern"), tuple(PATTERN_FIELDS), parts + ("pattern",), what="pattern", default="")
        params["pattern"] = pattern
        if not pattern:
            return
        allowed = COMMON_FEATURE_FIELDS | {"pattern", "diameter", "through", "depth"} | PATTERN_FIELDS[pattern]
        for key in raw:
            if key not in allowed:
                self.v.add(
                    json_pointer(*parts, key),
                    f"field \"{key}\" is not valid for pattern \"{pattern}\"",
                    parts=parts + (key,),
                )
        for key in sorted(PATTERN_REQUIRED[pattern] - set(raw)):
            self.v.add(json_pointer(*parts, key), f"field \"{key}\" is required for pattern \"{pattern}\"", parts=parts + (key,))

        if "diameter" in raw:
            num = self.number(raw["diameter"], parts + ("diameter",), what="diameter", positive=True)
            if num is not None:
                params["diameter"] = num
        params["through"] = self.boolean(raw.get("through"), parts + ("through",), what="through", default=True)
        if "depth" in raw:
            depth = self.number(raw["depth"], parts + ("depth",), what="depth", positive=True)
            if depth is not None:
                params["depth"] = depth
        elif params["through"] is False:
            self.v.add(json_pointer(*parts, "depth"), "depth is required when through is false", parts=parts + ("depth",))

        if pattern == "rect_corners":
            if "inset" in raw:
                inset = self.number(raw["inset"], parts + ("inset",), what="inset", non_negative=True)
                if inset is not None:
                    params["inset"] = inset
            if "span" in raw:
                span = self.number_tuple(raw["span"], parts + ("span",), what="span", lengths=(2,), positive=True)
                if span is not None:
                    params["span"] = span
                    inset = params.get("inset")
                    if inset is not None and not (2.0 * inset < min(span)):
                        self.v.add(
                            json_pointer(*parts, "inset"),
                            f"inset {inset:g} leaves no material in span {list(span)}; require 2*inset < min(span)",
                            parts=parts + ("inset",),
                        )
        elif pattern == "grid":
            if "count" in raw:
                count = self._int_tuple(raw["count"], parts + ("count",), what="count", low=2, high=10)
                if count is not None:
                    params["count"] = count
            if "spacing" in raw:
                spacing = self.number_tuple(raw["spacing"], parts + ("spacing",), what="spacing", lengths=(2,), positive=True)
                if spacing is not None:
                    params["spacing"] = spacing
            if "center" in raw:
                center = self.number_tuple(raw["center"], parts + ("center",), what="center", lengths=(2,))
                if center is not None:
                    params["center"] = center
            else:
                params["center"] = (0.0, 0.0)
        elif pattern == "bolt_circle":
            if "count" in raw:
                count = self.number(raw["count"], parts + ("count",), what="count", integer=True, min_value=3, max_value=24)
                if count is not None:
                    params["count"] = int(count)
            if "pitch_diameter" in raw:
                pitch = self.number(raw["pitch_diameter"], parts + ("pitch_diameter",), what="pitch_diameter", positive=True)
                if pitch is not None:
                    params["pitch_diameter"] = pitch
            if "center" in raw:
                center = self.number_tuple(raw["center"], parts + ("center",), what="center", lengths=(2,))
                if center is not None:
                    params["center"] = center
            else:
                params["center"] = (0.0, 0.0)

    def _op_fillet(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        if "radius" in raw:
            num = self.number(raw["radius"], parts + ("radius",), what="radius", positive=True)
            if num is not None:
                params["radius"] = num
        params["target"] = self.enum(raw.get("target"), EDGE_TARGETS, parts + ("target",), what="target", default="vertical_edges")

    def _op_chamfer(self, raw: Mapping[str, Any], parts: tuple[object, ...], params: dict[str, Any]) -> None:
        if "distance" in raw:
            num = self.number(raw["distance"], parts + ("distance",), what="distance", positive=True)
            if num is not None:
                params["distance"] = num
        params["target"] = self.enum(raw.get("target"), EDGE_TARGETS, parts + ("target",), what="target", default="vertical_edges")

    def _int_tuple(self, value: Any, parts: tuple[object, ...], *, what: str, low: int, high: int) -> tuple[int, int] | None:
        path = json_pointer(*parts)
        if not isinstance(value, (list, tuple)):
            self.v.add(path, f"{what} must be an array of two integers", parts=parts)
            return None
        if len(value) != 2:
            self.v.add(path, f"{what} must contain exactly 2 integers, got {len(value)}", parts=parts)
            return None
        out: list[int] = []
        for i, item in enumerate(value):
            num = self.number(item, parts + (i,), what=f"{what}[{i}]", integer=True, min_value=low, max_value=high)
            if num is None:
                return None
            out.append(int(num))
        return (out[0], out[1])

    def _primitive(self, raw: Any, parts: tuple[object, ...], *, required: bool) -> dict[str, Any] | None:
        path = json_pointer(*parts)
        if raw is None:
            if required:
                self.v.add(path, "shape is required", parts=parts)
            return None
        if not isinstance(raw, dict):
            self.v.add(path, f"shape must be an object, got {type(raw).__name__}", parts=parts)
            return None
        allowed = frozenset({"op", "length", "width", "height", "diameter", "center", "axis"})
        for key in raw:
            if key not in allowed:
                self.v.add(json_pointer(*parts, key), f"unknown field \"{key}\" on shape", parts=parts + (key,))
        op = raw.get("op")
        if not isinstance(op, str) or op not in PRIMITIVE_OPS:
            self.v.add(
                json_pointer(*parts, "op"),
                f"shape op must be one of {sorted(PRIMITIVE_OPS)}, got {_fmt(op)}",
                parts=parts + ("op",),
            )
            return None
        out: dict[str, Any] = {"op": op}
        if op == "box":
            for key in ("length", "width", "height"):
                if key not in raw:
                    self.v.add(json_pointer(*parts, key), f"field \"{key}\" is required for shape op \"box\"", parts=parts + (key,))
                    continue
                num = self.number(raw[key], parts + (key,), what=key, positive=True)
                if num is not None:
                    out[key] = num
            if "diameter" in raw:
                self.v.add(json_pointer(*parts, "diameter"), "field \"diameter\" is not valid for shape op \"box\"", parts=parts + ("diameter",))
        else:
            for key in ("diameter", "height"):
                if key not in raw:
                    self.v.add(json_pointer(*parts, key), f"field \"{key}\" is required for shape op \"cylinder\"", parts=parts + (key,))
                    continue
                num = self.number(raw[key], parts + (key,), what=key, positive=True)
                if num is not None:
                    out[key] = num
            for key in ("length", "width"):
                if key in raw:
                    self.v.add(json_pointer(*parts, key), f"field \"{key}\" is not valid for shape op \"cylinder\"", parts=parts + (key,))
            out["axis"] = self.enum(raw.get("axis"), HOLE_AXES, parts + ("axis",), what="axis", default="z")
        if "center" in raw:
            center = self.number_tuple(raw["center"], parts + ("center",), what="center", lengths=(2, 3))
            if center is not None:
                out["center"] = center
        return out


def validate_document(raw: Any, *, limits: Mapping[str, Any] | None = None) -> CadDocument:
    """Validate a raw document, returning the resolved document or raising.

    Raises:
        CadRuntimeError: code ``invalid_document`` with ``details.path`` (RFC 6901
            pointer) and ``details.violations`` describing every problem found.
    """
    return _Validator(raw, limits).document()
