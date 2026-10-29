"""In-process self-test: build the acceptance bracket and print one JSON object.

Used by ``python/setup-runtime.mjs`` (installer verification) and by
``python -m cad_runtime --selftest``. It exercises the real pipeline: document
validation, build123d/OCCT B-rep construction, all geometry checks, tessellation,
STEP/GLB/STL export and the SVG hidden-line preview.
"""

from __future__ import annotations

import json
import platform
import sys
import tempfile
import time
from typing import Any

from . import builder
from .protocol import PROTOCOL_VERSION, RUNTIME_VERSION

#: The milestone acceptance part (SPEC_P0.md §1): 80 x 60 x 8 mm plate, Ø20
#: centre through-hole, four Ø6 corner through-holes inset 12 mm.
ACCEPTANCE_DOCUMENT: dict[str, Any] = {
    "schema": "dsh.cad/document@1",
    "units": "mm",
    "name": "acceptance bracket",
    "parameters": {"length": 80, "width": 60, "thickness": 8},
    "features": [
        {"id": "base", "op": "box", "length": "$length", "width": "$width", "height": "$thickness"},
        {"id": "center_hole", "op": "hole", "diameter": 20, "at": [0, 0], "through": True},
        {
            "id": "corner_holes",
            "op": "hole_pattern",
            "pattern": "rect_corners",
            "diameter": 6,
            "inset": 12,
            "span": ["$length", "$width"],
            "through": True,
        },
    ],
}


def run_selftest(*, formats: list[str] | None = None) -> int:
    started = time.perf_counter()
    import_started = time.perf_counter()
    try:
        import build123d  # noqa: PLC0415
        import OCP  # noqa: PLC0415
        import numpy  # noqa: PLC0415
        import trimesh  # noqa: PLC0415

        import_ms = (time.perf_counter() - import_started) * 1000.0
        versions = {
            "python": platform.python_version(),
            "pythonPath": sys.executable,
            "build123d": getattr(build123d, "__version__", None),
            "ocp": getattr(OCP, "__version__", None),
            "trimesh": getattr(trimesh, "__version__", None),
            "numpy": getattr(numpy, "__version__", None),
        }
    except Exception as exc:  # noqa: BLE001 - reported as JSON status
        payload = {
            "ok": False,
            "status": "unavailable",
            "error": f"required runtime packages are not importable: {exc}",
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "python": platform.python_version(),
            "pythonPath": sys.executable,
        }
        print(json.dumps(payload, ensure_ascii=True))
        return 1

    payload: dict[str, Any] = {
        "ok": False,
        "status": "failed",
        "protocolVersion": PROTOCOL_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "versions": versions,
    }
    try:
        with tempfile.TemporaryDirectory(prefix="dsh-cad-selftest-") as output_dir:
            result = builder.run_build(
                {
                    "requestId": "selftest",
                    "document": ACCEPTANCE_DOCUMENT,
                    "outputDir": output_dir,
                    "formats": formats or ["step", "glb", "stl", "svg"],
                    "preview": {"view": "iso", "width": 1200, "height": 900},
                }
            )
            payload["status"] = result.get("status")
            payload["ok"] = result.get("status") == "built"
            report = result.get("report") or {}
            payload["geometry"] = {
                "volume": report.get("volume"),
                "surfaceArea": report.get("surfaceArea"),
                "boundingBox": report.get("boundingBox"),
                "topology": report.get("topology"),
                "checks": report.get("checks"),
                "warnings": report.get("warnings"),
                "timings": report.get("timings"),
            }
            payload["artifacts"] = result.get("artifacts")
            payload["error"] = result.get("error")
        payload["importMs"] = round(import_ms, 1)
        payload["selftestMs"] = round((time.perf_counter() - started) * 1000.0, 1)
        payload["ok"] = bool(payload["ok"]) and all(
            (artifact.get("bytes") or 0) > 0 and len(artifact.get("sha256") or "") == 64
            for artifact in payload.get("artifacts") or []
        )
        if payload["ok"]:
            payload["status"] = "ok"
        print(json.dumps(payload, ensure_ascii=True))
        return 0 if payload["ok"] else 1
    except Exception as exc:  # noqa: BLE001 - reported as JSON status
        payload["error"] = f"{type(exc).__name__}: {exc}"
        payload["selftestMs"] = round((time.perf_counter() - started) * 1000.0, 1)
        print(json.dumps(payload, ensure_ascii=True))
        return 1
