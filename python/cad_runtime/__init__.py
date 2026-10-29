"""The dsh-plugin-cad Python CAD runtime.

Public entry points:

* ``python -m cad_runtime`` -- stdio JSON-RPC server (the normal path);
* ``python -m cad_runtime --selftest`` -- build the acceptance bracket in-process
  and print one JSON status object (used by ``python/setup-runtime.mjs``);
* ``python -m cad_runtime --version``.

The wire contract is documented in ``docs/CAD_RUNTIME_PROTOCOL.md`` and mirrored
from ``src/contracts/protocol.js``.
"""

from __future__ import annotations

from .protocol import DOCUMENT_SCHEMA, PROTOCOL_VERSION, RUNTIME_NAME, RUNTIME_VERSION

__all__ = ["DOCUMENT_SCHEMA", "PROTOCOL_VERSION", "RUNTIME_NAME", "RUNTIME_VERSION", "__version__"]

__version__ = RUNTIME_VERSION
