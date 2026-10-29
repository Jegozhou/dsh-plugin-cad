"""Feature catalogue tests: real geometry for every operation in SPEC §3.1."""

from __future__ import annotations

import math

from cad_runtime.document import validate_document
from cad_runtime.geometry import build_geometry, cylindrical_face_radii
from helpers import build_in_process

PLATE_VOLUME = 80.0 * 60.0 * 8.0


def _outcome(document):
    return build_geometry(validate_document(document))


def _doc(features, parameters=None):
    return {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": parameters or {},
        "features": features,
    }


def test_fillet_vertical_edges_rounds_and_reduces_volume() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "f", "op": "fillet", "radius": 6, "target": "vertical_edges"}])
    )
    assert outcome.error is None, outcome.error
    assert outcome.report["valid"]
    assert outcome.report["volume"] < PLATE_VOLUME
    # four rounded corners -> four cylindrical faces of radius 6
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 6.0, abs_tol=1e-6)) == 4
    assert outcome.report["topology"]["solids"] == 1


def test_fillet_top_edges_and_all_edges() -> None:
    for target in ("top_edges", "bottom_edges", "all_edges"):
        outcome = _outcome(
            _doc([{"id": "base", "op": "box", "length": 40, "width": 30, "height": 10},
                  {"id": "f", "op": "fillet", "radius": 2, "target": target}])
        )
        assert outcome.error is None, (target, outcome.error)
        assert outcome.report["valid"], (target, outcome.checks)
        assert outcome.report["volume"] < 40 * 30 * 10


def test_chamfer_vertical_edges() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "c", "op": "chamfer", "distance": 2, "target": "vertical_edges"}])
    )
    assert outcome.error is None, outcome.error
    # chamfer of the 4 vertical edges removes 4 * (1/2 * 2 * 2 * 8) = 64 mm^3
    assert math.isclose(outcome.report["volume"], PLATE_VOLUME - 64.0, rel_tol=1e-6)


def test_cut_box_through_plate() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "cut", "op": "cut", "shape": {"op": "box", "length": 20, "width": 20, "height": 20}}])
    )
    assert outcome.error is None, outcome.error
    assert math.isclose(outcome.report["volume"], PLATE_VOLUME - 20 * 20 * 8, rel_tol=1e-9)
    assert outcome.report["valid"]


def test_union_adds_material() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "boss", "op": "union",
               "shape": {"op": "cylinder", "diameter": 20, "height": 10, "center": [0, 0, 4]}}])
    )
    assert outcome.error is None, outcome.error
    assert outcome.report["valid"]
    assert outcome.report["topology"]["solids"] == 1
    # boss protrudes 5 mm above the plate: +pi*10^2*5
    assert math.isclose(outcome.report["volume"], PLATE_VOLUME + math.pi * 100 * 5, rel_tol=1e-6)


def test_blind_hole_from_top() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "h", "op": "hole", "diameter": 10, "at": [0, 0], "through": False, "depth": 4}])
    )
    assert outcome.error is None, outcome.error
    assert math.isclose(outcome.report["volume"], PLATE_VOLUME - math.pi * 25 * 4, rel_tol=1e-6)
    assert outcome.report["boundingBox"]["size"] == [80.0, 60.0, 8.0]
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 5.0, abs_tol=1e-6)) == 1


def test_hole_along_x_axis_and_at_mapping() -> None:
    # axis x: at = [y, z]. d6 keeps the tunnel inside the 8 mm plate thickness.
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "h", "op": "hole", "diameter": 6, "axis": "x", "at": [10, 0.5], "through": True}])
    )
    assert outcome.error is None, outcome.error
    assert math.isclose(outcome.report["volume"], PLATE_VOLUME - math.pi * 9 * 80, rel_tol=1e-9)
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 3.0, abs_tol=1e-6)) == 1


def test_grid_hole_pattern() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 100, "width": 100, "height": 10},
              {"id": "grid", "op": "hole_pattern", "pattern": "grid", "diameter": 4,
               "count": [3, 3], "spacing": [20, 20], "through": True}])
    )
    assert outcome.error is None, outcome.error
    expected = 100 * 100 * 10 - 9 * math.pi * 4 * 10
    assert math.isclose(outcome.report["volume"], expected, rel_tol=1e-9)
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 2.0, abs_tol=1e-6)) == 9


def test_bolt_circle_hole_pattern() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 120, "width": 120, "height": 10},
              {"id": "bolt", "op": "hole_pattern", "pattern": "bolt_circle", "diameter": 5,
               "count": 6, "pitch_diameter": 80, "through": True}])
    )
    assert outcome.error is None, outcome.error
    expected = 120 * 120 * 10 - 6 * math.pi * 6.25 * 10
    assert math.isclose(outcome.report["volume"], expected, rel_tol=1e-9)
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 2.5, abs_tol=1e-6)) == 6


def test_rect_corners_without_span_uses_current_bbox() -> None:
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 80, "width": 60, "height": 8},
              {"id": "corners", "op": "hole_pattern", "pattern": "rect_corners",
               "diameter": 6, "inset": 12, "through": True}])
    )
    assert outcome.error is None, outcome.error
    expected = 80 * 60 * 8 - 4 * math.pi * 9 * 8  # four Ø6 holes, no centre hole
    assert math.isclose(outcome.report["volume"], expected, rel_tol=1e-9)
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 3.0, abs_tol=1e-6)) == 4


def test_cylinder_primitive_with_x_axis() -> None:
    outcome = _outcome(
        _doc([{"id": "rod", "op": "cylinder", "diameter": 10, "height": 30, "axis": "x"}])
    )
    assert outcome.error is None, outcome.error
    assert outcome.report["topology"]["solids"] == 1
    size = outcome.report["boundingBox"]["size"]
    assert math.isclose(size[0], 30.0, abs_tol=1e-6)
    assert math.isclose(size[1], 10.0, abs_tol=1e-6)
    assert math.isclose(size[2], 10.0, abs_tol=1e-6)


def test_fillet_radius_too_large_is_a_structured_failure(tmp_path) -> None:
    document = _doc([{"id": "base", "op": "box", "length": 20, "width": 20, "height": 5},
                     {"id": "f", "op": "fillet", "radius": 500, "target": "vertical_edges"}])
    result = build_in_process(document, tmp_path)
    assert result["status"] == "failed"
    assert result["error"]["code"] == "invalid_geometry"
    assert result["error"]["details"]["featureId"] == "f"
    assert [feature["status"] for feature in result["report"]["featureReports"]] == ["pass", "fail"]


def test_hole_outside_material_is_caught_by_feature_effects(tmp_path) -> None:
    document = _doc([{"id": "base", "op": "box", "length": 20, "width": 20, "height": 5},
                     {"id": "missing", "op": "hole", "diameter": 4, "at": [500, 500]}])
    result = build_in_process(document, tmp_path)
    assert result["status"] == "failed"
    failing = [check for check in result["report"]["checks"] if check["status"] == "fail"]
    assert [check["id"] for check in failing] == ["feature_effects"]


def test_union_absorbed_primitive_is_caught(tmp_path) -> None:
    # A union primitive fully inside the body changes nothing: feature_effects fails.
    document = _doc([{"id": "base", "op": "box", "length": 40, "width": 40, "height": 10},
                     {"id": "noop", "op": "union",
                      "shape": {"op": "box", "length": 2, "width": 2, "height": 2}}])
    result = build_in_process(document, tmp_path)
    assert result["status"] == "failed"
    assert any(check["id"] == "feature_effects" and check["status"] == "fail" for check in result["report"]["checks"])


def test_wall_thickness_warns_on_thin_material() -> None:
    # Ø19.8 hole in a 20 mm plate -> 0.1 mm wall, below the 0.2 mm heuristic.
    outcome = _outcome(
        _doc([{"id": "base", "op": "box", "length": 20, "width": 20, "height": 5},
              {"id": "h", "op": "hole", "diameter": 19.8, "at": [0, 0], "through": True}])
    )
    wall = [check for check in outcome.checks if check["id"] == "wall_thickness"][0]
    assert wall["status"] == "warn"
    assert outcome.report["valid"] is True
    assert outcome.report["warnings"]
