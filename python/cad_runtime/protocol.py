"""Wire contract for the dsh-plugin-cad Python CAD runtime.

This module is the Python mirror of ``src/contracts/protocol.js``. The values are
part of the plugin's public contract and are asserted against the JavaScript
file by ``tests/python/test_contracts.py``; changing a value here without
changing it there is a bug.

Transport: newline-delimited JSON-RPC 2.0 over stdio. One JSON object per line,
UTF-8, no embedded newlines. ``stdout`` carries protocol frames only; every
diagnostic goes to ``stderr``.

No build123d/OpenCASCADE import may happen from this module (it is imported by
the server before warmup) so that ``runtime.hello`` / ``runtime.health`` answer
instantly even on a cold virtualenv.
"""

from __future__ import annotations

from types import MappingProxyType

# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------

#: Wire protocol version. Bumped only on incompatible wire changes.
PROTOCOL_VERSION = "1.0"

#: Declarative CAD document schema id (see docs/research/SPEC_P0.md §3).
DOCUMENT_SCHEMA = "dsh.cad/document@1"

#: Geometry report schema id produced by this runtime.
REPORT_SCHEMA = "dsh.cad/geometry-report@1"

#: Runtime identity reported by ``runtime.hello``.
RUNTIME_NAME = "cad-runtime"
RUNTIME_VERSION = "0.1.0"

#: JSON-RPC protocol revision.
JSONRPC = "2.0"

# ---------------------------------------------------------------------------
# Methods and notifications (identical to src/contracts/protocol.js)
# ---------------------------------------------------------------------------

METHODS = MappingProxyType(
    {
        "hello": "runtime.hello",
        "health": "runtime.health",
        "shutdown": "runtime.shutdown",
        "build": "model.build",
        "validate": "model.validate",
        "cancel": "job.cancel",
    }
)

NOTIFICATIONS = MappingProxyType(
    {
        "progress": "build.progress",
        "log": "runtime.log",
    }
)

#: Stable error codes crossing the boundary (identical to protocol.js).
ERROR_CODES = MappingProxyType(
    {
        "protocol": "protocol_error",
        "versionMismatch": "protocol_version_mismatch",
        "invalid": "invalid_document",
        "unsupportedOp": "unsupported_operation",
        "buildFailed": "build_failed",
        "invalidGeometry": "invalid_geometry",
        "exportFailed": "export_failed",
        "cancelled": "cancelled",
        "timeout": "timeout",
        "internal": "internal_error",
    }
)

#: Codes the runtime may emit for malformed request parameters. ``invalid_argument``
#: is the host-local code from ``src/contracts/errors.js``; it is used only for
#: runtime-level parameter rejections, never for document content.
INVALID_ARGUMENT = "invalid_argument"

#: Artifact formats (model.build ``formats`` subset, protocol.js EXPORT_FORMATS).
EXPORT_FORMATS = ("step", "glb", "stl")

#: Every format the runtime can write, including the SVG projection preview.
RUNTIME_FORMATS = ("step", "glb", "stl", "svg")

#: Fixed artifact filenames. The host serves ``model.glb``.
ARTIFACT_FILENAMES = MappingProxyType(
    {
        "step": "model.step",
        "glb": "model.glb",
        "stl": "model.stl",
        "svg": "preview.svg",
    }
)

ARTIFACT_CONTENT_TYPES = MappingProxyType(
    {
        "step": "application/step",
        "glb": "model/gltf-binary",
        "stl": "model/stl",
        "svg": "image/svg+xml",
    }
)

#: Geometry check ids, in report order (SPEC_P0.md §5).
CHECK_IDS = (
    "document_schema",
    "single_solid",
    "brep_valid",
    "positive_volume",
    "closed_shell",
    "bounding_box",
    "feature_effects",
    "wall_thickness",
)

#: Preview views accepted by ``preview.view``.
PREVIEW_VIEWS = ("iso", "front", "top", "right")

#: Feature operations of the declarative catalogue (SPEC_P0.md §3.1).
FEATURE_OPS = (
    "box",
    "cylinder",
    "hole",
    "hole_pattern",
    "fillet",
    "chamfer",
    "cut",
    "union",
)

#: Hard cap on one protocol line before the frame is refused (protocol.js).
MAX_FRAME_BYTES = 8 * 1024 * 1024

#: Default limits applied when ``model.build`` omits them.
DEFAULT_LIMITS = MappingProxyType(
    {
        "maxBoundingBoxMm": 2000.0,
        "maxArtifactBytes": 134217728,
        "maxFeatures": 64,
        "maxParameters": 64,
        "minWallThicknessMm": 0.2,
        "meshToleranceMm": 0.1,
        "meshAngularToleranceRad": 0.2,
    }
)

# ---------------------------------------------------------------------------
# JSON-RPC numeric error codes
# ---------------------------------------------------------------------------

#: RFC 8259 / JSON-RPC 2.0 reserved codes plus the application range.
RPC_CODES = MappingProxyType(
    {
        "parse": -32700,
        "invalid_request": -32600,
        "method_not_found": -32601,
        "invalid_params": -32602,
        "internal": -32603,
        "application": -32000,
    }
)

#: Stable runtime error code -> JSON-RPC numeric code.
RPC_CODE_FOR_ERROR = MappingProxyType(
    {
        ERROR_CODES["protocol"]: RPC_CODES["invalid_request"],
        ERROR_CODES["versionMismatch"]: RPC_CODES["invalid_request"],
        ERROR_CODES["invalid"]: RPC_CODES["invalid_params"],
        ERROR_CODES["unsupportedOp"]: RPC_CODES["method_not_found"],
        ERROR_CODES["buildFailed"]: RPC_CODES["application"],
        ERROR_CODES["invalidGeometry"]: RPC_CODES["application"],
        ERROR_CODES["exportFailed"]: RPC_CODES["application"],
        ERROR_CODES["cancelled"]: RPC_CODES["application"],
        ERROR_CODES["timeout"]: RPC_CODES["application"],
        ERROR_CODES["internal"]: RPC_CODES["internal"],
        INVALID_ARGUMENT: RPC_CODES["invalid_params"],
    }
)

#: Report-level status values (SPEC_P0.md §5: pass/fail/warn).
CHECK_STATUSES = ("pass", "fail", "warn")
