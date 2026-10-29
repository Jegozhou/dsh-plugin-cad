"""Command-line entry point: ``python -m cad_runtime``."""

from __future__ import annotations

import argparse
import os
import sys

from .protocol import PROTOCOL_VERSION, RUNTIME_NAME, RUNTIME_VERSION


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m cad_runtime",
        description="dsh-plugin-cad Python CAD runtime (build123d/OpenCASCADE) speaking JSON-RPC over stdio.",
    )
    parser.add_argument("--version", action="store_true", help="print the runtime/protocol version and exit")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="build the acceptance bracket in-process and print one JSON status object, then exit",
    )
    parser.add_argument(
        "--formats",
        default="step,glb,stl,svg",
        help="comma separated artifact formats for --selftest (default: step,glb,stl,svg)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.version:
        print(f"{RUNTIME_NAME} {RUNTIME_VERSION} protocol {PROTOCOL_VERSION}")
        return 0
    if args.selftest:
        from .selftest import run_selftest  # noqa: PLC0415

        formats = [item.strip() for item in str(args.formats).split(",") if item.strip()]
        return run_selftest(formats=formats)

    from .server import RuntimeServer  # noqa: PLC0415

    server = RuntimeServer()
    code = server.serve()
    try:
        sys.stderr.flush()
    except Exception:  # pragma: no cover
        pass
    # Hard exit: guarantees no worker thread can keep the process alive after the
    # host died (no orphan Python processes after uninstall/restart).
    os._exit(code)
    return code  # pragma: no cover - unreachable


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
