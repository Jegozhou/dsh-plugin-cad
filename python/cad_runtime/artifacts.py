"""Atomic, confined artifact writing.

Every artifact is committed with ``tmp file + atomic link`` inside the caller's
``outputDir``:

* the final name is never overwritten (``os.link`` fails with ``EEXIST``);
* a SIGKILL can only ever leave a hidden ``.dsh-cad-tmp-*`` file, never a
  partially written artifact (the next build sweeps those files);
* the runtime refuses to write outside ``outputDir`` and never creates
  subdirectories;
* ``bytes``/``sha256`` are computed from the committed bytes.

Filenames are fixed by the protocol: ``model.step``, ``model.glb``,
``model.stl``, ``preview.svg``.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .errors import export_failed, invalid_argument
from .protocol import ARTIFACT_CONTENT_TYPES, ARTIFACT_FILENAMES

TEMP_PREFIX = ".dsh-cad-tmp-"

ArtifactWriter = Callable[[str], None]


@dataclass(frozen=True)
class Artifact:
    format: str
    file_name: str
    path: str
    content_type: str

    def to_dict(self, size: int, sha256: str) -> dict[str, Any]:
        return {
            "format": self.format,
            "fileName": self.file_name,
            "bytes": int(size),
            "sha256": sha256,
            "contentType": self.content_type,
        }


def artifact_for_dir(output_dir: str, fmt: str) -> Artifact:
    filename = ARTIFACT_FILENAMES[fmt]
    return Artifact(
        format=fmt,
        file_name=filename,
        path=os.path.join(output_dir, filename),
        content_type=ARTIFACT_CONTENT_TYPES[fmt],
    )


def resolve_output_dir(raw: Any) -> str:
    """Validate ``outputDir`` and return its resolved absolute path."""
    if not isinstance(raw, str) or not raw:
        raise invalid_argument("outputDir is required and must be an absolute path string", path="/outputDir")
    if "\x00" in raw:
        raise invalid_argument("outputDir contains a NUL byte", path="/outputDir")
    if not os.path.isabs(raw):
        raise invalid_argument("outputDir must be an absolute path", path="/outputDir")
    try:
        os.makedirs(raw, exist_ok=True)
    except OSError as exc:
        raise invalid_argument(f"outputDir could not be created: {exc}", path="/outputDir") from exc
    resolved = os.path.realpath(raw)
    if not os.path.isdir(resolved):
        raise invalid_argument("outputDir is not a directory", path="/outputDir")
    return resolved


def sweep_stale_temps(output_dir: str) -> int:
    """Remove hidden temp files left by a previous SIGKILLed build."""
    removed = 0
    try:
        entries = os.listdir(output_dir)
    except OSError:  # pragma: no cover - defensive
        return 0
    for name in entries:
        if not name.startswith(TEMP_PREFIX):
            continue
        candidate = os.path.join(output_dir, name)
        try:
            if os.path.isfile(candidate) and not os.path.islink(candidate):
                os.unlink(candidate)
                removed += 1
        except OSError:  # pragma: no cover - defensive
            continue
    return removed


def write_atomic(
    output_dir: str,
    fmt: str,
    *,
    data: bytes | None = None,
    writer: ArtifactWriter | None = None,
    max_bytes: int | None = None,
) -> tuple[Artifact, int, str]:
    """Commit one artifact atomically. Returns ``(artifact, bytes, sha256)``."""
    if fmt not in ARTIFACT_FILENAMES:  # pragma: no cover - guarded by the caller
        raise export_failed(f"unknown artifact format {fmt!r}", format=fmt)
    artifact = artifact_for_dir(output_dir, fmt)
    target = artifact.path
    if os.path.dirname(os.path.realpath(target)) != output_dir:
        raise export_failed("artifact path escapes outputDir", path=target)
    if os.path.exists(target) or os.path.islink(target):
        raise export_failed(
            f"artifact {artifact.file_name} already exists; refusing to overwrite",
            fileName=artifact.file_name,
            reason="artifact_exists",
        )
    suffix = os.path.splitext(artifact.file_name)[1] or ".tmp"
    fd, tmp_path = tempfile.mkstemp(dir=output_dir, prefix=TEMP_PREFIX, suffix=suffix)
    os.close(fd)
    try:
        if writer is not None:
            writer(tmp_path)
        elif data is not None:
            with open(tmp_path, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        else:  # pragma: no cover - programming error
            raise export_failed("no data or writer supplied", format=fmt)
        if not os.path.isfile(tmp_path):
            raise export_failed(f"artifact {artifact.file_name} was not produced", format=fmt)
        size = os.path.getsize(tmp_path)
        if max_bytes is not None and int(max_bytes) > 0 and size > int(max_bytes):
            raise export_failed(
                f"artifact {artifact.file_name} is {size} bytes, above maxArtifactBytes {int(max_bytes)}",
                fileName=artifact.file_name,
                bytes=size,
                reason="artifact_too_large",
            )
        digest = _sha256_file(tmp_path)
        try:
            os.link(tmp_path, target)  # atomic create, fails if target exists
        except FileExistsError as exc:
            raise export_failed(
                f"artifact {artifact.file_name} already exists; refusing to overwrite",
                fileName=artifact.file_name,
                reason="artifact_exists",
            ) from exc
        except OSError:
            # Filesystems without hard links: fall back to an exclusive create.
            if os.path.exists(target):
                raise export_failed(
                    f"artifact {artifact.file_name} already exists; refusing to overwrite",
                    fileName=artifact.file_name,
                    reason="artifact_exists",
                )
            os.replace(tmp_path, target)
            tmp_path = ""  # consumed by replace
        os.chmod(target, 0o644)
        _fsync_dir(output_dir)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:  # pragma: no cover - defensive
                pass
    return artifact, size, digest


def remove_artifacts(paths: Iterable[str]) -> None:
    """Remove artifacts written by a failed/cancelled build (best effort)."""
    for path in paths:
        try:
            os.unlink(path)
        except FileNotFoundError:
            continue
        except OSError:  # pragma: no cover - defensive
            continue


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:  # pragma: no cover - defensive
        return
    try:
        os.fsync(fd)
    except OSError:  # pragma: no cover - defensive
        pass
    finally:
        os.close(fd)
