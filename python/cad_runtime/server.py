"""Newline-delimited JSON-RPC 2.0 server over stdio.

Threading model
---------------
* The **main thread** owns stdin: it reads frames, answers fast methods
  (``runtime.hello``, ``runtime.health``, ``runtime.shutdown``, ``job.cancel``)
  and hands ``model.build`` to a worker, so ``job.cancel`` and ``health`` are
  answered while a build is running.
* **Build workers** are daemon threads serialised by a build lock; they write
  their own response frames (guarded by a write lock) and ``build.progress``
  notifications.
* ``model.validate`` is answered inline on the main thread (it never blocks for
  long and has no cancellation contract).

Lifecycle
---------
* ``runtime.shutdown`` → respond, cancel jobs, drain 250 ms, exit 0.
* stdin **EOF** (the host died, possibly SIGKILL) → cancel jobs, exit 0 fast.
  No orphan process may survive the host.
* ``SIGTERM``/``SIGINT`` → same as EOF.
* Nothing is ever printed to stdout except protocol frames; fd 1 is redirected
  to stderr at startup and the protocol keeps a duplicated handle.
"""

from __future__ import annotations

import json
import os
import platform
import select
import signal
import sys
import threading
import time
import traceback
from typing import Any, Callable

from . import builder
from .errors import CadRuntimeError, internal_error, invalid_argument, protocol_error
from .protocol import (
    CHECK_IDS,
    DEFAULT_LIMITS,
    ERROR_CODES,
    FEATURE_OPS,
    JSONRPC,
    MAX_FRAME_BYTES,
    METHODS,
    NOTIFICATIONS,
    PREVIEW_VIEWS,
    PROTOCOL_VERSION,
    RPC_CODES,
    RUNTIME_FORMATS,
    RUNTIME_NAME,
    RUNTIME_VERSION,
)

#: Grace window after runtime.shutdown during which late frames still get answers.
STOP_DRAIN_SECONDS = 0.25
#: How long EOF/shutdown waits for worker frames to settle before hard exit.
EXIT_JOIN_SECONDS = 1.5
#: Maximum time runtime.hello waits for the build123d warmup so versions are real.
DEFAULT_WARMUP_TIMEOUT_MS = 180_000


class _BuildJob:
    """State of one in-flight ``model.build``."""

    __slots__ = ("request_id", "rpc_id", "params", "cancel_event", "state", "thread", "cancel_reason", "started_at")

    def __init__(self, request_id: str, rpc_id: Any, params: dict[str, Any]) -> None:
        self.request_id = request_id
        self.rpc_id = rpc_id
        self.params = params
        self.cancel_event = threading.Event()
        self.state = "queued"  # queued | running | done
        self.thread: threading.Thread | None = None
        self.cancel_reason = "cancelled by caller"
        self.started_at = time.monotonic()


class RuntimeServer:
    """The stdio JSON-RPC server. One instance per process."""

    def __init__(self, *, stdin_fd: int = 0, warmup_timeout_ms: int | None = None) -> None:
        self._stdin_fd = stdin_fd
        self._write_lock = threading.Lock()
        self._protocol_fd = os.dup(1)
        os.dup2(2, 1)  # anything accidentally written to stdout now goes to stderr
        sys.stdout = sys.stderr
        self._out = os.fdopen(self._protocol_fd, "wb", buffering=0)

        self._started = time.monotonic()
        self._stopping = threading.Event()
        self._stop_deadline: float | None = None
        self._pending: dict[str, _BuildJob] = {}
        self._pending_lock = threading.Lock()
        self._build_lock = threading.Lock()
        self._active_request_id: str | None = None
        self._counters = {"completed": 0, "failed": 0, "cancelled": 0}

        self._warmup_event = threading.Event()
        self._warmup: dict[str, Any] = {"state": "pending", "ms": None, "error": None, "startedAt": time.monotonic()}
        self._versions: dict[str, Any] = {
            "python": platform.python_version(),
            "pythonPath": sys.executable,
            "platform": f"{sys.platform}-{platform.machine()}",
            "build123d": None,
            "ocp": None,
            "trimesh": None,
            "numpy": None,
        }
        self._warmup_timeout_ms = int(
            warmup_timeout_ms
            if warmup_timeout_ms is not None
            else os.environ.get("DSH_CAD_WARMUP_TIMEOUT_MS", DEFAULT_WARMUP_TIMEOUT_MS)
        )
        self._log_level = os.environ.get("DSH_CAD_LOG_LEVEL", "info").lower()

    # -- logging -------------------------------------------------------------

    def _log(self, level: str, message: str) -> None:
        order = {"debug": 10, "info": 20, "warn": 30, "error": 40}
        if order.get(level, 20) < order.get(self._log_level, 20):
            return
        try:
            sys.stderr.write(f"[cad-runtime] {level} {message}\n")
            sys.stderr.flush()
        except Exception:  # pragma: no cover - stderr closed
            pass

    # -- warmup --------------------------------------------------------------

    def _start_warmup(self) -> None:
        thread = threading.Thread(target=self._warmup_worker, name="cad-warmup", daemon=True)
        thread.start()

    def _warmup_worker(self) -> None:
        started = time.monotonic()
        self._warmup["state"] = "warming"
        try:
            import numpy  # noqa: PLC0415
            import OCP  # noqa: PLC0415
            import trimesh  # noqa: PLC0415
            import build123d  # noqa: PLC0415

            self._versions.update(
                {
                    "build123d": getattr(build123d, "__version__", "unknown"),
                    "ocp": getattr(OCP, "__version__", "unknown"),
                    "trimesh": getattr(trimesh, "__version__", "unknown"),
                    "numpy": getattr(numpy, "__version__", "unknown"),
                }
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            self._warmup.update({"state": "ready", "ms": elapsed_ms})
            self._log("info", f"ready in {elapsed_ms} ms (build123d {self._versions['build123d']}, OCP {self._versions['ocp']})")
            self._notify(
                NOTIFICATIONS["log"],
                {
                    "level": "info",
                    "message": f"CAD runtime ready in {elapsed_ms} ms "
                    f"(python {self._versions['python']}, build123d {self._versions['build123d']}, OCP {self._versions['ocp']})",
                },
            )
        except Exception as exc:  # noqa: BLE001 - reported via hello/health
            self._warmup.update({"state": "failed", "error": str(exc), "ms": int((time.monotonic() - started) * 1000)})
            self._log("error", f"warmup failed: {exc}")
            traceback.print_exc()
            self._notify(NOTIFICATIONS["log"], {"level": "error", "message": f"CAD runtime warmup failed: {exc}"})
        finally:
            self._warmup_event.set()

    # -- wire I/O ------------------------------------------------------------

    def _write(self, frame: dict[str, Any]) -> None:
        try:
            payload = json.dumps(frame, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError) as exc:  # pragma: no cover - defensive
            self._log("error", f"could not serialise frame: {exc}")
            return
        try:
            with self._write_lock:
                self._out.write(payload + b"\n")
        except (BrokenPipeError, OSError):  # host went away
            self._stopping.set()
            if self._stop_deadline is None:
                self._stop_deadline = time.monotonic()

    def _respond(self, rpc_id: Any, result: Any) -> None:
        self._write({"jsonrpc": JSONRPC, "id": rpc_id, "result": result})

    def _respond_error(self, rpc_id: Any, error: CadRuntimeError) -> None:
        self._write({"jsonrpc": JSONRPC, "id": rpc_id, "error": error.to_rpc_error()})

    def _respond_parse_error(self, message: str) -> None:
        error = CadRuntimeError(ERROR_CODES["protocol"], message, {"id": None}, rpc_code=RPC_CODES["parse"])
        self._respond_error(None, error)

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"jsonrpc": JSONRPC, "method": method, "params": params})

    # -- frame handling ------------------------------------------------------

    def _safe_handle_line(self, line: bytes) -> None:
        """Dispatch one frame; a bug in handling must never kill the loop."""
        try:
            self._handle_line(line)
        except Exception as exc:  # noqa: BLE001 - last-resort frame guard
            self._log("error", f"frame handling crashed: {exc}")
            traceback.print_exc()
            try:
                self._respond_error(None, internal_error(f"internal runtime error while handling a frame: {exc}"))
            except Exception:  # pragma: no cover - stderr only
                pass

    def _handle_line(self, line: bytes) -> None:
        try:
            frame = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._respond_parse_error(f"malformed JSON frame: {exc}")
            return
        if not isinstance(frame, dict):
            self._respond_error(None, protocol_error("JSON-RPC frame must be a JSON object"))
            return
        raw_id = frame.get("id")
        rpc_id = self._valid_id(raw_id) if "id" in frame else None

        if frame.get("jsonrpc") != JSONRPC:
            # RFC 8259: echo the id when it is parseable, null otherwise.
            self._respond_error(rpc_id, protocol_error(f"jsonrpc must be \"{JSONRPC}\""))
            return

        method = frame.get("method")
        if not isinstance(method, str) or not method:
            self._respond_error(None, protocol_error("method must be a non-empty string"))
            return

        params = frame.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            if rpc_id is not None:
                self._respond_error(rpc_id, protocol_error("params must be a JSON object"))
            return

        if "id" not in frame:
            return  # inbound notifications are not part of the contract; ignore

        if rpc_id is None:
            self._respond_error(None, protocol_error("id must be a string or a number"))
            return

        handler = {
            METHODS["hello"]: self._on_hello,
            METHODS["health"]: self._on_health,
            METHODS["shutdown"]: self._on_shutdown,
            METHODS["build"]: self._on_build,
            METHODS["validate"]: self._on_validate,
            METHODS["cancel"]: self._on_cancel,
        }.get(method)
        if handler is None:
            error = CadRuntimeError(
                ERROR_CODES["protocol"],
                f"unknown method \"{method}\"",
                {"method": method},
                rpc_code=RPC_CODES["method_not_found"],
            )
            self._respond_error(rpc_id, error)
            return
        try:
            handler(rpc_id, params)
        except CadRuntimeError as exc:
            self._respond_error(rpc_id, exc)
        except Exception as exc:  # noqa: BLE001 - never let a handler kill the loop
            self._log("error", f"{method} handler crashed: {exc}")
            traceback.print_exc()
            self._respond_error(rpc_id, internal_error(f"internal runtime error in {method}: {exc}"))

    @staticmethod
    def _valid_id(raw_id: Any) -> Any:
        if isinstance(raw_id, bool):
            return None
        if isinstance(raw_id, str):
            return raw_id
        if isinstance(raw_id, (int, float)):
            return raw_id
        return None

    # -- methods -------------------------------------------------------------

    def _on_hello(self, rpc_id: Any, params: dict[str, Any]) -> None:
        client_version = params.get("protocolVersion")
        if client_version is not None:
            if not isinstance(client_version, str):
                raise invalid_argument("protocolVersion must be a string", path="/protocolVersion")
            if client_version != PROTOCOL_VERSION:
                expected, received = PROTOCOL_VERSION, client_version
                raise CadRuntimeError(
                    ERROR_CODES["versionMismatch"],
                    f"protocol version mismatch: client sent {received}, runtime speaks {expected}",
                    {"expected": expected, "received": received, "supported": [expected]},
                    rpc_code=RPC_CODES["application"],
                )
        self._warmup_event.wait(self._warmup_timeout_ms / 1000.0)
        ready = self._warmup["state"] == "ready"
        self._respond(
            rpc_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "ready": ready,
                "runtime": {
                    "name": RUNTIME_NAME,
                    "version": RUNTIME_VERSION,
                    **self._versions,
                },
                "warmup": self._warmup_snapshot(),
                "capabilities": {
                    "formats": list(RUNTIME_FORMATS),
                    "checks": list(CHECK_IDS),
                    "previewViews": list(PREVIEW_VIEWS),
                    "features": list(FEATURE_OPS),
                    "limits": dict(DEFAULT_LIMITS),
                },
            },
        )

    def _warmup_snapshot(self) -> dict[str, Any]:
        snapshot = {"state": self._warmup["state"], "ms": self._warmup["ms"]}
        if self._warmup.get("error"):
            snapshot["error"] = self._warmup["error"]
        return snapshot

    def _on_health(self, rpc_id: Any, params: dict[str, Any]) -> None:
        with self._pending_lock:
            jobs = list(self._pending.values())
        active = sum(1 for job in jobs if job.state == "running")
        warmup_state = self._warmup["state"]
        if self._stopping.is_set():
            status = "stopping"
        elif warmup_state == "failed":
            status = "degraded"
        elif warmup_state == "ready":
            status = "ready"
        else:
            status = "starting"
        self._respond(
            rpc_id,
            {
                "ok": True,
                "pid": os.getpid(),
                "uptimeMs": int((time.monotonic() - self._started) * 1000),
                "protocolVersion": PROTOCOL_VERSION,
                "status": status,
                "ready": warmup_state == "ready",
                "busy": self._active_request_id is not None,
                "jobs": len(jobs),
                "activeBuilds": active,
                "counters": dict(self._counters),
                "warmup": self._warmup_snapshot(),
                "versions": dict(self._versions),
            },
        )

    def _on_shutdown(self, rpc_id: Any, params: dict[str, Any]) -> None:
        already = self._stopping.is_set()
        self._respond(rpc_id, {"ok": True, "stopping": True, "alreadyStopping": already})
        reason = params.get("reason")
        self._begin_stop(reason if isinstance(reason, str) else "runtime.shutdown")

    def _on_build(self, rpc_id: Any, params: dict[str, Any]) -> None:
        if self._stopping.is_set():
            raise protocol_error("runtime is shutting down")
        request_id = builder.request_id_from(params)
        with self._pending_lock:
            if request_id in self._pending:
                raise protocol_error("duplicate in-flight requestId", requestId=request_id)
            job = _BuildJob(request_id, rpc_id, dict(params))
            self._pending[request_id] = job
        job.thread = threading.Thread(
            target=self._run_build_job,
            args=(job,),
            name=f"cad-build-{request_id}",
            daemon=True,
        )
        job.thread.start()

    def _on_validate(self, rpc_id: Any, params: dict[str, Any]) -> None:
        if self._stopping.is_set():
            raise protocol_error("runtime is shutting down")
        self._respond(rpc_id, builder.run_validate(params))

    def _on_cancel(self, rpc_id: Any, params: dict[str, Any]) -> None:
        request_id = builder.request_id_from(params, required=True)
        with self._pending_lock:
            job = self._pending.get(request_id)
        if job is None:
            self._respond(rpc_id, {"ok": True, "cancelled": False, "requestId": request_id})
            return
        reason = params.get("reason")
        if isinstance(reason, str) and reason:
            job.cancel_reason = reason
        job.cancel_event.set()
        self._respond(rpc_id, {"ok": True, "cancelled": True, "requestId": request_id})

    # -- build worker --------------------------------------------------------

    def _run_build_job(self, job: _BuildJob) -> None:
        acquired = False
        try:
            # Serialise builds; stay cancellable while queued.
            while not self._build_lock.acquire(timeout=0.05):
                if job.cancel_event.is_set() or self._stopping.is_set():
                    self._settle_aborted(job)
                    return
            acquired = True
            if job.cancel_event.is_set() or self._stopping.is_set():
                self._settle_aborted(job)
                return
            job.state = "running"
            self._active_request_id = job.request_id
            progress = self._progress_callback(job)
            result = builder.run_build(job.params, cancel_event=job.cancel_event, progress=progress)
            status = result.get("status")
            error = result.get("error") or {}
            if status == "built":
                self._counters["completed"] += 1
            elif error.get("code") == ERROR_CODES["cancelled"]:
                self._counters["cancelled"] += 1
            else:
                self._counters["failed"] += 1
            self._respond(job.rpc_id, result)
        except CadRuntimeError as exc:
            self._counters["failed"] += 1
            self._respond_error(job.rpc_id, exc)
        except Exception as exc:  # noqa: BLE001 - never leave a request unanswered
            self._counters["failed"] += 1
            self._log("error", f"build {job.request_id} crashed: {exc}")
            traceback.print_exc()
            self._respond_error(job.rpc_id, internal_error(f"internal runtime error during build: {exc}", requestId=job.request_id))
        finally:
            if acquired:
                self._active_request_id = None
                self._build_lock.release()
            job.state = "done"
            with self._pending_lock:
                self._pending.pop(job.request_id, None)

    def _settle_aborted(self, job: _BuildJob) -> None:
        reason = job.cancel_reason if job.cancel_event.is_set() else "runtime is shutting down"
        try:
            result = builder.aborted_result(job.request_id, job.params, reason)
            self._counters["cancelled"] += 1
            self._respond(job.rpc_id, result)
        finally:
            job.state = "done"
            with self._pending_lock:
                self._pending.pop(job.request_id, None)

    def _progress_callback(self, job: _BuildJob) -> Callable[[str, int, str], None] | None:
        if job.params.get("progress", True) is False:
            return None

        def progress(phase: str, percent: int, message: str) -> None:
            self._notify(
                NOTIFICATIONS["progress"],
                {
                    "requestId": job.request_id,
                    "phase": phase,
                    "percent": max(0, min(100, int(percent))),
                    "message": message,
                },
            )

        return progress

    # -- stop / lifecycle ----------------------------------------------------

    def _begin_stop(self, reason: str) -> None:
        if not self._stopping.is_set():
            self._log("info", f"stopping: {reason}")
        self._stopping.set()
        if self._stop_deadline is None:
            self._stop_deadline = time.monotonic() + STOP_DRAIN_SECONDS
        with self._pending_lock:
            jobs = list(self._pending.values())
        for job in jobs:
            job.cancel_event.set()

    def _on_signal(self, signum: int, _frame: Any) -> None:
        self._begin_stop(f"signal {signum}")

    def _install_signal_handlers(self) -> None:
        for signame in ("SIGTERM", "SIGINT"):
            signum = getattr(signal, signame, None)
            if signum is None:
                continue
            try:
                signal.signal(signum, self._on_signal)
            except (ValueError, OSError):  # pragma: no cover - not the main thread
                pass
        try:
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        except (AttributeError, ValueError, OSError):  # pragma: no cover - not POSIX
            pass

    def serve(self) -> int:
        """Run the protocol loop until shutdown/EOF/signal. Returns exit code."""
        self._install_signal_handlers()
        self._start_warmup()
        buffer = bytearray()
        discarding = False
        while True:
            # 1. drop the remainder of a refused oversize frame.
            if discarding:
                index = buffer.find(b"\n")
                if index < 0:
                    buffer.clear()
                else:
                    del buffer[: index + 1]
                    discarding = False
            # 2. process every complete line.
            while True:
                index = buffer.find(b"\n")
                if index < 0:
                    break
                line = bytes(buffer[:index])
                del buffer[: index + 1]
                if line.strip():
                    self._safe_handle_line(line)
            # 3. refuse a frame that grew beyond the limit.
            if len(buffer) > MAX_FRAME_BYTES:
                index = buffer.find(b"\n")
                if index >= 0:
                    del buffer[: index + 1]
                else:
                    buffer.clear()
                    discarding = True
                self._respond_parse_error(f"frame exceeds MAX_FRAME_BYTES ({MAX_FRAME_BYTES} bytes)")
            # 4. stop conditions.
            if self._stopping.is_set() and self._stop_deadline is not None and time.monotonic() >= self._stop_deadline:
                break
            # 5. wait for input.
            timeout = 0.05 if self._stopping.is_set() else 0.2
            try:
                ready, _, _ = select.select([self._stdin_fd], [], [], timeout)
            except InterruptedError:  # pragma: no cover - signal race
                continue
            except (OSError, ValueError):  # pragma: no cover - stdin closed
                break
            if not ready:
                continue
            try:
                chunk = os.read(self._stdin_fd, 65536)
            except OSError:  # pragma: no cover - stdin closed
                chunk = b""
            if not chunk:
                # Host died (EOF) or closed the pipe: never outlive it.
                if buffer.strip():
                    self._respond_parse_error("stdin reached EOF in the middle of a frame")
                self._begin_stop("stdin EOF")
                self._stop_deadline = time.monotonic()
                break
            buffer.extend(chunk)

        self._finalise()
        return 0

    def _finalise(self) -> None:
        self._begin_stop("runtime exiting")
        deadline = time.monotonic() + EXIT_JOIN_SECONDS
        with self._pending_lock:
            jobs = list(self._pending.values())
        for job in jobs:
            job.cancel_event.set()
        for job in jobs:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if job.thread is not None and job.thread.is_alive():
                job.thread.join(remaining)
        with self._pending_lock:
            still_pending = len(self._pending)
        if still_pending:
            self._log("warn", f"{still_pending} build(s) did not settle before exit")
        self._log("info", "runtime exiting")
