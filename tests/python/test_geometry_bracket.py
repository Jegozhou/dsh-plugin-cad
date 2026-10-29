"""Real geometry tests for the acceptance bracket (SPEC_P0.md §1/§5).

Every assertion is against measured B-rep data: bounding box, analytic volume
within 0.5 %, hole detection via cylindrical-face radii, topology and the eight
geometry checks.
"""

from __future__ import annotations

import math

from cad_runtime import builder
from cad_runtime.document import validate_document
from cad_runtime.geometry import build_geometry, cylindrical_face_radii
from cad_runtime.protocol import CHECK_IDS
from helpers import bracket_document, bracket_volume, build_in_process


def _bracket_outcome(**document_kwargs):
    document = validate_document(bracket_document(**document_kwargs))
    return build_geometry(document)


def test_bracket_is_a_valid_single_solid_with_expected_bbox() -> None:
    outcome = _bracket_outcome()
    assert outcome.error is None, outcome.error
    report = outcome.report
    assert report["valid"] is True
    assert report["topology"]["solids"] == 1
    assert report["topology"]["faces"] == 11
    assert report["topology"]["edges"] == 27
    assert report["topology"]["vertices"] == 18
    bbox = report["boundingBox"]
    assert bbox["size"] == [80.0, 60.0, 8.0]
    assert bbox["min"] == [-40.0, -30.0, -4.0]
    assert bbox["max"] == [40.0, 30.0, 4.0]
    assert report["centroid"] == [0.0, 0.0, 0.0]


def test_bracket_volume_matches_analytic_within_half_a_percent() -> None:
    outcome = _bracket_outcome()
    expected = bracket_volume()
    # 80*60*8 - pi*100*8 - 4*pi*9*8
    assert math.isclose(expected, 34981.947192894295, rel_tol=1e-12)
    measured = outcome.report["volume"]
    relative_error = abs(measured - expected) / expected
    assert relative_error < 0.005, f"volume {measured} vs analytic {expected} ({relative_error:.4%})"
    assert math.isclose(measured, expected, rel_tol=1e-9)


def test_bracket_holes_are_detected_as_cylindrical_faces() -> None:
    outcome = _bracket_outcome()
    radii = cylindrical_face_radii(outcome.shape)
    # One Ø20 centre hole and four Ø6 corner holes -> radii 10 and 3 (x4).
    assert len(radii) == 5, radii
    assert sum(1 for r in radii if math.isclose(r, 10.0, abs_tol=1e-6)) == 1
    assert sum(1 for r in radii if math.isclose(r, 3.0, abs_tol=1e-6)) == 4
    # Surface area confirms the through-hole walls exist:
    # 2*(80*60) - 2*(pi*100 + 4*pi*9) + 2*(80+60)*8 + 2*pi*10*8 + 4*2*pi*3*8
    expected_area = (
        2 * (80 * 60)
        - 2 * (math.pi * 100 + 4 * math.pi * 9)
        + 2 * (80 + 60) * 8
        + 2 * math.pi * 10 * 8
        + 4 * 2 * math.pi * 3 * 8
    )
    assert math.isclose(outcome.report["surfaceArea"], expected_area, rel_tol=1e-6)


def test_bracket_all_checks_pass() -> None:
    outcome = _bracket_outcome()
    assert [check["id"] for check in outcome.checks] == list(CHECK_IDS)
    assert all(check["status"] in ("pass", "warn") for check in outcome.checks), outcome.checks
    assert outcome.report["warnings"] == []


def test_parameter_edit_variant_rebuilds_the_part() -> None:
    # Same features, changed parameters (the normal cad_modify_model path).
    outcome = _bracket_outcome(length=90.0, width=70.0, thickness=10.0)
    assert outcome.error is None
    report = outcome.report
    assert report["boundingBox"]["size"] == [90.0, 70.0, 10.0]
    expected = bracket_volume(length=90.0, width=70.0, thickness=10.0)
    assert math.isclose(report["volume"], expected, rel_tol=0.005)
    radii = cylindrical_face_radii(outcome.shape)
    assert sum(1 for r in radii if math.isclose(r, 10.0, abs_tol=1e-6)) == 1
    assert sum(1 for r in radii if math.isclose(r, 3.0, abs_tol=1e-6)) == 4


def test_parameter_edit_that_makes_corner_holes_outside_is_rejected(tmp_path) -> None:
    # Shrinking the plate below 2*inset is rejected structurally before geometry.
    import pytest

    from cad_runtime.errors import CadRuntimeError

    document = bracket_document(length=20.0, width=20.0)
    with pytest.raises(CadRuntimeError) as info:
        build_in_process(document, tmp_path, formats=("step",))
    assert info.value.code == "invalid_document"
    assert info.value.details["path"] == "/features/2/inset"
    assert not tmp_path.exists() or not list(tmp_path.iterdir())


def test_union_disjoint_body_fails_single_solid(tmp_path) -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": 20, "width": 20, "height": 5},
            {"id": "island", "op": "union", "shape": {"op": "box", "length": 5, "width": 5, "height": 5, "center": [100, 0, 0]}},
        ],
    }
    result = build_in_process(document, tmp_path)
    assert result["status"] == "failed"
    failed = [check["id"] for check in result["report"]["checks"] if check["status"] == "fail"]
    assert "single_solid" in failed


def test_bounding_box_limit_is_enforced(tmp_path) -> None:
    document = {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [{"id": "base", "op": "box", "length": 500, "width": 10, "height": 10}],
    }
    result = builder.run_build(
        {"requestId": "limit", "document": document, "outputDir": str(tmp_path), "formats": ["step"],
         "limits": {"maxBoundingBoxMm": 100}}
    )
    assert result["status"] == "failed"
    failing = [check for check in result["report"]["checks"] if check["id"] == "bounding_box"]
    assert failing and failing[0]["status"] == "fail"


def test_report_timings_are_present_and_finite(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path)
    timings = result["report"]["timings"]
    assert set(timings) >= {"totalMs", "buildMs", "exportMs"}
    assert all(isinstance(value, (int, float)) and math.isfinite(value) for value in timings.values())
    assert timings["buildMs"] > 0
    assert timings["totalMs"] >= timings["buildMs"]
