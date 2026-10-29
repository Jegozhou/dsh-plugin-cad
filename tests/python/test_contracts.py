"""Cross-language contract tests: Python constants must mirror protocol.js.

``src/contracts/protocol.js`` is the single source of truth for the wire
constants. This module parses the JavaScript source and asserts the Python
mirror agrees, including the ``runtime.hello`` capabilities payload.
"""

from __future__ import annotations

import re
from pathlib import Path

from cad_runtime import protocol
from helpers import CONTRACTS_DIR, RuntimeClient

PROTOCOL_JS = CONTRACTS_DIR / "protocol.js"


def _js_text() -> str:
    return PROTOCOL_JS.read_text(encoding="utf-8")


def _string_constant(source: str, name: str) -> str:
    match = re.search(rf"export const {name} = '([^']*)'", source)
    assert match, f"{name} not found in protocol.js"
    return match.group(1)


def _frozen_map(source: str, name: str) -> dict[str, str]:
    block = re.search(rf"export const {name} = Object\.freeze\(\{{(.*?)\}}\)", source, re.S)
    assert block, f"{name} not found in protocol.js"
    return dict(re.findall(r"(\w+):\s*'([^']*)'", block.group(1)))


def _frozen_array(source: str, name: str) -> list[str]:
    block = re.search(rf"export const {name} = Object\.freeze\(\[(.*?)\]\)", source, re.S)
    assert block, f"{name} not found in protocol.js"
    return re.findall(r"'([^']*)'", block.group(1))


def test_protocol_js_exists() -> None:
    assert PROTOCOL_JS.is_file(), f"missing {PROTOCOL_JS}"


def test_version_and_schema_match() -> None:
    source = _js_text()
    assert protocol.PROTOCOL_VERSION == _string_constant(source, "PROTOCOL_VERSION")
    assert protocol.DOCUMENT_SCHEMA == _string_constant(source, "DOCUMENT_SCHEMA")
    expression = re.search(r"MAX_FRAME_BYTES = ([0-9*\s]+)", source).group(1)
    # safe arithmetic-only evaluation of the JavaScript constant "8 * 1024 * 1024"
    expected = 1
    for factor in expression.split("*"):
        expected *= int(factor.strip())
    assert protocol.MAX_FRAME_BYTES == expected


def test_methods_match() -> None:
    assert dict(protocol.METHODS) == _frozen_map(_js_text(), "METHODS")


def test_notifications_match() -> None:
    assert dict(protocol.NOTIFICATIONS) == _frozen_map(_js_text(), "NOTIFICATIONS")


def test_error_codes_match() -> None:
    assert dict(protocol.ERROR_CODES) == _frozen_map(_js_text(), "ERROR_CODES")


def test_export_formats_match() -> None:
    assert list(protocol.EXPORT_FORMATS) == _frozen_array(_js_text(), "EXPORT_FORMATS")


def test_check_ids_are_the_spec_set() -> None:
    assert list(protocol.CHECK_IDS) == [
        "document_schema",
        "single_solid",
        "brep_valid",
        "positive_volume",
        "closed_shell",
        "bounding_box",
        "feature_effects",
        "wall_thickness",
    ]


def test_artifact_filenames_are_pinned() -> None:
    # The Host serves model.glb and the acceptance verifier expects these names.
    assert dict(protocol.ARTIFACT_FILENAMES) == {
        "step": "model.step",
        "glb": "model.glb",
        "stl": "model.stl",
        "svg": "preview.svg",
    }
    assert dict(protocol.ARTIFACT_CONTENT_TYPES)["glb"] == "model/gltf-binary"


def test_hello_over_the_real_protocol_matches_contract() -> None:
    with RuntimeClient() as client:
        result = client.hello["result"]
        assert result["protocolVersion"] == protocol.PROTOCOL_VERSION
        runtime = result["runtime"]
        assert runtime["name"] == protocol.RUNTIME_NAME
        assert runtime["python"]
        assert runtime["pythonPath"].endswith("python")
        assert runtime["build123d"], "hello must report the build123d version"
        assert runtime["ocp"], "hello must report the OCP/OCCT version"
        assert runtime["trimesh"] and runtime["numpy"]
        capabilities = result["capabilities"]
        assert capabilities["formats"] == list(protocol.RUNTIME_FORMATS)
        assert capabilities["checks"] == list(protocol.CHECK_IDS)
        assert capabilities["previewViews"] == list(protocol.PREVIEW_VIEWS)

        mismatch = client.request("runtime.hello", {"protocolVersion": "9.9"})
        assert mismatch["error"]["data"]["code"] == protocol.ERROR_CODES["versionMismatch"]
        assert mismatch["error"]["data"]["details"]["expected"] == protocol.PROTOCOL_VERSION
        assert mismatch["error"]["data"]["details"]["received"] == "9.9"
