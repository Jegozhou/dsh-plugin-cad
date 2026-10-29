# Host half — STATUS (host-eng, task-2)

**State: implementation complete, all Host tests green against the fake runtime
and against the REAL Python runtime.**

| check | command | result |
| --- | --- | --- |
| typecheck | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` | exit 0 |
| bundle | `node build.mjs` | `lib/index.js` 175 KiB ESM, node builtins only |
| host tests | `node --test tests/unit/*.test.mjs tests/integration/*.test.mjs` | **88 tests, 88 pass, 0 fail, 0 skip** (26 s, venv present) |

`tests/integration/runtime.test.mjs` skips cleanly with a message when
`python/.venv/bin/python3` or `python/cad_runtime/__main__.py` is absent, so the
suite stays green on a bare checkout.

## Files owned and delivered

```
src/host/index.ts        Cordis plugin: name/inject/apply, every registration an effect
src/host/config.ts       config normalization/clamping + lazy interpreter resolution
src/host/contracts.ts    typed access to src/contracts/*.js (no contract edits)
src/host/types.ts        store/service/report types
src/host/paths.ts        single path-safety authority (store + asset route)
src/host/validate.ts     document validation (SPEC §3) + pre-build edit validation (§7)
src/host/store.ts        revisioned atomic store, idempotency, concurrency, sha256
src/host/runtime.ts      Python supervisor: JSON-RPC/stdio, timeouts, cancel, crash, teardown
src/host/service.ts      the one implementation tools + viewer API both call
src/host/jobs.ts         native ctx.jobs bridge (attachController('cad'))
src/host/tools.ts        exactly the 9 contract tools, envelope, presentCall, exec.signal
src/host/api.ts          read-only viewer API + artifact bytes (VIEWER API CONTRACT block at top)
src/host/export.ts       workspace-relative artifact copy (refuses escapes/overwrites)
tests/unit/*.test.mjs        8 suites, scripted fake runtime as a REAL child process
tests/unit/fixtures/fake-runtime.mjs scripted JSON-RPC runtime (modes: ok/fail/slow/crash/bad-sha…)
tests/integration/runtime.test.mjs real build123d acceptance path (skips without venv)
```

## Store layout (verified by the Host tests; consumed by the Lead's E2E)

`<dataDir>` defaults to `<DSH_HOME>/cad` (`DSH_HOME` = `~/.dsh` by default), or
`config.dataDir`.

```
<dataDir>/models/<modelId>/model.json
<dataDir>/models/<modelId>/revisions/r-000N/document.json    immutable snapshot
<dataDir>/models/<modelId>/revisions/r-000N/revision.json    immutable metadata
<dataDir>/models/<modelId>/revisions/r-000N/report.json      geometry report
<dataDir>/models/<modelId>/revisions/r-000N/model.step
<dataDir>/models/<modelId>/revisions/r-000N/model.glb
<dataDir>/models/<modelId>/revisions/r-000N/model.stl        on request
<dataDir>/models/<modelId>/previews/<revisionId>/preview.svg derived cache (regenerable)
<dataDir>/models/<modelId>/exports/<revisionId>/*            derived re-export cache
<dataDir>/requests.json                                      request_id idempotency index
```

`model.json` (all keys the E2E reads are present):

```jsonc
{ "schema":"dsh.cad/model@1",
  "id":"m-1a2b3c4d5e", "modelId":"m-1a2b3c4d5e",
  "name":"…", "description":"…",
  "createdAt":"ISO", "updatedAt":"ISO",
  "currentRevision":2, "latestRevision":2, "nextRevision":3,
  "owner":{"sessionId":"<agent session id | null>"}, "ownerSession":"…|null",
  "metadata":{},
  "revisions":[{"number":1,"revisionId":"r-0001","status":"built|failed|unbuilt",
                "createdAt":"ISO","builtAt":"ISO|null","documentSha256":"<hex>",
                "artifacts":[{"format":"glb","fileName":"model.glb","bytes":23844,
                              "sha256":"<hex>","contentType":"model/gltf-binary"}],
                "errorCode":null,"reportSummary":{"volume":…,
                              "boundingBoxSize":[80,60,8],
                              "checks":{"pass":6,"fail":0,"warn":1},"totalMs":42}}],
  "requests":{"<request_id>":{"number":1,"kind":"create","at":"ISO"}} }
```

`report.json` (both canonical spellings, so either verifier works):

```jsonc
{ "valid":true, "volume":33235.4, "surfaceArea":18734.2,
  "boundingBox":{"min":[-40,-30,-4],"max":[40,30,4],"size":[80,60,8]},
  "bbox":{"min":[-40,-30,-4],"max":[40,30,4],"size":[80,60,8]},
  "centroid":[0,0,0],
  "topology":{"faces":17,"edges":45,"vertices":30,"solids":1},
  "checks":[{"id":"brep_valid","status":"pass","message":"…"}],
  "featureReports":[{"id":"base","op":"box","status":"pass","detail":"…"}],
  "warnings":["…"], "timings":{"totalMs":42,"buildMs":30,"exportMs":12} }
```

Semantics: revisions are immutable; `currentRevision` only moves when a build
**succeeds**; a failed build is persisted as `status:"failed"` with its report
and error, `latestRevision` moves, `currentRevision` does not. Revision numbers
are monotonic and never reused. Writes are tmp+fsync+rename atomic. A mutating
call must send `expected_revision` = the revision it edited from; a mismatch is
`revision_conflict` (details include `currentRevision`), and a second writer
while a revision is allocated-but-unsettled is `model_locked`. `request_id`
replay returns the existing revision (`duplicate:true`) and never creates a
second one. Every build path releases the per-model fence in a `finally`.

## Viewer API (read-only) — authoritative shapes

The full contract block is the header comment of `src/host/api.ts` (lines 1–140)
and is asserted route-by-route in `tests/unit/api.test.mjs`.

| route | payload |
| --- | --- |
| `GET /dsh-plugin-cad/api/health` | `{ok,plugin,version,protocolVersion,runtime:{available,state,pid,executable,executableSource,protocolVersion,runtime,restarts,lastError,lastStartedAt,uptimeMs,stderrTail},store:{dataDir,modelCount,writable,exportAllowed},jobs:{active},time}` — always 200, never starts Python |
| `GET /api/models?limit&include_failed` | `{ok,count,models:[MODEL_SUMMARY]}`; `MODEL_SUMMARY` = `{modelId,name,description,units,createdAt,updatedAt,currentRevision,currentRevisionId,latestRevision,latestRevisionId,latestStatus,revisionCount,failing,report:{volume,boundingBoxSize,checks{pass,fail,warn},totalMs}|null,artifacts:[ARTIFACT_REF]}` |
| `GET /api/models/:id?revision=&history_limit=&include=summary\|document\|full` | `{ok,model,document? ,revision,viewer,history}`; default `include=document` (parameters/features); `revision` defaults to the current (last good) revision; `viewer` = `{glbUrl,stepUrl,stlUrl,svgUrl,defaultView,units,upAxis}` of the current revision |
| `GET /api/models/:id/revisions?limit` | `{ok,modelId,currentRevision,latestRevision,revisions:[REVISION_SUMMARY]}` |
| `GET /api/models/:id/revisions/:revisionId` | `{ok,modelId,revision,summary}` |
| `GET /api/models/:id/artifacts?revision=` | `{ok,modelId,revisionId,artifacts:[ARTIFACT_REF]}` |
| `GET\|HEAD /assets/models/<modelId>/<revisionId>/<fileName>` | artifact bytes; `fileName ∈ model.step\|model.glb\|model.stl\|preview.svg`; `content-type`: `model/gltf-binary`, `application/step`, `model/stl`, `image/svg+xml`; `ETag:"<sha256>"`, `cache-control: public, max-age=31536000, immutable`, `If-None-Match`→304, `?download=1`→`content-disposition` |
| `GET\|HEAD /assets/models/<modelId>/previews/<revisionId>/preview.svg` | derived SVG preview cache |

`ARTIFACT_REF` = `{artifactId:"m-…:r-0002:glb",format,fileName,bytes,sha256,contentType,url}`.
JSON responses are `no-store`; errors are `{error:{code,message,details?}}` with
the status from `src/contracts/errors.js`. Every request (API and assets) is
admitted first by `ctx.get('connection').requestRejection(req)`; there is no
plugin-specific auth and no CORS header. **There are no mutating routes**: POST/
PUT/DELETE/PATCH get 405 + `Allow: GET, HEAD` (Lead decision — the viewer is
read-only; revision refresh is verified by a concurrent agent writing revision 2
while the panel polls).

## Decisions and deviations worth knowing

1. **Owner contract drift (fixed).** `dsh-jobs` 0.1.1-rc.2 types say
   `owner?: Agent`; the shipped 0.2.1-rc.3 registry does `agents.get(session)`, so
   `ctx.jobs.start` receives `owner: exec.agent.id` (the session-id **string**)
   plus `toolCall:{callId,rootCallId}`. The same drift applies to job *reads*:
   0.2.1-rc.3 `assertAccess(job, caller)` compares `job.owner.id !== caller`
   directly, so `get`/`read`/`kill`/`list` are called with the same
   session-id **string** (`exec.agent.id`), never an Agent object or
   `agent.session`. Both rules are verified against the asar and covered by
   unit tests with a stub registry that implements the real fence
   (`job.owner.id !== caller` → "belongs to another session", and
   `start({owner: <object>})` → refused). A refused background start persists
   the revision as failed and releases the model fence (unit-tested).
2b. **Job output/read shape drift (fixed).** The shipped 0.2.1-rc.3 registry has
   no `hooks.readOutput`: output reaches the job ring only through the
   `run(handle)` handle's `append(text, options?)` / `updateProgress(line)`,
   the producer's terminal data is `JobOutcome.result` (a JSON value, not
   `output`), and `read(id, caller)` returns
   `{chunks:[{at,text,…}], lossy, result?, job}` rather than the stale typings'
   `{text, snapshot}`. The bridge normalizes all of it
   (`normalizeJobRead`/`normalizeJobSnapshot`) and `CadJobs.describe()` is
   total, so a settled/cancelled/already-read job always reports its terminal
   snapshot and a malformed projection becomes a structured `internal` with
   `details.registryError` instead of a TypeError. Covered by
   get-after-settlement (twice), cancel-on-a-finished-job, and
   malformed-projection tests.
2. **Cross-session reads are allowed.** `listModels`/detail/artifacts read every
   model in the store regardless of creating session; `owner.sessionId` is audit
   metadata and optimistic-concurrency context, not a read fence (single-user
   desktop; the viewer is a different session from the agent).
3. **`cad_runtime_status action:"repair"` does not install by itself** unless
   `allowRuntimeInstall:true` (default **false**): it re-resolves the
   interpreter, restarts the supervised runtime and, when unavailable, returns
   the exact `node python/setup-runtime.mjs` command in `details`. When enabled,
   the installer may be spawned with an args array (no shell).
4. **Cancelled/failed builds are persisted** as failed revisions (report when
   the runtime supplied one, `error.code = cancelled|timeout|invalid_geometry|…`,
   empty artifact list), so nothing silently disappears and the previous current
   revision stays viewable.
5. **Previews never mutate a revision**: `cad_render_preview` writes
   `previews/<rev>/preview.svg` (derived cache); deleting it cannot corrupt
   history.
6. **Artifact verification is host-side**: every runtime declaration must name
   one fixed artifact file for its format, be a regular non-symlink file inside
   the revision directory, and match both `bytes` and `sha256`. A lying runtime
   fails the build and its files are removed.
7. **Orphan prevention**: the child is spawned in its own process group
   (`detached`), stdin EOF makes it exit, and disposal does
   `runtime.shutdown` → stdin EOF → SIGTERM (group) → SIGKILL with bounded waits.
   Unit test asserts the pid is gone after disposal; stdin-EOF-on-parent-death is
   covered by a fixture test.
8. **Security**: no shell strings anywhere (executable + args array), the runtime
   may only write inside the revision/output directory it is given, the store
   and asset route share one traversal+symlink guard, only known content types
   are served, no network calls or telemetry, nothing is deleted on disable/
   uninstall.
9. **Single writer**: optimistic concurrency is in-process (single host writer);
   multi-process concurrent editing is out of scope for P0 (documented).

## Runtime wire (agreed with runtime-eng; docs/CAD_RUNTIME_PROTOCOL.md)

`python -m cad_runtime` from `<pkg>/python`, `PYTHONPATH=<pkg>/python`,
`PYTHONUNBUFFERED=1`; newline-delimited JSON-RPC 2.0. Host calls
`runtime.hello` (protocol 1.0 handshake, start timeout 240 s, covers the cold
`import build123d`), `runtime.health`, `model.build`, `model.validate`,
`job.cancel`, `runtime.shutdown`; the runtime pushes `build.progress` and
`runtime.log`. Geometry/check failures are normal `status:"failed"` results (not
transport errors). Timeout = kill+respawn then structured `timeout`; caller
cancellation = `job.cancel` (correlated by the build `requestId`) then a bounded
2.5 s wait, killing+respawning if unacknowledged, then structured `cancelled`.
Interpreter resolution order: `config.pythonExecutable` → `$DSH_CAD_PYTHON` →
`<DSH_HOME>/cad/venv/bin/python3` → `<pkg>/python/.venv/bin/python3` → PATH probe
`python3 -c "import build123d"` (lazy, first geometry work).

## Distribution notes (for the Lead's `pnpm pack` check)

- The host bundle imports **only Node builtins** (`node:http`, `node:fs/promises`,
  `node:child_process`, `node:crypto`, `node:path`, `node:os`, …) plus the
  bundled `src/contracts/*.js`; there is no `@deepseek-ai/*` runtime import.
- `package.json.files` already ships everything the Host needs at runtime:
  `lib/index.js`, `cordis.patch.yml`, `src/contracts/*.js`, `python/cad_runtime/**`,
  `python/requirements.txt`, `python/setup-runtime.mjs`, `locale/*.json`,
  `icon.svg`. **No package.json change needed.**
- `python/.venv` is intentionally not packaged. After installing the tarball into
  a fresh profile, run `node <profile>/node_modules/dsh-plugin-cad/python/setup-runtime.mjs`
  once (creates the venv in place), or point `$DSH_CAD_PYTHON` /
  `config.pythonExecutable` at an existing interpreter with `build123d`.

## Test evidence (this checkout, venv present)

```
$ node --test tests/unit/*.test.mjs tests/integration/*.test.mjs
ℹ tests 88
ℹ pass 88
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 24459
```

Highlights:

- `tests/unit/store.test.mjs`: atomic write + sha256, immutable revisions,
  idempotent `request_id`, `revision_conflict`/`model_locked`, traversal +
  symlink escape refusal, cross-session listing, concurrent-writer fencing,
  failed-build pointer semantics, lying-runtime artifact rejection.
- `tests/unit/runtime.test.mjs`: real child process, hello handshake, progress
  notifications, geometry-failure result mapping, version mismatch, handshake
  timeout kill, crash-once restart, build timeout kill+respawn, cooperative
  `job.cancel`, unacknowledged cancel kill+respawn, stderr ring, disposal leaves
  no orphan, stdin-EOF exit, and a SIGKILLed parent does not leave an orphan
  runtime child behind.
- `tests/unit/tools.test.mjs`: 9 tools + exact contract schemas, envelopes,
  discovery-first descriptions, background create through a stub `ctx.jobs`
  registry with the owner **session id** and the shipped `{chunks,job,result}`
  read shape, `cad_get_job_status` reading a settled job twice, cancelling an
  already-finished job, a malformed registry projection yielding structured
  `internal` (never a TypeError), reading and cancelling its own job through
  the session-id caller fence (a foreign session is refused and lists nothing),
  refused background start releases the lock and the next edit succeeds,
  queued + in-flight background cancellation
  reaches terminal `killed` with a failed/cancelled revision and no artifacts,
  `exec.signal` cancellation, workspace export/traversal.
- `tests/unit/api.test.mjs`: health/models/detail/revisions/artifacts shapes,
  connection-fence rejection, asset content types + ETag/304 + HEAD, traversal
  probes, read-only 405s, failed-latest still 200 with the last-good viewer URL.
- `tests/integration/runtime.test.mjs` (REAL build123d): acceptance bracket
  80×60×8 + Ø20 + 4×Ø6 → valid B-rep, STEP 33.5 KB + GLB 23.8 KB on disk with
  matching sha256, served as `application/step`/`model/gltf-binary` with 304;
  parameter edit → revision 2 (100×70×8) with revision 1 byte-identical; real
  SVG preview; cancel in flight → `cancelled`, no artifacts, next build fine.
