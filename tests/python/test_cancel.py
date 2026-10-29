"""Cancellation tests: cooperative cancel of a running/queued build, no artifacts left."""

from __future__ import annotations

import time

import pytest

from helpers import RuntimeClient, bracket_document, slow_document


def _build_frame(rpc_id: str, request_id: str, document, output_dir) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "model.build",
        "params": {
            "requestId": request_id,
            "document": document,
            "outputDir": str(output_dir),
            "formats": ["step", "glb"],
        },
    }


def test_cancel_running_build_settles_cancelled_without_artifacts(tmp_path) -> None:
    output_dir = tmp_path / "revision"
    with RuntimeClient() as client:
        client.send(_build_frame("b-cancel", "rq-cancel", slow_document(), output_dir))
        time.sleep(0.15)  # let the worker start building
        cancel = client.request("job.cancel", {"requestId": "rq-cancel", "reason": "test cancel"})
        assert cancel["result"] == {"ok": True, "cancelled": True, "requestId": "rq-cancel"}

        response = client.wait_response("b-cancel", timeout=10)
        result = response["result"]
        assert result["status"] == "failed"
        assert result["error"]["code"] == "cancelled"
        assert result["artifacts"] == []
        assert not output_dir.exists() or not list(output_dir.iterdir()), "cancelled build must leave no artifacts"
        # the runtime survives cancellation and builds again
        assert client.request("runtime.health", {})["result"]["busy"] is False


def test_cancel_is_idempotent_while_in_flight_and_reports_false_after(tmp_path) -> None:
    with RuntimeClient() as client:
        # A queued build stays pending deterministically, so two cancels can be
        # observed while it is still queued (a running build may settle between
        # the two requests, which is also correct but racy to assert).
        client.send(_build_frame("b-blocker", "rq-blocker", slow_document(), tmp_path / "blocker"))
        client.send(_build_frame("b-idem", "rq-idem", slow_document(), tmp_path / "idempotent"))
        time.sleep(0.05)
        # Send both cancels without waiting in between: the queued job settles
        # within a few milliseconds of the first cancel, so a second request sees
        # either "still pending" (true) or "already settled" (false) depending on
        # scheduling; both are correct. Idempotency means a repeat never errors
        # and the build settles exactly once as cancelled.
        client.send({"jsonrpc": "2.0", "id": "cancel-1", "method": "job.cancel", "params": {"requestId": "rq-idem"}})
        client.send({"jsonrpc": "2.0", "id": "cancel-2", "method": "job.cancel", "params": {"requestId": "rq-idem"}})
        first = client.wait_response("cancel-1", timeout=5)["result"]
        second = client.wait_response("cancel-2", timeout=5)["result"]
        assert first["cancelled"] is True
        assert second["cancelled"] in (True, False), "repeated cancel must never error"
        response = client.wait_response("b-idem", timeout=10)["result"]
        assert response["status"] == "failed"
        assert response["error"]["code"] == "cancelled"
        # after settlement
        third = client.request("job.cancel", {"requestId": "rq-idem"})["result"]
        assert third["cancelled"] is False
        client.request("job.cancel", {"requestId": "rq-blocker"})
        client.wait_response("b-blocker", timeout=15)


def test_cancel_unknown_request_id_is_false_not_an_error() -> None:
    with RuntimeClient() as client:
        result = client.request("job.cancel", {"requestId": "rq-never-existed"})["result"]
        assert result == {"ok": True, "cancelled": False, "requestId": "rq-never-existed"}


def test_cancel_queued_build_before_it_starts(tmp_path) -> None:
    with RuntimeClient() as client:
        client.send(_build_frame("b-a", "rq-a", slow_document(), tmp_path / "a"))
        client.send(_build_frame("b-b", "rq-b", slow_document(), tmp_path / "b"))
        time.sleep(0.05)  # B is queued behind A's build lock
        queued_cancel = client.request("job.cancel", {"requestId": "rq-b"})["result"]
        assert queued_cancel["cancelled"] is True
        response_b = client.wait_response("b-b", timeout=10)["result"]
        assert response_b["status"] == "failed"
        assert response_b["error"]["code"] == "cancelled"
        assert response_b["artifacts"] == []
        # cancel A so the test finishes quickly
        assert client.request("job.cancel", {"requestId": "rq-a"})["result"]["cancelled"] is True
        client.wait_response("b-a", timeout=15)


def test_build_after_cancel_still_works(tmp_path) -> None:
    with RuntimeClient() as client:
        client.send(_build_frame("b-x", "rq-x", slow_document(), tmp_path / "x"))
        time.sleep(0.1)
        client.request("job.cancel", {"requestId": "rq-x"})
        client.wait_response("b-x", timeout=10)
        result = client.request(
            "model.build",
            {
                "requestId": "rq-after",
                "document": bracket_document(),
                "outputDir": str(tmp_path / "after"),
                "formats": ["glb"],
            },
            timeout=60,
        )["result"]
        assert result["status"] == "built"
        assert (tmp_path / "after" / "model.glb").is_file()
