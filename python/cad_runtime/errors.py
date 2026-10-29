"""Structured errors for the CAD runtime.

Every failure that can reach the host is a :class:`CadRuntimeError` carrying
three things:

* ``code`` -- one of the stable codes in :mod:`cad_runtime.protocol.ERROR_CODES`
  (or ``invalid_argument`` for malformed runtime parameters);
* ``message`` -- one human/model readable sentence;
* ``details`` -- lossless JSON context, always with an RFC 6901 JSON-pointer
  ``path`` when a specific document field is at fault.

The server serialises it as a JSON-RPC error whose ``data`` member is exactly
``{"code", "message", "details"}`` so the host can map ``data.code`` back to its
own ``CadError`` taxonomy.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .protocol import ERROR_CODES, INVALID_ARGUMENT, RPC_CODE_FOR_ERROR, RPC_CODES


def json_pointer(*parts: object) -> str:
    """Build an RFC 6901 JSON pointer from path parts.

    ``json_pointer()`` is the empty string (the whole document), integers become
    array indices, and ``~``/``/`` in names are escaped.

    >>> json_pointer("features", 1, "diameter")
    '/features/1/diameter'
    """
    out = []
    for part in parts:
        token = str(part).replace("~", "~0").replace("/", "~1")
        out.append("/" + token)
    return "".join(out)


def bracket_path(*parts: object) -> str:
    """Host-readable variant of a path: ``features[1].diameter``.

    Only used inside ``details.violations`` as a convenience for humans; the
    authoritative ``details.path`` is always a JSON pointer.
    """
    out = ""
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += ("." if out else "") + str(part)
    return out


class CadRuntimeError(Exception):
    """A structured runtime failure that maps onto the wire contract."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Mapping[str, Any] | None = None,
        *,
        rpc_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: dict[str, Any] = dict(details or {})
        self.rpc_code = rpc_code if rpc_code is not None else RPC_CODE_FOR_ERROR.get(code, RPC_CODES["application"])

    # -- construction helpers -------------------------------------------------

    def with_details(self, **extra: Any) -> "CadRuntimeError":
        self.details.update(extra)
        return self

    # -- wire form ------------------------------------------------------------

    def data(self) -> dict[str, Any]:
        """The JSON-RPC ``error.data`` payload."""
        return {"code": self.code, "message": self.message, "details": self.details}

    def to_rpc_error(self) -> dict[str, Any]:
        """The full JSON-RPC ``error`` member."""
        return {"code": self.rpc_code, "message": self.message, "data": self.data()}

    def to_result_error(self) -> dict[str, Any]:
        """The ``error`` member of a normal ``status:"failed"`` build result."""
        return {"code": self.code, "message": self.message, "details": self.details}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"CadRuntimeError(code={self.code!r}, message={self.message!r}, details={self.details!r})"


# ---------------------------------------------------------------------------
# Canonical constructors
# ---------------------------------------------------------------------------


def protocol_error(message: str, details: Mapping[str, Any] | None = None, **extra: Any) -> CadRuntimeError:
    merged: dict[str, Any] = dict(details or {})
    merged.update(extra)
    return CadRuntimeError(ERROR_CODES["protocol"], message, merged)


def invalid_document(
    message: str,
    *,
    path: str = "",
    violations: Iterable[Mapping[str, Any]] | None = None,
    **extra: Any,
) -> CadRuntimeError:
    details: dict[str, Any] = {"path": path}
    if violations is not None:
        details["violations"] = [dict(v) for v in violations]
    details.update(extra)
    return CadRuntimeError(ERROR_CODES["invalid"], message, details)


def unsupported_operation(message: str, **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["unsupportedOp"], message, details)


def invalid_geometry(message: str, **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["invalidGeometry"], message, details)


def build_failed(message: str, **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["buildFailed"], message, details)


def export_failed(message: str, **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["exportFailed"], message, details)


def cancelled(message: str = "build cancelled", **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["cancelled"], message, details)


def internal_error(message: str, **details: Any) -> CadRuntimeError:
    return CadRuntimeError(ERROR_CODES["internal"], message, details)


def invalid_argument(message: str, *, path: str = "", **extra: Any) -> CadRuntimeError:
    details = {"path": path}
    details.update(extra)
    return CadRuntimeError(INVALID_ARGUMENT, message, details)
