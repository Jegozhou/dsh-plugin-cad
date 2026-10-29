"""Artifact tests: real STEP/GLB/STL/SVG files with verified headers, sha256 and geometry."""

from __future__ import annotations

import math
import struct

import pytest

from helpers import (
    assert_valid_glb,
    bracket_document,
    build_in_process,
    glb_bbox,
    glb_mesh,
    parse_glb,
    sha256_file,
    step_volume,
)


def test_build_writes_all_four_artifacts_with_truthful_bytes_and_sha(tmp_path) -> None:
    document = bracket_document()
    result = build_in_process(
        document, tmp_path, formats=("step", "glb", "stl", "svg"), preview={"view": "iso", "width": 800, "height": 600}
    )
    assert result["status"] == "built", result.get("error")
    assert [artifact["format"] for artifact in result["artifacts"]] == ["step", "glb", "stl", "svg"]
    expected_files = {"model.step", "model.glb", "model.stl", "preview.svg"}
    assert {path.name for path in tmp_path.iterdir()} == expected_files
    for artifact in result["artifacts"]:
        path = tmp_path / artifact["fileName"]
        assert path.is_file() and not path.is_symlink()
        assert artifact["bytes"] == path.stat().st_size
        assert artifact["sha256"] == sha256_file(path)
        assert len(artifact["sha256"]) == 64 and artifact["sha256"].islower()
        assert artifact["contentType"] == {
            "step": "application/step",
            "glb": "model/gltf-binary",
            "stl": "model/stl",
            "svg": "image/svg+xml",
        }[artifact["format"]]


def test_step_roundtrips_with_the_same_volume(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path, formats=("step",))
    assert result["status"] == "built"
    step = tmp_path / "model.step"
    data = step.read_bytes()
    assert data.startswith(b"ISO-10303-21"), "STEP must be an ISO-10303-21 exchange file"
    assert b"DATA;" in data and b"END-ISO-10303-21;" in data
    reimported = step_volume(step)
    report_volume = result["report"]["volume"]
    assert math.isclose(reimported, report_volume, rel_tol=1e-9), (reimported, report_volume)
    # and it is the analytic acceptance volume
    assert math.isclose(reimported, 34981.947192894295, rel_tol=1e-9)


def test_glb_is_valid_gltf2_watertight_and_y_up(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path, formats=("glb",))
    assert result["status"] == "built"
    data = (tmp_path / "model.glb").read_bytes()
    parsed = assert_valid_glb(data)
    document = parsed["json"]
    assert document["asset"]["version"] == "2.0"
    assert document["scenes"] and document["meshes"]
    # one mesh, one primitive, POSITION + NORMAL attributes
    attributes = document["meshes"][0]["primitives"][0]["attributes"]
    assert "POSITION" in attributes and "NORMAL" in attributes
    position_accessor = document["accessors"][attributes["POSITION"]]
    assert position_accessor["type"] == "VEC3"
    assert position_accessor["count"] > 0

    # CAD bbox is [-40,-30,-4]..[40,30,4]; glTF is Y-up -> min [-40,-4,-30], max [40,4,30]
    position_min, position_max = glb_bbox(parsed)
    assert position_min == pytest.approx([-40.0, -4.0, -30.0], abs=1e-3)
    assert position_max == pytest.approx([40.0, 4.0, 30.0], abs=1e-3)

    # the exported mesh is watertight (closed shell) when loaded back
    mesh = glb_mesh(data)
    assert mesh.is_watertight
    assert len(mesh.faces) > 100
    assert math.isclose(mesh.volume, result["report"]["volume"], rel_tol=0.005)


def test_stl_is_binary_and_has_a_triangle_count(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path, formats=("stl",))
    assert result["status"] == "built"
    data = (tmp_path / "model.stl").read_bytes()
    assert len(data) > 84
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    assert triangle_count > 100
    assert len(data) == 84 + 50 * triangle_count


def test_svg_preview_has_hidden_lines_and_requested_pixel_size(tmp_path) -> None:
    result = build_in_process(
        bracket_document(), tmp_path, formats=("svg",), preview={"view": "iso", "width": 800, "height": 600}
    )
    assert result["status"] == "built"
    text = (tmp_path / "preview.svg").read_text(encoding="utf-8")
    assert "<svg" in text and "</svg>" in text
    assert 'viewBox="' in text
    assert 'width="800"' in text and 'height="600"' in text
    assert text.count("<path") >= 10, "hidden-line projection should emit many path elements"
    assert "stroke-dasharray" in text, "hidden edges must be dashed"


def test_each_preview_view_renders_and_they_differ(tmp_path) -> None:
    contents = {}
    for view in ("iso", "front", "top", "right"):
        out = tmp_path / view
        result = build_in_process(
            bracket_document(), out, formats=("svg",), preview={"view": view, "width": 640, "height": 480}
        )
        assert result["status"] == "built", (view, result.get("error"))
        contents[view] = (out / "preview.svg").read_bytes()
    assert len({value for value in contents.values()}) == 4, "each view must be a distinct projection"


def test_only_requested_formats_are_written(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path, formats=("glb",))
    assert result["status"] == "built"
    assert [path.name for path in tmp_path.iterdir()] == ["model.glb"]
    assert result["report"]["mesh"]["watertight"] is True


def test_step_and_glb_are_the_default_formats(tmp_path) -> None:
    import os

    from cad_runtime import builder

    result = builder.run_build({"requestId": "default", "document": bracket_document(), "outputDir": str(tmp_path)})
    assert result["status"] == "built"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["model.glb", "model.step"]
    assert [artifact["format"] for artifact in result["artifacts"]] == ["step", "glb"]
