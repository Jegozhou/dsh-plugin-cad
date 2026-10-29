"""Artifact safety: confinement, atomicity, no overwrite, stale temp cleanup."""

from __future__ import annotations

import os

import pytest

from cad_runtime import builder
from cad_runtime.errors import CadRuntimeError
from helpers import bracket_document, build_in_process, sha256_file


def test_output_dir_is_created_and_confined(tmp_path) -> None:
    nested = tmp_path / "models" / "m-1" / "revisions" / "r-0001"
    assert not nested.exists()
    result = build_in_process(bracket_document(), nested)
    assert result["status"] == "built"
    assert nested.is_dir()
    names = sorted(path.name for path in nested.iterdir())
    assert names == ["model.glb", "model.step"]
    for name in names:
        path = nested / name
        assert path.is_file() and not path.is_symlink()


def test_relative_output_dir_is_rejected() -> None:
    with pytest.raises(CadRuntimeError) as info:
        builder.run_build({"document": bracket_document(), "outputDir": "relative/dir", "formats": ["glb"]})
    assert info.value.code == "invalid_argument"
    assert info.value.details["path"] == "/outputDir"


def test_missing_output_dir_is_rejected(tmp_path) -> None:
    with pytest.raises(CadRuntimeError) as info:
        builder.run_build({"document": bracket_document(), "formats": ["glb"]})
    assert info.value.code == "invalid_argument"


def test_output_dir_that_is_a_file_is_rejected(tmp_path) -> None:
    file_path = tmp_path / "not-a-dir"
    file_path.write_text("x")
    with pytest.raises(CadRuntimeError) as info:
        builder.run_build({"document": bracket_document(), "outputDir": str(file_path), "formats": ["glb"]})
    assert info.value.code == "invalid_argument"


def test_existing_artifact_is_never_overwritten(tmp_path) -> None:
    existing = tmp_path / "model.step"
    existing.write_bytes(b"do-not-touch")
    result = build_in_process(bracket_document(), tmp_path, formats=("step",))
    assert result["status"] == "failed"
    assert result["error"]["code"] == "export_failed"
    assert result["error"]["details"]["reason"] == "artifact_exists"
    assert result["artifacts"] == []
    assert existing.read_bytes() == b"do-not-touch", "existing artifact must be byte-for-byte untouched"
    assert [path.name for path in tmp_path.iterdir()] == ["model.step"]
    assert not any(path.name.startswith(".dsh-cad-tmp-") for path in tmp_path.iterdir())


def test_existing_artifact_blocks_the_whole_build(tmp_path) -> None:
    (tmp_path / "model.glb").write_bytes(b"existing-glb")
    result = build_in_process(bracket_document(), tmp_path, formats=("step", "glb"))
    assert result["status"] == "failed"
    assert result["error"]["code"] == "export_failed"
    assert result["artifacts"] == []
    # step was written before the glb collision: the runtime removed it again
    assert [path.name for path in tmp_path.iterdir()] == ["model.glb"]


def test_symlinked_artifact_is_refused(tmp_path) -> None:
    outside = tmp_path / "outside-target.bin"
    outside.write_bytes(b"outside")
    symlink = tmp_path / "model.glb"
    os.symlink(outside, symlink)
    result = build_in_process(bracket_document(), tmp_path, formats=("glb",))
    assert result["status"] == "failed"
    assert result["error"]["code"] == "export_failed"
    assert symlink.is_symlink()
    assert outside.read_bytes() == b"outside", "the runtime must not write through a symlink"
    assert result["artifacts"] == []


def test_stale_temp_files_are_swept(tmp_path) -> None:
    stale = tmp_path / ".dsh-cad-tmp-crashed.step"
    stale.write_bytes(b"partial garbage from a SIGKILL")
    result = build_in_process(bracket_document(), tmp_path)
    assert result["status"] == "built"
    assert not stale.exists(), "the next build must sweep stale temp files"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["model.glb", "model.step"]


def test_declared_sha256_matches_committed_bytes(tmp_path) -> None:
    result = build_in_process(bracket_document(), tmp_path, formats=("step", "glb"))
    assert result["status"] == "built"
    for artifact in result["artifacts"]:
        path = tmp_path / artifact["fileName"]
        assert artifact["bytes"] == os.path.getsize(path)
        assert artifact["sha256"] == sha256_file(path)
        assert artifact["sha256"] == artifact["sha256"].lower()


def test_max_artifact_bytes_limit_is_enforced(tmp_path) -> None:
    document = bracket_document()
    result = builder.run_build(
        {
            "requestId": "tiny-limit",
            "document": document,
            "outputDir": str(tmp_path),
            "formats": ["step"],
            "limits": {"maxArtifactBytes": 128},
        }
    )
    assert result["status"] == "failed"
    assert result["error"]["code"] == "export_failed"
    assert result["error"]["details"]["reason"] == "artifact_too_large"
    assert not list(tmp_path.iterdir())
