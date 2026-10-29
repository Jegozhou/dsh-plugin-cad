# ADR-0002 — One long-lived Python process, newline-delimited JSON-RPC over stdio

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead, host-eng, runtime-eng
- **Milestone:** P0 (M0–M5)

## Context

Real B-rep geometry needs OpenCASCADE, and the mature Python binding is
`build123d` on `cadquery-ocp`. The installed pins are recorded in
`python/requirements.txt`: `build123d==0.13.0` (which pulls
`cadquery-ocp-novtk 8.0.1.1.0` / OpenCASCADE 8.0.1), `trimesh==5.2.0`,
`numpy==2.5.4`, on the uv-managed CPython 3.12.13.

Two measured facts drive the design, both recorded in
`docs/research/DSH_PLUGIN_API_NOTES.md` §8:

- a cold `import build123d` costs ≈ **80 s** (bytecode compilation), a warm
  import ≈ **1.6 s**;
- the uv-managed CPython is required; the Homebrew Pythons on this machine are
  broken for uv (empty `platform.mac_ver()`), and the PATH `python3` is 3.9.6
  without build123d.

A spawn-per-build design therefore pays 80 s or, at best, 1.6 s plus process
startup on *every* build; a single user parameter edit would feel like a hang.
The alternative of embedding CPython in the Node host (N-API extension, pybind,
or a re-implementation of OCCT bindings in JS) is a large native build surface
for no functional gain.

## Decision

Run **exactly one supervised child process** for the CAD runtime, started by the
Host plugin, and speak **newline-delimited JSON-RPC 2.0 over its stdio**.

Wire contract (`src/contracts/protocol.js`, mirrored by
`python/cad_runtime/protocol.py`; a unit test is required to assert the two
agree):

- `PROTOCOL_VERSION = '1.0'`; mismatch → `protocol_version_mismatch`.
- Methods the Host calls: `runtime.hello`, `runtime.health`, `runtime.shutdown`,
  `model.build`, `model.validate`, `job.cancel`.
- Notifications the runtime pushes (no `id`, no reply): `build.progress`,
  `runtime.log`.
- Stable error codes: `protocol_error`, `protocol_version_mismatch`,
  `invalid_document`, `unsupported_operation`, `build_failed`,
  `invalid_geometry`, `export_failed`, `cancelled`, `timeout`, `internal_error`.
- `MAX_FRAME_BYTES = 8 MiB`; the runtime refuses a larger frame rather than
  buffering it.
- Document schema id is a wire constant too: `dsh.cad/document@1`.

Supervision and lifecycle (configured in `cordis.patch.yml`):

| config key | role |
| --- | --- |
| `pythonExecutable` | explicit interpreter path (empty = resolve the documented uv CPython) |
| `pythonPath` | extra `PYTHONPATH` for the runtime package |
| `dataDir` | model store root override (empty = `<DSH_HOME>/cad`) |
| `runtimeStartTimeoutMs` | `240000` — first start after an install can pay the 80 s import |
| `buildTimeoutMs` | `180000` per build |
| `maxConcurrentBuilds` | `1` — one stateful process, serialised builds |

Rules that follow from this ADR:

1. The process is **started lazily** on first geometry work and kept warm;
   `cad_runtime_status` probes it with `runtime.health`.
2. Its lifetime is an **effect** of the plugin: the `ctx.effect` disposer must
   terminate the child, and plugin disable must leave no child process behind
   (`docs/research/DSH_PLUGIN_API_NOTES.md` §2).
3. A crash is a recoverable state: the supervisor restarts with backoff and
   surfaces `runtime_crashed` / `runtime_unavailable`
   (`src/contracts/errors.js`, HTTP 503), never a raw exception to the model.
4. The runtime is **stateless with respect to models**: the Host owns documents,
   revisions and artifact files; the child only builds and reports. This keeps a
   restart from losing user data.
5. Cancellation is two-level: `job.cancel` for a build the runtime is working
   on, and the harness job's `cancel()` at the host level (ADR-0004).

## Consequences

**Positive**

- One warm interpreter amortises the import cost across builds and keeps the
  OpenCASCADE in-memory model cache usable.
- The wire is trivially debuggable: one JSON object per line, no framing library,
  no RPC framework, no localhost port and therefore no extra network/auth
  surface.
- stdio gives the supervisor a hard kill path: closing the pipes and terminating
  the child is a complete teardown.
- Version negotiation (`runtime.hello`) prevents a stale installed runtime from
  silently serving a newer Host.

**Negative / accepted costs**

- **Single point of failure.** A wedged OCCT call blocks the process; the
  supervisor can only terminate and restart it, which loses warm state.
- **Builds serialise.** `maxConcurrentBuilds: 1` is honest for one stateful
  process; throughput is one build at a time. Documented as a limitation in
  `README.md`.
- **Long-lived memory.** OCCT keeps allocations; a leak accumulates for the
  session lifetime. A restart policy on repeated failures is the mitigation.
- **A second language in the repo.** `python/` is a separate runtime with its own
  tests and its own dependency bootstrap (`python/setup-runtime.mjs`), which is
  why the Python bootstrap/recovery path is a first-class README topic.

## Alternatives considered

- **Spawn per build (rejected).** Correct isolation, unacceptable latency
  (§8 measurements).
- **Localhost HTTP server (rejected).** Adds a listen port, a bearer-token or
  origin story, and CORS-adjacent complexity; the viewer already talks to the
  Host's own HTTP route, so the runtime does not need one.
- **N-API / pybind embedding (rejected for P0).** Native build matrix, ABI and
  crash-safety cost across platforms for no user-visible benefit.
- **WASM OpenCASCADE (rejected).** No acceptable build of this exact B-rep stack;
  would not satisfy the "real STEP file" requirement with confidence.
- **Python `-c` with a code string (rejected).** That is ADR-0001's rejected
  code-execution model wearing a different hat.

## References

- `src/contracts/protocol.js`; `src/contracts/errors.js`
- `python/requirements.txt` (pins and the uv/CPython note)
- `cordis.patch.yml` (runtime config keys)
- `docs/research/DSH_PLUGIN_API_NOTES.md` §2, §5, §8
- `python/setup-runtime.mjs` — non-interactive bootstrap invoked by
  `npm run setup:python` and by `cad_runtime_status {action:"repair"}`
  (`src/contracts/tools.js`)
- Related: ADR-0004 (jobs)
