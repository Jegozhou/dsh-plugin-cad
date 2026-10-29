"""Service layer: turns JSON-RPC ``model.build`` / ``model.validate`` params into
validated documents, geometry, checks and artifacts.

Everything here is a pure function of its params plus a cooperative cancellation
event; the server owns process state, the builder owns one build.
"""

from __future__ import annotations

import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from . import artifacts as artifact_store
from .document import CadDocument, validate_document
from .errors import (
    CadRuntimeError,
    cancelled as cancelled_error,
    export_failed,
    internal_error,
    invalid_argument,
)
from .geometry import BuildOutcome, build_geometry
from .mesh import glb_bytes, stl_bytes
from .protocol import (
    CHECK_IDS,
    DEFAULT_LIMITS,
    EXPORT_FORMATS,
    REPORT_SCHEMA,
    RUNTIME_FORMATS,
)
from .render import render_svg, validate_preview

ProgressFn = Callable[[str, int, str], None]

#: Deterministic artifact order: step, glb, stl, svg.
FORMAT_ORDER = ("step", "glb", "stl", "svg")

#: Formats supported by this runtime (protocol.js EXPORT_FORMATS + svg preview).
SUPPORTED_FORMATS = tuple(fmt for fmt in FORMAT_ORDER if fmt in RUNTIME_FORMATS)


# ---------------------------------------------------------------------------
# Param parsing
# ---------------------------------------------------------------------------


@dataclass
class BuildRequest:
    request_id: str
    document: Mapping[str, Any]
    output_dir: str
    formats: list[str]
    checks: list[str] | None
    limits: dict[str, Any]
    preview: dict[str, Any]
    model_id: str | None = None
    revision_id: str | None = None
    progress_enabled: bool = True
    params: dict[str, Any] = field(default_factory=dict)


def _as_dict(params: Any) -> dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise invalid_argument("params must be a JSON object", path="")
    return params


def request_id_from(params: Mapping[str, Any], *, required: bool = False) -> str:
    raw = params.get("requestId")
    if raw is None:
        if required:
            raise invalid_argument("requestId is required", path="/requestId")
        return "rq-" + uuid.uuid4().hex[:16]
    if not isinstance(raw, str) or not raw or len(raw) > 256:
        raise invalid_argument("requestId must be a non-empty string of at most 256 characters", path="/requestId")
    return raw


def _parse_model(params: Mapping[str, Any]) -> tuple[str | None, str | None]:
    model = params.get("model")
    if model is None:
        return None, None
    if not isinstance(model, dict):
        raise invalid_argument("model must be an object", path="/model")
    model_id = model.get("id")
    revision_id = model.get("revisionId")
    if model_id is not None and not isinstance(model_id, str):
        raise invalid_argument("model.id must be a string", path="/model/id")
    if revision_id is not None and not isinstance(revision_id, str):
        raise invalid_argument("model.revisionId must be a string", path="/model/revisionId")
    return model_id, revision_id


def _parse_formats(params: Mapping[str, Any]) -> list[str]:
    raw = params.get("formats")
    if raw is None:
        return ["step", "glb"]
    if not isinstance(raw, list) or not raw:
        raise invalid_argument(f"formats must be a non-empty array of {list(SUPPORTED_FORMATS)}", path="/formats")
    formats: list[str] = []
    for index, fmt in enumerate(raw):
        if not isinstance(fmt, str) or fmt not in SUPPORTED_FORMATS:
            raise invalid_argument(
                f"unsupported artifact format {fmt!r}; expected one of {list(SUPPORTED_FORMATS)}",
                path=f"/formats/{index}",
            )
        if fmt not in formats:
            formats.append(fmt)
    return [fmt for fmt in FORMAT_ORDER if fmt in formats]


def _parse_checks(params: Mapping[str, Any]) -> list[str] | None:
    raw = params.get("checks")
    if raw is None:
        return None
    if not isinstance(raw, list) or not raw:
        return None
    checks: list[str] = []
    for index, check_id in enumerate(raw):
        if not isinstance(check_id, str) or check_id not in CHECK_IDS:
            raise invalid_argument(
                f"unknown check id {check_id!r}; expected a subset of {list(CHECK_IDS)}",
                path=f"/checks/{index}",
            )
        checks.append(check_id)
    return checks


def _parse_limits(params: Mapping[str, Any]) -> dict[str, Any]:
    raw = params.get("limits")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise invalid_argument("limits must be an object", path="/limits")
    limits: dict[str, Any] = {}
    numeric_positive = ("maxBoundingBoxMm", "maxArtifactBytes", "maxFeatures", "maxParameters", "meshToleranceMm", "meshAngularToleranceRad")
    for key, value in raw.items():
        if key not in DEFAULT_LIMITS:
            continue  # forward compatible: ignore unknown limit names
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise invalid_argument(f"limits.{key} must be a number", path=f"/limits/{key}")
        number = float(value)
        if key == "minWallThicknessMm":
            if number < 0:
                raise invalid_argument("limits.minWallThicknessMm must be >= 0", path="/limits/minWallThicknessMm")
        elif key in numeric_positive and not number > 0:
            raise invalid_argument(f"limits.{key} must be > 0", path=f"/limits/{key}")
        limits[key] = int(number) if key in ("maxArtifactBytes", "maxFeatures", "maxParameters") else number
    return limits


def parse_build_request(params: Any) -> BuildRequest:
    """Strictly parse ``model.build`` params. Raises ``invalid_argument``."""
    raw = _as_dict(params)
    request_id = request_id_from(raw)
    model_id, revision_id = _parse_model(raw)
    document = raw.get("document")
    if document is None:
        raise invalid_argument("document is required", path="/document")
    if not isinstance(document, dict):
        raise invalid_argument("document must be a JSON object", path="/document")
    output_dir_raw = raw.get("outputDir")
    # resolve_output_dir raises a structured invalid_argument; do it early so a
    # bad outputDir is rejected before any geometry work happens.
    output_dir = artifact_store.resolve_output_dir(output_dir_raw)
    formats = _parse_formats(raw)
    preview = validate_preview(raw.get("preview")) if "svg" in formats else {"view": "iso", "width": 1200, "height": 900}
    checks = _parse_checks(raw)
    limits = _parse_limits(raw)
    progress_enabled = raw.get("progress", True) is not False
    return BuildRequest(
        request_id=request_id,
        document=document,
        output_dir=output_dir,
        formats=formats,
        checks=checks,
        limits=limits,
        preview=preview,
        model_id=model_id,
        revision_id=revision_id,
        progress_enabled=progress_enabled,
        params=dict(raw),
    )


def parse_validate_request(params: Any) -> tuple[dict[str, Any], list[str] | None, dict[str, Any], str]:
    raw = _as_dict(params)
    document = raw.get("document")
    if document is None:
        raise invalid_argument("document is required", path="/document")
    if not isinstance(document, dict):
        raise invalid_argument("document must be a JSON object", path="/document")
    if "outputDir" in raw:  # validate never writes; reject silently? no: be strict
        raise invalid_argument("model.validate does not take outputDir", path="/outputDir")
    return document, _parse_checks(raw), _parse_limits(raw), request_id_from(raw)


# ---------------------------------------------------------------------------
# Result construction
# ---------------------------------------------------------------------------


def new_build_id() -> str:
    return "b-" + uuid.uuid4().hex[:12]


def _result(
    *,
    request_id: str,
    build_id: str,
    status: str,
    report: dict[str, Any],
    artifacts: list[dict[str, Any]],
    error: dict[str, Any] | None,
    model_id: str | None = None,
    revision_id: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "ok": True,
        "requestId": request_id,
        "buildId": build_id,
        "status": status,
        "report": report,
        "artifacts": artifacts,
        "error": error,
    }
    if model_id is not None:
        result["modelId"] = model_id
    if revision_id is not None:
        result["revisionId"] = revision_id
    return result


def empty_report(*, warnings: list[str] | None = None, message: str = "") -> dict[str, Any]:
    return {
        "schema": REPORT_SCHEMA,
        "valid": False,
        "volume": 0.0,
        "surfaceArea": 0.0,
        "boundingBox": {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0], "size": [0.0, 0.0, 0.0]},
        "centroid": [0.0, 0.0, 0.0],
        "topology": {"faces": 0, "edges": 0, "vertices": 0, "solids": 0},
        "checks": [],
        "featureReports": [],
        "warnings": list(warnings or []),
        "timings": {"totalMs": 0.0, "buildMs": 0.0, "exportMs": 0.0},
        "message": message,
    }


def _failed_error(outcome: BuildOutcome) -> dict[str, Any]:
    assert outcome.error is not None
    error = outcome.error.to_result_error()
    details = dict(error.get("details") or {})
    details.setdefault(
        "checks",
        [{"id": check["id"], "status": check["status"], "message": check["message"]} for check in outcome.checks if check["status"] == "fail"],
    )
    error["details"] = details
    return error


def _finalise_report(outcome: BuildOutcome, *, total_ms: float, export_ms: float) -> dict[str, Any]:
    report = dict(outcome.report)
    report["timings"] = {
        "totalMs": round(total_ms, 1),
        "buildMs": round(float(outcome.timings.get("buildMs", 0.0)), 1),
        "exportMs": round(export_ms, 1),
    }
    report["valid"] = outcome.error is None and not any(c["status"] == "fail" for c in outcome.checks)
    return report


# ---------------------------------------------------------------------------
# Build pipeline
# ---------------------------------------------------------------------------


def run_build(
    params: Any,
    *,
    cancel_event: threading.Event | None = None,
    progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """Execute one ``model.build`` request and return the normal result object."""
    started = time.perf_counter()
    request = parse_build_request(params)
    build_id = new_build_id()

    def emit(phase: str, percent: int, message: str) -> None:
        if progress is None:
            return
        try:
            progress(phase, percent, message)
        except Exception:  # pragma: no cover - progress must never fail a build
            pass

    if request.progress_enabled:
        emit("validating", 1, "validating document")
    limits = dict(DEFAULT_LIMITS)
    limits.update(request.limits)
    document = validate_document(request.document, limits=limits)
    artifact_store.sweep_stale_temps(request.output_dir)
    emit("validating", 4, "document accepted")

    on_feature: ProgressFn | None = None
    if request.progress_enabled:
        on_feature = lambda phase, percent, message: emit(phase, 5 + int(percent * 0.85), message)  # noqa: E731

    outcome = build_geometry(
        document,
        limits=limits,
        cancel_event=cancel_event,
        progress=on_feature,
        checks=request.checks,
    )

    # Geometry/check failure: normal failed result, no artifacts -----------------
    if outcome.error is not None:
        total_ms = (time.perf_counter() - started) * 1000.0
        report = _finalise_report(outcome, total_ms=total_ms, export_ms=0.0)
        emit("done", 100, "build failed")
        return _result(
            request_id=request.request_id,
            build_id=build_id,
            status="failed",
            report=report,
            artifacts=[],
            error=_failed_error(outcome),
            model_id=request.model_id,
            revision_id=request.revision_id,
        )

    # Artifacts ------------------------------------------------------------------
    export_started = time.perf_counter()
    created_paths: list[str] = []
    artifacts_payload: list[dict[str, Any]] = []
    max_bytes = int(limits.get("maxArtifactBytes", DEFAULT_LIMITS["maxArtifactBytes"]))
    base = 90.0
    try:
        for index, fmt in enumerate(request.formats):
            if cancel_event is not None and cancel_event.is_set():
                raise cancelled_error("build cancelled during export", format=fmt)
            emit("exporting", int(base + (10.0 * index / max(1, len(request.formats)))), f"exporting {fmt}")
            artifact, size, digest = _export_one(fmt, outcome, request.output_dir, request.preview, max_bytes)
            created_paths.append(artifact.path)
            artifacts_payload.append(artifact.to_dict(size, digest))
    except CadRuntimeError as exc:
        artifact_store.remove_artifacts(created_paths)
        total_ms = (time.perf_counter() - started) * 1000.0
        report = _finalise_report(outcome, total_ms=total_ms, export_ms=(time.perf_counter() - export_started) * 1000.0)
        emit("done", 100, "export failed")
        return _result(
            request_id=request.request_id,
            build_id=build_id,
            status="failed",
            report=report,
            artifacts=[],
            error=exc.to_result_error(),
            model_id=request.model_id,
            revision_id=request.revision_id,
        )
    except Exception as exc:  # noqa: BLE001 - any exporter bug becomes export_failed
        artifact_store.remove_artifacts(created_paths)
        traceback.print_exc()
        total_ms = (time.perf_counter() - started) * 1000.0
        report = _finalise_report(outcome, total_ms=total_ms, export_ms=(time.perf_counter() - export_started) * 1000.0)
        error = export_failed(f"artifact export failed: {exc}").to_result_error()
        emit("done", 100, "export failed")
        return _result(
            request_id=request.request_id,
            build_id=build_id,
            status="failed",
            report=report,
            artifacts=[],
            error=error,
            model_id=request.model_id,
            revision_id=request.revision_id,
        )

    export_ms = (time.perf_counter() - export_started) * 1000.0
    total_ms = (time.perf_counter() - started) * 1000.0
    report = _finalise_report(outcome, total_ms=total_ms, export_ms=export_ms)
    emit("done", 100, "build complete")
    return _result(
        request_id=request.request_id,
        build_id=build_id,
        status="built",
        report=report,
        artifacts=artifacts_payload,
        error=None,
        model_id=request.model_id,
        revision_id=request.revision_id,
    )


def _export_one(
    fmt: str,
    outcome: BuildOutcome,
    output_dir: str,
    preview: Mapping[str, Any],
    max_bytes: int,
) -> tuple[artifact_store.Artifact, int, str]:
    if fmt == "step":
        shape = outcome.shape
        if shape is None:
            raise export_failed("no geometry to export as STEP")

        def write_step(path: str) -> None:
            import build123d  # noqa: PLC0415 - lazy

            build123d.export_step(shape, path)

        return artifact_store.write_atomic(output_dir, "step", writer=write_step, max_bytes=max_bytes)

    if fmt in ("glb", "stl"):
        if outcome.mesh is None:
            raise export_failed(f"no mesh to export as {fmt.upper()}")
        data = glb_bytes(outcome.mesh) if fmt == "glb" else stl_bytes(outcome.mesh)
        return artifact_store.write_atomic(output_dir, fmt, data=data, max_bytes=max_bytes)

    if fmt == "svg":
        if outcome.shape is None:
            raise export_failed("no geometry to render")
        data = render_svg(
            outcome.shape,
            view=preview.get("view", "iso"),
            width=int(preview.get("width", 1200)),
            height=int(preview.get("height", 900)),
        )
        return artifact_store.write_atomic(output_dir, "svg", data=data, max_bytes=max_bytes)

    raise export_failed(f"unsupported artifact format {fmt!r}")  # pragma: no cover


def run_validate(params: Any, *, cancel_event: threading.Event | None = None) -> dict[str, Any]:
    """Execute one ``model.validate`` request (never writes files)."""
    document_raw, checks, limits_overrides, _request_id = parse_validate_request(params)
    limits = dict(DEFAULT_LIMITS)
    limits.update(limits_overrides)
    document = validate_document(document_raw, limits=limits)
    outcome = build_geometry(document, limits=limits, cancel_event=cancel_event, checks=checks)
    report = _finalise_report(outcome, total_ms=float(outcome.timings.get("geometryMs", 0.0)), export_ms=0.0)
    return {
        "ok": True,
        "valid": outcome.error is None and not any(c["status"] == "fail" for c in outcome.checks),
        "checks": outcome.checks,
        "report": report,
    }


def aborted_result(request_id: str, params: Any, reason: str) -> dict[str, Any]:
    """Result for a build cancelled before it started (queued)."""
    model_id: str | None = None
    revision_id: str | None = None
    try:
        raw = params if isinstance(params, dict) else {}
        model_id, revision_id = _parse_model(raw)
    except CadRuntimeError:
        pass
    error = cancelled_error("build cancelled before it started", reason=reason)
    report = empty_report(warnings=["build was cancelled before any feature ran"], message=error.message)
    return _result(
        request_id=request_id,
        build_id=new_build_id(),
        status="failed",
        report=report,
        artifacts=[],
        error=error.to_result_error(),
        model_id=model_id,
        revision_id=revision_id,
    )
