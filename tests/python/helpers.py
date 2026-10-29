"""Shared helpers for the Python runtime test suite.

These tests exercise the *real* runtime: real build123d/OpenCASCADE geometry, real
STEP/GLB/STL/SVG files and the real stdio JSON-RPC server as a child process.
Nothing is mocked.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[2]
PYTHON_DIR = ROOT / "python"
VENV_PYTHON = PYTHON_DIR / ".venv" / "bin" / "python"
CONTRACTS_DIR = ROOT / "src" / "contracts"


def venv_python() -> Path:
    if not VENV_PYTHON.exists():
        import pytest

        pytest.skip(f"python runtime venv not installed at {VENV_PYTHON}; run `node python/setup-runtime.mjs`")
    return VENV_PYTHON


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


def bracket_document(
    *,
    length: float = 80.0,
    width: float = 60.0,
    thickness: float = 8.0,
    center_hole: float = 20.0,
    corner_hole: float = 6.0,
    inset: float = 12.0,
    parameterized: bool = True,
) -> dict[str, Any]:
    """The milestone acceptance bracket (SPEC_P0.md §1)."""
    if parameterized:
        return {
            "schema": "dsh.cad/document@1",
            "units": "mm",
            "name": "acceptance bracket",
            "parameters": {"length": length, "width": width, "thickness": thickness},
            "features": [
                {"id": "base", "op": "box", "length": "$length", "width": "$width", "height": "$thickness"},
                {"id": "center_hole", "op": "hole", "diameter": center_hole, "at": [0, 0], "through": True},
                {
                    "id": "corner_holes",
                    "op": "hole_pattern",
                    "pattern": "rect_corners",
                    "diameter": corner_hole,
                    "inset": inset,
                    "span": ["$length", "$width"],
                    "through": True,
                },
            ],
        }
    return {
        "schema": "dsh.cad/document@1",
        "units": "mm",
        "parameters": {},
        "features": [
            {"id": "base", "op": "box", "length": length, "width": width, "height": thickness},
            {"id": "center_hole", "op": "hole", "diameter": center_hole, "at": [0, 0], "through": True},
            {
                "id": "corner_holes",
                "op": "hole_pattern",
                "pattern": "rect_corners",
                "diameter": corner_hole,
                "inset": inset,
                "span": [length, width],
                "through": True,
            },
        ],
    }


def bracket_volume(length: float = 80.0, width: float = 60.0, thickness: float = 8.0, center_hole: float = 20.0, corner_hole: float = 6.0) -> float:
    """Analytic volume of the acceptance bracket."""
    return (
        length * width * thickness
        - math.pi * (center_hole / 2.0) ** 2 * thickness
        - 4.0 * math.pi * (corner_hole / 2.0) ** 2 * thickness
    )


def slow_document(holes: int = 56) -> dict[str, Any]:
    """A deliberately slow document: a plate plus ``holes`` separate hole features.

    Separate features (rather than one pattern) make cancellation observable
    between feature steps and keep the build well under the host timeout while
    still taking a few hundred milliseconds.
    """
    features: list[dict[str, Any]] = [{"id": "base", "op": "box", "length": 200, "width": 200, "height": 20}]
    for index in range(holes):
        features.append(
            {
                "id": f"hole_{index}",
                "op": "hole",
                "diameter": 10,
                "at": [-67.5 + 15.0 * (index % 8), -67.5 + 15.0 * (index // 8)],
                "through": True,
            }
        )
    return {"schema": "dsh.cad/document@1", "units": "mm", "parameters": {}, "features": features}


# ---------------------------------------------------------------------------
# In-process build helpers
# ---------------------------------------------------------------------------


def build_in_process(document: dict[str, Any], output_dir: Path, *, formats: Iterable[str] = ("step", "glb"), preview: dict[str, Any] | None = None, request_id: str = "test") -> dict[str, Any]:
    from cad_runtime import builder  # noqa: PLC0415 - lazy: never import build123d at collection

    params: dict[str, Any] = {
        "requestId": request_id,
        "document": document,
        "outputDir": str(output_dir),
        "formats": list(formats),
    }
    if preview is not None:
        params["preview"] = preview
    return builder.run_build(params)


def geometry_in_process(document: dict[str, Any], *, checks: list[str] | None = None):
    from cad_runtime.document import validate_document  # noqa: PLC0415
    from cad_runtime.geometry import build_geometry  # noqa: PLC0415

    validated = validate_document(document)
    return validated, build_geometry(validated, checks=checks)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Artifact inspection
# ---------------------------------------------------------------------------


def parse_glb(data: bytes) -> dict[str, Any]:
    """Parse a binary glTF container and return {magic, version, json, bin_length}."""
    assert len(data) >= 20, "GLB is too short"
    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    json_length, json_chunk_type = struct.unpack_from("<II", data, 12)
    assert json_chunk_type == 0x4E4F534A, f"first GLB chunk must be JSON, got {json_chunk_type:#x}"
    assert json_length > 0
    document = json.loads(data[20 : 20 + json_length].decode("utf-8"))
    return {
        "magic": magic,
        "version": version,
        "declaredLength": total_length,
        "actualLength": len(data),
        "json": document,
    }


def glb_bbox(parsed: dict[str, Any]) -> tuple[list[float], list[float]]:
    """Return the POSITION accessor min/max of the first mesh primitive."""
    document = parsed["json"]
    accessor_index = document["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
    accessor = document["accessors"][accessor_index]
    return accessor["min"], accessor["max"]


def assert_valid_glb(data: bytes) -> dict[str, Any]:
    parsed = parse_glb(data)
    assert parsed["magic"] == b"glTF"
    assert parsed["version"] == 2
    assert parsed["declaredLength"] == parsed["actualLength"] == len(data)
    document = parsed["json"]
    assert document["asset"]["version"] == "2.0"
    assert len(document["meshes"]) >= 1
    assert document["buffers"][0]["byteLength"] > 0
    return parsed


def step_volume(path: Path) -> float:
    import build123d  # noqa: PLC0415 - lazy

    shape = build123d.import_step(str(path))
    return float(shape.volume)


def glb_mesh(data: bytes):
    import io

    import trimesh  # noqa: PLC0415 - lazy

    return trimesh.load(io.BytesIO(data), file_type="glb", force="mesh")


# ---------------------------------------------------------------------------
# JSON-RPC client for the real server process
# ---------------------------------------------------------------------------


class RuntimeClient:
    """A real ``python -m cad_runtime`` child process speaking JSON-RPC."""

    def __init__(self, *, hello_timeout: float = 180.0) -> None:
        self.python = str(venv_python())
        env = dict(os.environ)
        env["PYTHONPATH"] = str(PYTHON_DIR)
        env["PYTHONUNBUFFERED"] = "1"
        self.process = subprocess.Popen(
            [self.python, "-m", "cad_runtime"],
            cwd=str(PYTHON_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._responses: dict[Any, dict[str, Any]] = {}
        self._notifications: list[dict[str, Any]] = []
        self._cv = threading.Condition()
        self._next_id = 0
        self.stderr_lines: list[str] = []
        self._closed = False
        self._reader = threading.Thread(target=self._read_loop, name="test-rpc-reader", daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._stderr_loop, name="test-rpc-stderr", daemon=True)
        self._stderr_reader.start()
        self.hello = self.request("runtime.hello", {"protocolVersion": "1.0", "host": {"name": "pytest", "version": "0"}})
        assert self.hello.get("result", {}).get("protocolVersion") == "1.0", f"hello failed: {self.hello}"
        assert self.hello["result"].get("ready") is True, f"runtime warmup not ready: {self.hello}"

    # -- plumbing ------------------------------------------------------------

    def _read_loop(self) -> None:
        try:
            for raw in self.process.stdout:
                try:
                    frame = json.loads(raw.decode("utf-8"))
                except Exception:  # pragma: no cover - would fail every test
                    continue
                with self._cv:
                    if "id" in frame:
                        self._responses[frame["id"]] = frame
                    else:
                        self._notifications.append(frame)
                    self._cv.notify_all()
        finally:
            with self._cv:
                self._closed = True
                self._cv.notify_all()

    def _stderr_loop(self) -> None:
        for raw in self.process.stderr:
            self.stderr_lines.append(raw.decode("utf-8", errors="replace").rstrip())

    # -- API -----------------------------------------------------------------

    def send(self, frame: dict[str, Any]) -> None:
        self.process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def send_raw(self, line: bytes) -> None:
        self.process.stdin.write(line)
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any], *, timeout: float = 60.0, request_id: Any = None) -> dict[str, Any]:
        if request_id is None:
            self._next_id += 1
            request_id = f"t-{self._next_id}"
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return self.wait_response(request_id, timeout=timeout)

    def wait_response(self, request_id: Any, *, timeout: float = 60.0) -> dict[str, Any]:
        deadline = _monotonic() + timeout
        with self._cv:
            while request_id not in self._responses:
                if self._closed:
                    raise AssertionError(f"runtime process closed before answering {request_id!r}; stderr={self.stderr_text()}")
                remaining = deadline - _monotonic()
                if remaining <= 0:
                    raise AssertionError(f"timed out waiting for response {request_id!r}; stderr={self.stderr_text()}")
                self._cv.wait(remaining)
            return self._responses.pop(request_id)

    def pop_response(self, request_id: Any) -> dict[str, Any] | None:
        with self._cv:
            return self._responses.pop(request_id, None)

    def wait_for_notification(self, predicate, *, timeout: float = 30.0) -> dict[str, Any]:
        deadline = _monotonic() + timeout
        with self._cv:
            while True:
                for frame in self._notifications:
                    if predicate(frame):
                        return frame
                remaining = deadline - _monotonic()
                if remaining <= 0 or self._closed:
                    raise AssertionError("notification not received")
                self._cv.wait(remaining)

    def notifications(self, method: str | None = None) -> list[dict[str, Any]]:
        with self._cv:
            frames = list(self._notifications)
        return [frame for frame in frames if method is None or frame.get("method") == method]

    def close_stdin(self) -> None:
        try:
            self.process.stdin.close()
        except Exception:  # pragma: no cover
            pass

    def kill(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        try:
            self.process.wait(timeout=5)
        except Exception:  # pragma: no cover
            pass

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.request("runtime.shutdown", {"reason": "pytest teardown"}, timeout=10)
        except Exception:  # pragma: no cover - teardown best effort
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            self.kill()

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_lines[-20:])

    def __enter__(self) -> "RuntimeClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()


def _monotonic() -> float:
    import time

    return time.monotonic()
