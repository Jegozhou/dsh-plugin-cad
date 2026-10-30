# STATUS — Python CAD runtime (runtime-eng)

Owner: **runtime-eng**. Write scope: `python/**`, `tests/python/**`,
`docs/CAD_RUNTIME_PROTOCOL.md`, `docs/research/STATUS_runtime.md`.
Wire contract: [`docs/CAD_RUNTIME_PROTOCOL.md`](../CAD_RUNTIME_PROTOCOL.md)
(implementation reference) and `src/contracts/protocol.js` (constant source of
truth). Product contract: [`SPEC_P0.md`](SPEC_P0.md).

Last updated: 2026-10-30 (runs on this machine, macOS `darwin-arm64`; all
numbers below were measured, not estimated).

---

## 1. What is implemented

### Process and transport (`python/cad_runtime/server.py`)

* One long-lived process: `python -m cad_runtime` (cwd `<pkg>/python`,
  `PYTHONPATH=<pkg>/python`). Newline-delimited JSON-RPC 2.0 on stdout only;
  fd 1 is redirected to stderr at startup and the protocol keeps a duplicated
  handle, so dependency prints cannot corrupt the frame stream.
* Methods: `runtime.hello`, `runtime.health`, `runtime.shutdown`,
  `model.build`, `model.validate`, `job.cancel`.
* Notifications: `build.progress` (`{requestId, phase, percent, message}`,
  phases `validating|building|exporting|done`) and `runtime.log`
  (`{level, message}`).
* Reader loop stays on the main thread; builds run on daemon worker threads
  serialised by a build lock, so `job.cancel`/`runtime.health` are answered
  during a build. Warmup (build123d/trimesh/numpy/OCP import) runs in its own
  thread; `hello` waits for it (bounded 180 s, `DSH_CAD_WARMUP_TIMEOUT_MS`) so
  reported versions are real; `health` never blocks.
* Bad frames never kill the process: malformed JSON → `-32700`, unknown method
  → `-32601`, bad envelope/params → `-32600/-32602`, duplicate in-flight
  `requestId` → `protocol_error`. Frames > 8 MiB are refused and discarded to
  the next newline.
* Lifecycle: `runtime.shutdown` answers `{ok,stopping}` then exits 0; double
  shutdown stays idempotent; **stdin EOF** (host died, incl. SIGKILL) cancels
  jobs and exits within ~0.5 s with `os._exit(0)` so no orphan Python survives.
  SIGTERM/SIGINT take the same path.
* Structured errors: JSON-RPC `error.data = {code, message, details}` with
  `details.path` as an RFC 6901 JSON pointer and `details.violations` for
  document rejection.

### Document engine (`python/cad_runtime/document.py`)

Strict validation of `dsh.cad/document@1` with **no eval/exec/import/network**:
closed feature catalogue, 1..64 features, unique ids, ≤64 parameters, `"$name"`
references resolved and range-checked, JSON-pointer paths, all violations
reported (no partial application). Rejections verified by tests.

### Geometry (`python/cad_runtime/geometry.py`)

Declarative ops: `box`, `cylinder`, `hole` (`through`, blind `depth`, `face`,
axis x/y/z with `at` mapped per axis), `hole_pattern`
(`rect_corners`/`grid`/`bolt_circle`), `fillet`/`chamfer`
(`vertical_edges|top_edges|bottom_edges|all_edges`), `cut`, `union`.
Checks: `document_schema`, `single_solid`, `brep_valid`, `positive_volume`,
`closed_shell`, `bounding_box`, `feature_effects` (cylindrical-face detection
catches silently absorbed holes), `wall_thickness` (warn only). Geometry report
carries volume/area/bbox/centroid/topology/per-feature status/warnings/timings.

Hole patterns cut in batches (`shape.cut(*tools)`) — a 10×10 pattern dropped
from **3.8 s to ~0.55 s** — and cancellation is checked between batches and
between features, so a cancel settles within one cheap boolean.

### Artifacts (`python/cad_runtime/artifacts.py`, `mesh.py`, `render.py`)

Fixed filenames inside the caller's `outputDir`: `model.step`, `model.glb`,
`model.stl` (on request), `preview.svg` (when `formats` contains `svg`).
Tmp-file + atomic `link` commit, `fsync`, `sha256`+bytes measured from the
committed file, never overwrite an existing file (including symlinks), stale
`.dsh-cad-tmp-*` sweep, no subdirectories, failed/cancelled builds unlink
everything they wrote. STEP via OCCT `STEPControl`; GLB is the welded
tessellation converted **Z-up → Y-up** (determinant +1, winding preserved);
STL binary in CAD coords; SVG hidden-line projection via OCCT HLR with dashed
hidden edges, pixel `width`/`height` while keeping the mm `viewBox`.

### Installer (`python/setup-runtime.mjs`) and pins

`node python/setup-runtime.mjs [--check] [--repair] [--no-dev] [--venv <dir>]`
creates/repairs `python/.venv` (or `$DSH_CAD_VENV`) with uv-managed CPython 3.12,
installs `python/requirements.txt` (+ `requirements-dev.txt` with pytest unless
`--no-dev`), then runs the in-process self-test. Prints exactly one JSON object
on stdout, human output on stderr, non-zero exit + `recovery` on failure. No
sudo, no telemetry, no network beyond the package index.

Resolved environment (verified here):

| item | value |
| --- | --- |
| interpreter | CPython **3.12.13** (uv-managed; Homebrew Pythons are broken for uv here) |
| venv | `<repo>/python/.venv` |
| build123d | `0.13.0` |
| OpenCASCADE | `cadquery-ocp-novtk==8.0.1.1.0` (OCP `8.0.1.1`) |
| trimesh | `5.2.0` |
| numpy | `2.5.4` |
| pytest | `9.2.0` (dev) |
| lock | `python/requirements.lock.txt` (65 lines, full freeze) |

---

## 2. Commands run (real)

```sh
# environment creation (uv at /opt/homebrew/bin/uv)
/opt/homebrew/bin/uv venv --python 3.12 dsh-plugin-cad/python/.venv
/opt/homebrew/bin/uv pip install --python dsh-plugin-cad/python/.venv/bin/python \
  -r dsh-plugin-cad/python/requirements.txt -r dsh-plugin-cad/python/requirements-dev.txt

# runtime self-test (real build + all four exports)
cd dsh-plugin-cad/python && ./.venv/bin/python -m cad_runtime --selftest

# installer contract
node python/setup-runtime.mjs --check
node python/setup-runtime.mjs

# full Python test suite
cd dsh-plugin-cad && python/.venv/bin/python -m pytest tests/python -q
```

### Self-test output (real, `--selftest` builds + exports all four formats)

```json
{"ok": true, "status": "ok",
 "versions": {"python": "3.12.13", "pythonPath": ".../python/.venv/bin/python",
              "build123d": "0.13.0", "ocp": "8.0.1.1", "trimesh": "5.2.0", "numpy": "2.5.4"},
 "geometry": {"volume": 34981.947193, "surfaceArea": 12091.327412,
              "boundingBox": {"min": [-40.0, -30.0, -4.0], "max": [40.0, 30.0, 4.0], "size": [80.0, 60.0, 8.0]},
              "topology": {"faces": 11, "edges": 27, "vertices": 18, "solids": 1},
              "checks": [8 x "pass"], "warnings": [],
              "timings": {"totalMs": 56.6, "buildMs": 6.7, "exportMs": 15.0}},
 "artifacts": [
   {"format": "step", "fileName": "model.step", "bytes": 33561, "sha256": "a22236a35dc9e6e8..."},
   {"format": "glb",  "fileName": "model.glb",  "bytes": 31788, "sha256": "ec709cdbf4dc0a10..."},
   {"format": "stl",  "fileName": "model.stl",  "bytes": 64684, "sha256": "4db70f7729b101cf..."},
   {"format": "svg",  "fileName": "preview.svg", "bytes": 5709,  "sha256": "a2b2c7236ada4872..."}],
 "importMs": 1095.8, "selftestMs": 1153.5}
```

Analytic acceptance volume: `80·60·8 − π·10²·8 − 4·π·3²·8 = 34981.947192894295 mm³`;
the measured B-rep and the STEP round-trip are identical to machine precision.

### Installer output (real, `--check`)

```json
{"ok": true, "action": "check", "venv": ".../python/.venv",
 "pinned": {"build123d": "0.13.0", "trimesh": "5.2.0", "numpy": "2.5.4"},
 "installed": {"build123d": "0.13.0", "trimesh": "5.2.0", "numpy": "2.5.4", "pytest": "9.2.0"},
 "created": false, "repaired": false, "timings": {"totalMs": 74}}
```

`node python/setup-runtime.mjs` (full idempotent path, warm): `ok:true`,
`timings {totalMs: 1824, installMs: 82, selfTestMs: 1693}`.

### Test suite output (real — reproduced twice, no flakes)

```
$ python/.venv/bin/python -m pytest tests/python -q
...............................................                          [100%]
119 passed in 36.75s
```

(second consecutive run: `119 passed in 37.03s`)

---

## 3. Measured timings (real, this machine)

| measurement | value | note |
| --- | --- | --- |
| cold `import build123d` (fresh venv, bytecode compile) | **~80 s** | once per venv; installer pre-warms it |
| warm `import build123d + trimesh + numpy + OCP` | **1.1–2.8 s** | per process (`importMs` 1095–1800 ms measured) |
| acceptance bracket B-rep + all checks (warm) | **5–70 ms** | `buildMs` 5.2–6.7 ms once OCC is warm |
| bracket `model.build` step+glb end-to-end over protocol | **~50 ms** wall | measured 50.8 / 49.4 ms on two runs |
| STEP export | **33561 bytes** | `model.step`, ~20–50 ms |
| GLB export | **31788 bytes** | `model.glb`, Y-up, POSITION+NORMAL, ~10–30 ms |
| STL export | **64684 bytes** | `model.stl`, binary, ~10–30 ms |
| SVG iso preview | **5709 bytes** | `preview.svg`, HLR; front/right first call can be ~0.5–0.8 s |
| 10×10 hole pattern build | **~0.55 s** | batched booleans (was 3.8 s unbatched) |
| 56-feature plate (cancel test) | **~0.57 s** | used to exercise cooperative cancel |
| cooperative cancel latency | **median 26.6 ms** (24–338 ms) | measured from `job.cancel` to the settled build frame; one outlier when cancel lands during tessellation |
| `runtime.shutdown` → process exit | **362 ms** | includes the 250 ms double-shutdown drain window |
| stdin EOF → process exit | **8.5 ms** | host death/SIGKILL orphan prevention |
| warmup (warm venv) | **~1.1 s** | `hello` waits for it |

## 4. Tests (`tests/python/`)

| file | covers |
| --- | --- |
| `test_contracts.py` | Python constants vs `protocol.js` (parsed), hello versions/capabilities, version mismatch |
| `test_validation.py` | acceptance document + ~50 rejection paths (unknown op/field/param, duplicate id, non-finite/negative, patterns, cut/union shape, first feature, limits, JSON-pointer paths, no mutation) |
| `test_geometry_bracket.py` | acceptance bracket: bbox, analytic volume ±0.5 % (actually 1e-9), cylindrical-face hole detection (Ø20 ×1, Ø6 ×4), topology, all checks, parameter-edit variant, failed conditions (disjoint union, bbox limit) |
| `test_features.py` | fillet/chamfer/cut/union, blind hole, x-axis hole, grid/bolt_circle/rect_corners, cylinder axis, fillet-too-big → structured failure, absorbed hole/union caught by `feature_effects`, wall-thickness warning |
| `test_exports.py` | STEP ISO-10303-21 + re-import volume equality, GLB glTF 2.0 header/JSON/JSON-chunk/POSITION bbox Y-up/watertight reload, binary STL triangle count, SVG hidden lines + pixel size, all four views distinct, only requested formats written |
| `test_protocol.py` | real child process: health fields, build round-trip with progress, validate, malformed JSON, unknown method, invalid envelope/params, id reuse, duplicate in-flight requestId, 3 sequential builds in one warm process, oversize frame, double shutdown exit 0, stdin EOF (incl. mid-build) no orphan |
| `test_cancel.py` | cancel running build → normal `failed/cancelled` result, no artifacts; idempotent while in flight, false after; unknown requestId; queued-build cancel; build works after cancel |
| `test_atomic.py` | outputDir creation/confinement/relative rejection, never overwrite (bytes unchanged), symlink refusal, stale temp sweep, sha256/bytes truthfulness, `maxArtifactBytes` |
| totals | **119 tests, `119 passed in ~37 s`** (run twice consecutively) |
| `test_setup_runtime.py` | pins == installed versions, lock file, installer syntax, `--check` JSON contract, idempotency |
| `helpers.py` | real RuntimeClient (subprocess JSON-RPC), document fixtures, GLB parser, STEP re-import |

---

## 5. What is NOT verified (honest list)

* **Host integration itself is host-eng's E2E** (spawning through
  `src/host/runtime.ts`, the Web viewer, revision persistence, the plugin
  manager). This runtime was verified through a standalone JSON-RPC client and
  the in-process pipeline, not through the running DSH app.
* **Windows** is not supported/verified: the reader loop uses `select()` on a
  file descriptor (POSIX). macOS/Linux desktop is the target.
* **Concurrency**: builds are intentionally serialised (one stateful runtime,
  SPEC §4). A second `model.build` queues; `model.validate` is answered inline
  on the reader thread, so a very heavy validate can delay health/bad-frame
  handling for its duration.
* **Cancel latency inside one OCCT call** is bounded by that call (a single
  boolean/fillet); hole patterns batch 10 holes at a time to keep it ~ms. A
  pathological fillet could take longer than the host's 2.5 s cancel budget and
  be SIGKILLed — safe by design (atomic artifacts) but reported as a kill, not
  a graceful cancel.
* **HLR preview edge cases**: hidden-line removal is OCCT's, tested on the
  acceptance bracket and simple primitives only; very complex models could
  produce slow or visually noisy previews.
* **`closed_shell` definition**: it checks *closedness* (no boundary edges)
  rather than strict 2-manifoldness. Exact geometric tangency (e.g. a hole
  whose radius equals its distance to a face) makes OCC tessellate a closed but
  non-manifold shell (an edge shared by 4 triangles); that passes and emits a
  warning. Tessellations with real boundary edges fail.
* **Very large models** are bounded by `maxBoundingBoxMm`/`maxArtifactBytes`
  (defaults 2000 mm / 128 MiB), not by a triangle budget; a dense tessellation
  could produce a large GLB under the byte limit.
* The `--selftest` formats default is all four artifacts; the self-test
  reported here used that default.

## 6. Risks / notes for the Host and client

1. `hello` **waits for warmup** (bounded 180 s) so that build123d/OCP/trimesh
   versions are real. On a virgin venv that is the one-time ~80 s import; the
   installer pre-warms it. `health` is always instant and reports
   `ready`/`status`/`warmup`.
2. Geometry/check/export/cancel failures are **normal `status:"failed"` build
   results** with the report and `artifacts: []`; JSON-RPC errors are reserved
   for malformed requests (`invalid_document`, `invalid_argument`,
   `protocol_error`, `internal_error`).
3. Artifact filenames are fixed (`model.step`, `model.glb`, `model.stl`,
   `preview.svg`); the runtime refuses to overwrite any existing file and
   removes everything it wrote on failure, so a fresh revision directory is
   required per build (which the Host already uses).
4. `details.path` is an RFC 6901 JSON pointer (`/features/1/diameter`), not the
   bracket form; `details.violations[].field` carries the bracket form for
   humans.
5. GLB is Y-up (glTF 2.0), STEP/STL are Z-up millimetres; the viewer should
   treat 1 glTF unit = 1 mm.
