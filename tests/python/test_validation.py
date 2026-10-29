"""Structural validation tests: accept the good document, reject every bad one.

Every rejection must be ``invalid_document`` with an RFC 6901 JSON-pointer
``details.path``; there is no partial application.
"""

from __future__ import annotations

import copy

import pytest

from cad_runtime.document import validate_document
from cad_runtime.errors import CadRuntimeError
from helpers import bracket_document


def _expect_invalid(document, path_fragment: str) -> CadRuntimeError:
    with pytest.raises(CadRuntimeError) as info:
        validate_document(document)
    error = info.value
    assert error.code == "invalid_document", error
    assert isinstance(error.details.get("path"), str)
    assert path_fragment in error.details["path"], f"expected {path_fragment!r} in {error.details['path']!r}"
    assert error.details.get("violations"), "details.violations must list every problem"
    return error


# ---------------------------------------------------------------------------
# Acceptance
# ---------------------------------------------------------------------------


def test_accepts_acceptance_bracket() -> None:
    document = validate_document(bracket_document())
    assert document.schema == "dsh.cad/document@1"
    assert document.units == "mm"
    assert document.parameters == {"length": 80.0, "width": 60.0, "thickness": 8.0}
    assert [feature.id for feature in document.features] == ["base", "center_hole", "corner_holes"]
    assert document.features[0].op == "box"
    assert document.features[1].params["at"] == (0.0, 0.0)
    assert document.features[2].params["pattern"] == "rect_corners"


def test_accepts_literal_numbers_and_optional_document_fields() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "name": "literal plate",
        "description": "no parameters at all",
        "features": [{"id": "base", "op": "box", "length": 20, "width": 10, "height": 2}],
    }
    validated = validate_document(document)
    assert validated.features[0].params == {"length": 20.0, "width": 10.0, "height": 2.0}
    assert validated.warnings == ()


def test_missing_schema_and_units_default_with_warnings() -> None:
    document = validate_document({"features": [{"id": "base", "op": "box", "length": 10, "width": 10, "height": 10}]})
    assert document.schema == "dsh.cad/document@1"
    assert document.units == "mm"
    assert len(document.warnings) == 2


# ---------------------------------------------------------------------------
# Document-level rejections
# ---------------------------------------------------------------------------


def test_rejects_non_object_document() -> None:
    _expect_invalid([], "")


def test_rejects_unknown_document_field() -> None:
    document = bracket_document()
    document["script"] = "import os"
    _expect_invalid(document, "/script")


def test_rejects_wrong_schema() -> None:
    document = bracket_document()
    document["schema"] = "dsh.cad/document@2"
    _expect_invalid(document, "/schema")


def test_rejects_wrong_units() -> None:
    document = bracket_document()
    document["units"] = "inch"
    _expect_invalid(document, "/units")


def test_rejects_missing_features() -> None:
    _expect_invalid({"schema": "dsh.cad/document@1", "units": "mm"}, "/features")


def test_rejects_empty_features() -> None:
    _expect_invalid({"schema": "dsh.cad/document@1", "units": "mm", "parameters": {}, "features": []}, "/features")


def test_rejects_too_many_features() -> None:
    features = [{"id": "base", "op": "box", "length": 10, "width": 10, "height": 10}]
    for index in range(64):
        features.append({"id": f"h{index}", "op": "hole", "diameter": 1, "at": [0, 0]})
    _expect_invalid({"schema": "dsh.cad/document@1", "units": "mm", "parameters": {}, "features": features}, "/features")


def test_rejects_too_many_parameters() -> None:
    parameters = {f"p{index}": 1.0 for index in range(65)}
    _expect_invalid(
        {"schema": "dsh.cad/document@1", "units": "mm", "parameters": parameters,
         "features": [{"id": "base", "op": "box", "length": 1, "width": 1, "height": 1}]},
        "/parameters",
    )


def test_rejects_invalid_parameter_names() -> None:
    document = bracket_document()
    document["parameters"] = {"9bad": 1.0}
    _expect_invalid(document, "/parameters/9bad")


def test_rejects_non_numeric_parameter() -> None:
    document = bracket_document()
    document["parameters"] = {"length": "eighty"}
    _expect_invalid(document, "/parameters/length")


def test_rejects_boolean_as_number() -> None:
    document = bracket_document()
    document["parameters"] = {"length": True}
    _expect_invalid(document, "/parameters/length")


def test_rejects_non_finite_parameter() -> None:
    document = bracket_document()
    document["parameters"] = {"length": float("inf")}
    _expect_invalid(document, "/parameters/length")


# ---------------------------------------------------------------------------
# Feature-level rejections
# ---------------------------------------------------------------------------


def test_rejects_non_object_feature() -> None:
    _expect_invalid(
        {"schema": "dsh.cad/document@1", "units": "mm", "parameters": {}, "features": ["box"]},
        "/features/0",
    )


def test_rejects_missing_feature_id() -> None:
    document = bracket_document()
    del document["features"][0]["id"]
    _expect_invalid(document, "/features/0/id")


def test_rejects_bad_feature_id() -> None:
    document = bracket_document()
    document["features"][0]["id"] = "bad id!"
    _expect_invalid(document, "/features/0/id")


def test_rejects_duplicate_feature_id() -> None:
    document = bracket_document()
    document["features"][2]["id"] = "center_hole"
    _expect_invalid(document, "/features/2/id")


def test_rejects_missing_op() -> None:
    document = bracket_document()
    del document["features"][0]["op"]
    _expect_invalid(document, "/features/0/op")


def test_rejects_unknown_op() -> None:
    document = bracket_document()
    document["features"][0]["op"] = "revolve"
    _expect_invalid(document, "/features/0/op")


def test_rejects_unknown_feature_field() -> None:
    document = bracket_document()
    document["features"][0]["fillet"] = 2
    _expect_invalid(document, "/features/0/fillet")


def test_rejects_python_expression_as_number() -> None:
    document = bracket_document()
    document["features"][0]["length"] = "80 + 10"
    _expect_invalid(document, "/features/0/length")


def test_rejects_unknown_parameter_reference() -> None:
    document = bracket_document()
    document["features"][0]["length"] = "$missing"
    _expect_invalid(document, "/features/0/length")


def test_rejects_negative_dimension() -> None:
    document = bracket_document()
    document["features"][0]["height"] = -8
    _expect_invalid(document, "/features/0/height")


def test_rejects_zero_dimension() -> None:
    document = bracket_document()
    document["features"][1]["diameter"] = 0
    _expect_invalid(document, "/features/1/diameter")


def test_rejects_first_feature_being_subtractive() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [{"id": "hole_first", "op": "hole", "diameter": 10, "at": [0, 0]}],
    }
    _expect_invalid(document, "/features/0/op")


def test_rejects_blind_hole_without_depth() -> None:
    document = bracket_document()
    document["features"][1]["through"] = False
    _expect_invalid(document, "/features/1/depth")


def test_accepts_blind_hole_with_depth() -> None:
    document = bracket_document()
    document["features"][1]["through"] = False
    document["features"][1]["depth"] = 4
    validated = validate_document(document)
    assert validated.features[1].params["depth"] == 4.0


def test_rejects_unknown_axis_and_face() -> None:
    document = bracket_document()
    document["features"][1]["axis"] = "w"
    _expect_invalid(document, "/features/1/axis")
    document = bracket_document()
    document["features"][1]["face"] = "left"
    _expect_invalid(document, "/features/1/face")


def test_rejects_unknown_pattern() -> None:
    document = bracket_document()
    document["features"][2]["pattern"] = "spiral"
    _expect_invalid(document, "/features/2/pattern")


def test_rejects_grid_count_out_of_range() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 100, "width": 100, "height": 10},
            {"id": "grid", "op": "hole_pattern", "pattern": "grid", "diameter": 4, "count": [1, 5], "spacing": [10, 10]},
        ],
    }
    _expect_invalid(document, "/features/1/count")


def test_rejects_grid_missing_spacing() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 100, "width": 100, "height": 10},
            {"id": "grid", "op": "hole_pattern", "pattern": "grid", "diameter": 4, "count": [3, 3]},
        ],
    }
    _expect_invalid(document, "/features/1/spacing")


def test_rejects_pattern_field_from_another_pattern() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 100, "width": 100, "height": 10},
            {"id": "grid", "op": "hole_pattern", "pattern": "grid", "diameter": 4, "count": [3, 3],
             "spacing": [10, 10], "inset": 5},
        ],
    }
    _expect_invalid(document, "/features/1/inset")


def test_rejects_bolt_circle_out_of_range() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 100, "width": 100, "height": 10},
            {"id": "bolt", "op": "hole_pattern", "pattern": "bolt_circle", "diameter": 5, "count": 2, "pitch_diameter": 50},
        ],
    }
    _expect_invalid(document, "/features/1/count")


def test_rejects_rect_corners_inset_leaving_no_material() -> None:
    document = bracket_document()
    document["features"][2]["inset"] = 40  # 2*40 >= 80 -> no material
    _expect_invalid(document, "/features/2/inset")


def test_rejects_fillet_without_radius() -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 20, "width": 20, "height": 10},
            {"id": "f", "op": "fillet", "target": "vertical_edges"},
        ],
    }
    _expect_invalid(document, "/features/1/radius")


def test_rejects_unknown_fillet_target() -> None:
    document = bracket_document()
    document["features"].append({"id": "f", "op": "fillet", "radius": 1, "target": "left_edges"})
    _expect_invalid(document, "/features/3/target")


def test_rejects_cut_without_shape() -> None:
    document = bracket_document()
    document["features"].append({"id": "c", "op": "cut"})
    _expect_invalid(document, "/features/3/shape")


def test_rejects_cut_with_bad_shape_op() -> None:
    document = bracket_document()
    document["features"].append({"id": "c", "op": "cut", "shape": {"op": "sphere", "diameter": 10}})
    _expect_invalid(document, "/features/3/shape/op")


def test_rejects_cut_shape_missing_required_field() -> None:
    document = bracket_document()
    document["features"].append({"id": "c", "op": "cut", "shape": {"op": "box", "length": 10, "width": 10}})
    _expect_invalid(document, "/features/3/shape/height")


def test_rejects_cut_shape_unknown_field() -> None:
    document = bracket_document()
    document["features"].append(
        {"id": "c", "op": "cut", "shape": {"op": "box", "length": 10, "width": 10, "height": 10, "id": "nested"}}
    )
    _expect_invalid(document, "/features/3/shape/id")


def test_reports_all_violations_not_just_the_first() -> None:
    document = bracket_document()
    document["features"][0]["length"] = -1
    document["features"][1]["diameter"] = 0
    document["features"][2]["diameter"] = -6
    with pytest.raises(CadRuntimeError) as info:
        validate_document(document)
    paths = [violation["path"] for violation in info.value.details["violations"]]
    assert "/features/0/length" in paths
    assert "/features/1/diameter" in paths
    assert "/features/2/diameter" in paths


def test_validation_does_not_mutate_the_input_document() -> None:
    document = bracket_document()
    snapshot = copy.deepcopy(document)
    validate_document(document)
    assert document == snapshot
