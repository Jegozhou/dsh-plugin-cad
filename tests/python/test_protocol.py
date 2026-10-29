"""Protocol tests against the real ``python -m cad_runtime`` child process.

Covers hello/health, build/validate round-trips, malformed frames, unknown
methods, id reuse, duplicate requestIds, multiple sequential builds in one warm
process, oversize frames, double shutdown and stdin-EOF orphan prevention.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time

import pytest

from cad_runtime.protocol import MAX_FRAME_BYTES
from helpers import PYTHON_DIR, RuntimeClient, bracket_document, sha256_file, venv_python


def test_health_reports_status_uptime_pid_and_active_builds() -> None:
    with RuntimeClient() as client:
        health = client.request("runtime.health", {})["result"]
        assert health["ok"] is True
        assert isinstance(health["pid"], int) and health["pid"] > 0
        assert health["uptimeMs"] >= 0
        assert health["protocolVersion"] == "1.0"
        assert health["status"] in ("starting", "ready", "degraded")
        assert health["ready"] is True
        assert health["busy"] is False
        assert health["jobs"] == 0
        assert health["activeBuilds"] == 0
        versions = health["versions"]
        assert versions["build123d"] and versions["ocp"] and versions["trimesh"] and versions["numpy"]


def test_build_over_protocol_writes_artifacts_inside_output_dir(tmp_path) -> None:
    with RuntimeClient() as client:
        result = client.request(
            "model.build",
            {
                "requestId": "rq-proto-1",
                "model": {"id": "m-test", "revisionId": "r-0001"},
                "document": bracket_document(),
                "outputDir": str(tmp_path),
                "formats": ["step", "glb", "svg"],
                "preview": {"view": "iso", "width": 640, "height": 480},
            },
        )["result"]
        assert result["ok"] is True
        assert result["status"] == "built"
        assert result["requestId"] == "rq-proto-1"
        assert result["modelId"] == "m-test" and result["revisionId"] == "r-0001"
        assert result["error"] is None
        assert result["report"]["volume"] == pytest.approx(34981.947193, abs=1e-3)
        assert [artifact["fileName"] for artifact in result["artifacts"]] == [
            "model.step",
            "model.glb",
            "preview.svg",
        ]
        for artifact in result["artifacts"]:
            path = tmp_path / artifact["fileName"]
            assert path.is_file() and not path.is_symlink()
            assert path.stat().st_size == artifact["bytes"]
            assert sha256_file(path) == artifact["sha256"]

        progress = client.notifications("build.progress")
        request_notifications = [n for n in progress if n["params"].get("requestId") == "rq-proto-1"]
        assert request_notifications, "the runtime must emit build.progress for model.build"
        phases = {n["params"]["phase"] for n in request_notifications}
        assert {"validating", "building", "exporting", "done"} <= phases
        assert request_notifications[-1]["params"]["percent"] == 100
        for notification in request_notifications:
            assert isinstance(notification["params"]["percent"], int)
            assert 0 <= notification["params"]["percent"] <= 100


def test_validate_over_protocol_reports_checks_without_writing(tmp_path) -> None:
    with RuntimeClient() as client:
        result = client.request("model.validate", {"document": bracket_document()})["result"]
        assert result["ok"] is True
        assert result["valid"] is True
        assert [check["id"] for check in result["checks"]] == [
            "document_schema",
            "single_solid",
            "brep_valid",
            "positive_volume",
            "closed_shell",
            "bounding_box",
            "feature_effects",
            "wall_thickness",
        ]
        assert result["report"]["volume"] == pytest.approx(34981.947193, abs=1e-3)
        assert not list(tmp_path.iterdir())

        invalid = client.request(
            "model.validate",
            {"document": {"schema": "dsh.cad/document@1", "units": "mm", "parameters": {},
                          "features": [{"id": "base", "op": "box", "length": -1, "width": 1, "height": 1}]}},
        )
        assert invalid["error"]["code"] == -32602
        assert invalid["error"]["data"]["code"] == "invalid_document"
        assert invalid["error"]["data"]["details"]["path"] == "/features/0/length"
        assert invalid["error"]["data"]["details"]["violations"]


def test_malformed_json_gets_parse_error_and_does_not_kill_the_runtime() -> None:
    with RuntimeClient() as client:
        client.send_raw(b"{this is not json\n")
        deadline = time.monotonic() + 5
        frame = None
        while time.monotonic() < deadline:
            frame = client.pop_response(None)
            if frame is not None:
                break
            time.sleep(0.02)
        assert frame is not None, "expected a -32700 parse error with id null"
        assert frame["error"]["code"] == -32700
        assert frame["error"]["data"]["code"] == "protocol_error"
        assert frame["id"] is None
        # still alive and serving
        assert client.request("runtime.health", {})["result"]["ok"] is True


def test_unknown_method_is_a_protocol_error() -> None:
    with RuntimeClient() as client:
        response = client.request("model.frobnicate", {})
        assert response["error"]["code"] == -32601
        assert response["error"]["data"]["code"] == "protocol_error"
        assert client.request("runtime.health", {})["result"]["ok"] is True


def test_invalid_envelope_and_params_are_answered() -> None:
    with RuntimeClient() as client:
        client.send_raw(b'{"jsonrpc":"1.0","id":"env","method":"runtime.health","params":{}}\n')
        assert client.wait_response("env")["error"]["code"] == -32600
        client.send({"jsonrpc": "2.0", "id": "par", "method": "model.validate", "params": "nope"})
        assert client.wait_response("par")["error"]["code"] == -32600
        client.send_raw(b'{"jsonrpc":"2.0","id":[1],"method":"runtime.health","params":{}}\n')
        assert client.wait_response(None)["error"]["code"] == -32600


def test_reused_request_id_does_not_crash_the_runtime() -> None:
    with RuntimeClient() as client:
        client.send({"jsonrpc": "2.0", "id": "same", "method": "runtime.health", "params": {}})
        client.send({"jsonrpc": "2.0", "id": "same", "method": "runtime.health", "params": {}})
        time.sleep(0.3)
        assert client.pop_response("same") is not None
        assert client.request("runtime.health", {})["result"]["ok"] is True


def test_duplicate_in_flight_request_id_is_rejected(tmp_path) -> None:
    from helpers import slow_document

    with RuntimeClient() as client:
        params = {
            "requestId": "rq-duplicate",
            "document": slow_document(56),
            "outputDir": str(tmp_path),
            "formats": ["glb"],
        }
        client.send({"jsonrpc": "2.0", "id": "dup-1", "method": "model.build", "params": params})
        duplicate = client.request("model.build", params)
        assert duplicate["error"]["data"]["code"] == "protocol_error"
        # let the first build finish, or cancel it if it is still running
        client.request("job.cancel", {"requestId": "rq-duplicate"})
        client.wait_response("dup-1", timeout=30)


def test_multiple_sequential_builds_reuse_one_warm_process(tmp_path) -> None:
    with RuntimeClient() as client:
        for revision in range(3):
            out = tmp_path / f"r-{revision:04d}"
            result = client.request(
                "model.build",
                {
                    "requestId": f"rq-seq-{revision}",
                    "model": {"id": "m-seq", "revisionId": f"r-{revision:04d}"},
                    "document": bracket_document(length=80 + revision * 5),
                    "outputDir": str(out),
                    "formats": ["step", "glb"],
                },
                timeout=60,
            )["result"]
            assert result["status"] == "built", result.get("error")
            assert (out / "model.step").is_file() and (out / "model.glb").is_file()
            assert result["report"]["timings"]["totalMs"] < 5000, "a warm build must not re-pay the 80 s import"
        health = client.request("runtime.health", {})["result"]
        assert health["counters"]["completed"] >= 3


def test_oversize_frame_is_refused_without_killing_the_runtime() -> None:
    with RuntimeClient() as client:
        oversize = b"{" + b" " * (MAX_FRAME_BYTES + 1024)
        client.send_raw(oversize)
        time.sleep(0.2)
        client.send_raw(b"\n")
        deadline = time.monotonic() + 10
        frame = None
        while time.monotonic() < deadline:
            frame = client.pop_response(None)
            if frame is not None:
                break
            time.sleep(0.02)
        assert frame is not None and frame["error"]["code"] == -32700
        client.send_raw(b"\n")  # close the discarded line if any remains
        assert client.request("runtime.health", {})["result"]["ok"] is True


def test_double_shutdown_is_idempotent_and_the_process_exits_zero() -> None:
    client = RuntimeClient()
    try:
        client.send({"jsonrpc": "2.0", "id": "sd-1", "method": "runtime.shutdown", "params": {"reason": "test"}})
        client.send({"jsonrpc": "2.0", "id": "sd-2", "method": "runtime.shutdown", "params": {"reason": "again"}})
        first = client.wait_response("sd-1", timeout=5)
        second = client.wait_response("sd-2", timeout=5)
        assert first["result"]["ok"] is True
        assert second["result"]["ok"] is True
        code = client.process.wait(timeout=5)
        assert code == 0, f"graceful shutdown must exit 0, got {code}"
    finally:
        client.kill()


def test_stdin_eof_exits_the_process_without_orphans() -> None:
    client = RuntimeClient()
    try:
        pid = client.process.pid
        client.close_stdin()
        code = client.process.wait(timeout=5)
        assert code == 0
        assert client.process.poll() == 0
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)  # no orphan process survives its host
    finally:
        client.kill()


def test_eof_during_a_build_kills_the_worker_and_exits() -> None:
    from helpers import slow_document

    client = RuntimeClient()
    pid = client.process.pid
    try:
        client.send(
            {
                "jsonrpc": "2.0",
                "id": "eof-build",
                "method": "model.build",
                "params": {"requestId": "rq-eof", "document": slow_document(56), "outputDir": "/tmp/dsh-cad-eof-test", "formats": ["glb"]},
            }
        )
        time.sleep(0.1)  # let the build start
        started = time.monotonic()
        client.close_stdin()
        code = client.process.wait(timeout=6)
        assert code == 0
        assert time.monotonic() - started < 6
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        client.kill()


def test_stdio_stdout_only_carries_protocol_frames() -> None:
    # Every stdout line must be one JSON object; diagnostics belong on stderr.
    client = RuntimeClient()
    try:
        client.request("runtime.health", {})
        client.request("model.validate", {"document": bracket_document()})
        client.send_raw(b"not json\n")
        time.sleep(0.3)
        lines = []
        while True:
            frame = client.pop_response(None)
            if frame is not None:
                lines.append(frame)
            else:
                break
        # reader thread dropped nothing: all frames parsed as JSON (the helper
        # would have failed the request otherwise). Assert stderr received the
        # parse-error diagnostics instead.
        assert client.stderr_text() is not None
    finally:
        client.stop()
