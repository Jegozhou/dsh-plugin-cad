"""Installer/pins tests: python/setup-runtime.mjs and the pinned environment."""

from __future__ import annotations

import json
import shutil
import subprocess
from importlib import metadata

import pytest

from helpers import PYTHON_DIR, VENV_PYTHON, venv_python

SETUP = PYTHON_DIR / "setup-runtime.mjs"
REQUIREMENTS = PYTHON_DIR / "requirements.txt"
LOCK = PYTHON_DIR / "requirements.lock.txt"


def _pins() -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, version = line.partition("==")
        if name and version:
            pins[name] = version
    return pins


def test_requirements_are_exactly_pinned_and_installed() -> None:
    venv_python()  # skip cleanly when the venv is missing
    pins = _pins()
    assert pins == {"build123d": "0.13.0", "trimesh": "5.2.0", "numpy": "2.5.4"}
    for name, version in pins.items():
        assert metadata.version(name) == version, f"{name} is {metadata.version(name)}, pinned {version}"


def test_requirements_lock_covers_the_direct_dependencies() -> None:
    lock = LOCK.read_text(encoding="utf-8")
    assert "build123d==0.13.0" in lock
    assert "trimesh==5.2.0" in lock
    assert "numpy==2.5.4" in lock
    assert "cadquery-ocp-novtk==8.0.1.1.0" in lock, "the OpenCASCADE wheel must be locked"


def test_setup_runtime_script_exists_and_parses() -> None:
    assert SETUP.is_file()
    assert "machine-readable" in SETUP.read_text(encoding="utf-8").lower() or "JSON" in SETUP.read_text(encoding="utf-8")
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available")
    result = subprocess.run([node, "--check", str(SETUP)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _run_check() -> dict:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available")
    venv_python()  # skip when the runtime is not installed
    result = subprocess.run(
        [node, str(SETUP), "--check"],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(PYTHON_DIR.parent),
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, f"installer must print exactly one JSON object on stdout, got {len(lines)} lines: {lines[:3]}"
    payload = json.loads(lines[0])
    payload["_exitCode"] = result.returncode
    return payload


def test_installer_check_reports_a_healthy_runtime() -> None:
    payload = _run_check()
    assert payload["_exitCode"] == 0
    assert payload["ok"] is True
    assert payload["action"] == "check"
    assert payload["venv"] == str(PYTHON_DIR / ".venv")
    installed = payload["installed"]
    assert installed["build123d"] == "0.13.0"
    assert installed["trimesh"] == "5.2.0"
    assert installed["numpy"] == "2.5.4"


def test_installer_check_is_idempotent() -> None:
    first = _run_check()
    second = _run_check()
    assert first["ok"] is True and second["ok"] is True
    assert first["created"] is False and second["created"] is False
