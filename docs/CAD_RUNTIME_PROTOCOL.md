# CAD runtime protocol (wire v1.0)

**Status:** authoritative implementer reference for `dsh-plugin-cad`'s Python CAD
runtime. It is pinned by the repository, not by chat: the TypeScript host client
(`src/host/runtime.ts`) and the Python runtime (`python/cad_runtime/`) both
implement this document, and `tests/python/test_contracts.py` asserts that the
constants below agree with `src/contracts/protocol.js`.

| item | value |
| --- | --- |
| runtime package | `python/cad_runtime/` |
| entry point | `<python> -m cad_runtime` (cwd `<pkg>/python`, `PYTHONPATH=<pkg>/python`) |
| transport | newline-delimited JSON-RPC 2.0 over stdio (one JSON object per line, UTF-8) |
| protocol version | `1.0` |
| document schema | `dsh.cad/document@1` |
| geometry report schema | `dsh.cad/geometry-report@1` |
| runtime version | `0.1.0` |
| runtime identity | `runtime.name = "cad-runtime"` |

Related documents: [`docs/research/SPEC_P0.md`](research/SPEC_P0.md) §2/§3/§5
(is the product contract), `src/contracts/protocol.js` (is the wire constant
source of truth), `src/contracts/errors.js` (host-side error taxonomy).

---

## 1. Process model

* Exactly **one long-lived Python process** per plugin instance. It is never
  spawned per build: a cold `import build123d` costs ~80 s (bytecode compile),
  a warm one ~1.6–2.8 s.
* On start the process immediately spawns a **warmup thread** that imports
  `build123d`, `trimesh` and `numpy`. `runtime.hello`, `runtime.health` and
  `runtime.shutdown` do not need those imports; `model.build`/`model.validate`
  wait for warmup before touching geometry.
* **stdout carries protocol frames only.** At startup fd 1 is duplicated for the
  protocol writer and fd 1 itself is pointed at stderr, so an accidental
  `print()` or OpenCASCADE diagnostic inside a dependency cannot corrupt the
  frame stream. All diagnostics (including Python tracebacks) go to stderr.
* The process is safe to `SIGKILL` at any instant: artifacts are written with
  tmp-file + atomic `link`/`rename`, so a committed artifact is always complete
  and an uncommitted one is only a hidden `.dsh-cad-tmp-*` file that the next
  build in that directory removes (see §8).
* If stdin reaches **EOF** the host has died (including SIGKILL): the reader
  loop cancels in-flight builds and the process exits within ~0.5 s. It never
  outlives its host. `SIGTERM`/`SIGINT` are handled the same way (`exit 0`).
* The runtime never calls out to the network, never imports user files and never
  executes user-supplied code. Only the declarative catalogue in §6 runs.

### Launch contract

```ts
spawn(pythonExecutable, ['-m', 'cad_runtime'], {
  cwd: '<pkg>/python',
  env: { ...process.env, PYTHONPATH: '<pkg>/python', PYTHONUNBUFFERED: '1' },
  shell: false,
})
```

`pythonExecutable` resolution (host side): explicit config → `$DSH_CAD_PYTHON` →
`<DSH_HOME>/cad/venv/bin/python3` → `<pkg>/python/.venv/bin/python3` → lazy
`python3 -c "import build123d"` probe. The runtime itself only requires Python
**3.12** and the pinned packages in `python/requirements.txt`.

Optional CLI:

| invocation | behaviour |
| --- | --- |
| `python -m cad_runtime` | JSON-RPC server on stdio (default) |
| `python -m cad_runtime --selftest` | build the acceptance bracket in-process, print one JSON status object to stdout, exit 0/1 |
| `python -m cad_runtime --version` | print `cad-runtime 0.1.0 protocol 1.0`, exit 0 |

Environment overrides (all optional, for tests/diagnostics):

| variable | meaning |
| --- | --- |
| `DSH_CAD_WARMUP_TIMEOUT_MS` | max time `runtime.hello` waits for warmup (default `180000`) |
| `DSH_CAD_LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` (default `info`), stderr only |
| `DSH_CAD_VENV` | consumed by `python/setup-runtime.mjs`, not by the server |

---

## 2. Framing and JSON-RPC rules

* One request/response/notification per line. JSON is compact, ASCII-escaped and
  contains no raw newline. Frames larger than **8 MiB** (`MAX_FRAME_BYTES`) are
  refused: the runtime answers `-32700` with `data.code = "protocol_error"` and
  discards bytes up to the next newline. **The process never exits on a bad
  frame**; only EOF, `runtime.shutdown` and fatal startup failure do.
* Requests: `{"jsonrpc":"2.0","id":<string|number>,"method":"<name>","params":{...}}`.
  Notifications (no `id`) are never answered.
* Success: `{"jsonrpc":"2.0","id":...,"result":{...}}`.
* Failure: `{"jsonrpc":"2.0","id":...,"error":{"code":<number>,"message":"<human>","data":{"code":"<stable>","message":"<human>","details":{...}}}}`.
  The host maps `error.data.code` onto its `CadError`; a missing `data.code` is
  treated as `internal_error`.
* `id` may be any string or number and is echoed verbatim. Reusing an `id` while
  an earlier response with the same `id` is still pending is legal JSON-RPC but
  ambiguous for the host: the runtime answers each request independently and
  rejects only a **duplicate in-flight `requestId`** on `model.build` (§4.4).
* Unknown method → `-32601`, `data.code = "protocol_error"`.
* `params` present but not an object → `-32602`, `data.code = "protocol_error"`.
* Malformed JSON / invalid UTF-8 → `-32700`, `data.code = "protocol_error"`,
  `id = null`.
* `jsonrpc` other than `"2.0"` → `-32600`, `data.code = "protocol_error"`.
* JSON-RPC batch arrays are not supported → `-32600`, `data.code = "protocol_error"`.

Numeric codes used:

| numeric | meaning |
| --- | --- |
| `-32700` | parse error (malformed JSON / oversize frame) |
| `-32600` | invalid request (bad envelope, wrong `jsonrpc`) |
| `-32601` | method not found |
| `-32602` | invalid params (incl. `invalid_document`, `invalid_argument`) |
| `-32603` | internal runtime error |
| `-32000` | application error (`build_failed`, `invalid_geometry`, `export_failed`, `cancelled`, `timeout`, `protocol_version_mismatch`, `unsupported_operation`) |

---

## 3. Version negotiation

`runtime.hello` is sent by the host immediately after spawn and is also the
staleness probe. The host compares `result.protocolVersion` (and/or the error
code) with its own `PROTOCOL_VERSION = "1.0"`; mismatch → kill, mark runtime
failed with `protocol_version_mismatch`.

Adding fields to results is backward compatible; renaming/removing one or
changing semantics requires a protocol version bump. Unknown request params are
ignored (forward compatibility); unknown *document* fields are rejected (§6).

---

## 4. Methods

### 4.1 `runtime.hello`

Request:

```json
{"jsonrpc":"2.0","id":"1","method":"runtime.hello",
 "params":{"protocolVersion":"1.0","host":{"name":"dsh-plugin-cad","version":"0.1.0"}}}
```

Result (all version strings are real, so hello waits for the warmup thread):
software versions may be `null` when warmup did not finish inside
`DSH_CAD_WARMUP_TIMEOUT_MS`; `ready` then stays `false` and `health` reports the
reason.

```json
{"protocolVersion":"1.0",
 "ready":true,
 "warmup":{"state":"ready","ms":1096},
 "runtime":{"name":"cad-runtime","version":"0.1.0",
            "python":"3.12.13","pythonPath":"/abs/pkg/python/.venv/bin/python",
            "platform":"darwin-arm64",
            "build123d":"0.13.0","ocp":"8.0.1.1","trimesh":"5.2.0","numpy":"2.5.4"},
 "capabilities":{
   "formats":["step","glb","stl","svg"],
   "checks":["document_schema","single_solid","brep_valid","positive_volume",
             "closed_shell","bounding_box","feature_effects","wall_thickness"],
   "previewViews":["iso","front","top","right"],
   "features":["box","cylinder","hole","hole_pattern","fillet","chamfer","cut","union"],
   "limits":{"maxBoundingBoxMm":2000,"maxArtifactBytes":134217728,"maxFeatures":64,
             "maxParameters":64,"minWallThicknessMm":0.2,
             "meshToleranceMm":0.1,"meshAngularToleranceRad":0.2}}}
```

If `params.protocolVersion` is present and not `"1.0"`:

```json
{"error":{"code":-32000,"message":"protocol version mismatch: client sent 9.9, runtime speaks 1.0",
  "data":{"code":"protocol_version_mismatch","message":"...",
          "details":{"expected":"1.0","received":"9.9"}}}}
```

### 4.2 `runtime.health`

Never blocks: answered by the reader loop even while a build runs in a worker
thread. Request params `{}`; result:

```json
{"ok":true,"pid":41234,"uptimeMs":51234,"protocolVersion":"1.0",
 "status":"ready","ready":true,"busy":false,"jobs":0,"activeBuilds":0,
 "warmup":{"state":"ready","ms":1642},
 "versions":{"python":"3.12.13","build123d":"0.13.0","ocp":"8.0.1.1",
             "trimesh":"5.2.0","numpy":"2.5.4"}}
```

* `status`: `starting` → `ready` → `stopping`; `degraded` when warmup failed.
* `jobs`: builds queued or running; `activeBuilds`/`busy`: builds currently
  executing geometry (the two differ while a build is queued behind another);
  `counters`: `{completed, failed, cancelled}` since process start (additive).
* The host uses a 5 s budget; the answer is computed from in-memory state only.

### 4.3 `runtime.shutdown`

Request: `{"jsonrpc":"2.0","id":"9","method":"runtime.shutdown","params":{"reason":"plugin dispose"}}`.

Result: `{"ok":true,"stopping":true}`, then the process exits **0** within
~300 ms (in-flight builds are cancelled and their frames settle first if they
can; the 2 s host grace is not needed). Calling it twice is idempotent: the
second call answers `{"ok":true,"stopping":true,"alreadyStopping":true}` while
the shutdown drain window (250 ms) is still open. stdin EOF has the same effect
without a response.

### 4.4 `model.build`

The core call. **Geometry/check/export failures are a normal result**, not a
JSON-RPC error: the host persists a failed revision with the report and keeps the
previous revision current. Only malformed requests are JSON-RPC errors.

Request params:

| field | type | required | meaning |
| --- | --- | --- | --- |
| `requestId` | string | recommended | caller idempotency/progress/cancel key. Generated (and echoed) if absent. |
| `model` | `{id,revisionId}` | no | host model/revision identity, echoed for correlation |
| `document` | object | yes | `dsh.cad/document@1` exactly as persisted (§6) |
| `outputDir` | absolute path string | yes | the **only** directory the runtime may write; created if missing |
| `formats` | string[] | no | subset of `["step","glb","stl","svg"]`, default `["step","glb"]`; one entry per filename, no duplicates |
| `checks` | string[] \| null | no | `null` = all checks; otherwise filters which checks are echoed in `report.checks` (all checks are still evaluated, so a subset can never hide a failure) |
| `limits` | object | no | overrides of §4.4.1 |
| `preview` | `{view,width,height}` | no | used only when `formats` contains `"svg"`; defaults `{"view":"iso","width":1200,"height":900}` |
| `progress` | boolean | no | default `true`; set `false` to suppress `build.progress` notifications |

Result:

```json
{"ok":true,
 "requestId":"rq-1f0c...",
 "buildId":"b-9f2c1a3d4e5f",
 "modelId":"m-1a2b3c4d5e","revisionId":"r-0002",
 "status":"built",
 "report":{
   "volume":34981.947193, "surfaceArea":12091.327412,
   "boundingBox":{"min":[-40,-30,-4],"max":[40,30,4],"size":[80,60,8]},
   "centroid":[0,0,0],
   "topology":{"faces":11,"edges":27,"vertices":18,"solids":1},
   "checks":[{"id":"document_schema","status":"pass","message":"..."},
             {"id":"single_solid","status":"pass","message":"..."},
             {"id":"brep_valid","status":"pass","message":"..."},
             {"id":"positive_volume","status":"pass","message":"..."},
             {"id":"closed_shell","status":"pass","message":"..."},
             {"id":"bounding_box","status":"pass","message":"..."},
             {"id":"feature_effects","status":"pass","message":"..."},
             {"id":"wall_thickness","status":"pass","message":"..."}],
   "featureReports":[{"id":"base","op":"box","status":"pass","detail":"..."},
                     {"id":"center_hole","op":"hole","status":"pass","detail":"..."},
                     {"id":"corner_holes","op":"hole_pattern","status":"pass","detail":"..."}],
   "warnings":[],
   "timings":{"totalMs":842,"buildMs":611,"exportMs":197}},
 "artifacts":[{"format":"glb","fileName":"model.glb","bytes":23844,
               "sha256":"<64 lowercase hex>","contentType":"model/gltf-binary"},
              {"format":"step","fileName":"model.step","bytes":33587,
               "sha256":"<64 lowercase hex>","contentType":"application/step"}],
 "error":null}
```

Failure result (geometry/check failure):

```json
{"ok":true, "status":"failed", "report":{...all report keys, checks contain the failure...},
 "artifacts":[],
 "error":{"code":"invalid_geometry","message":"geometry checks failed: feature_effects",
          "details":{"checks":[{"id":"feature_effects","status":"fail","message":"..."}]}}}
```

`status` is `"built"` iff every evaluated check is `pass`/`warn` and every
requested artifact was written. `error.code` values: `invalid_geometry`
(check/feature failure), `build_failed` (unexpected modelling exception),
`export_failed` (geometry fine, an artifact could not be produced),
`cancelled` (cancelled before/during the build), `timeout` (reserved; timeouts
are enforced by the host, which SIGKILLs and respawns).

On any `status:"failed"` result the runtime **removes every artifact it wrote in
that call** and reports `artifacts: []`, so the host never sees a partial set.
Files already present before the call are never touched.

#### 4.4.1 Limits

| limit | default | enforced as |
| --- | --- | --- |
| `maxBoundingBoxMm` | 2000 | `bounding_box` check fails above it |
| `maxArtifactBytes` | 134217728 (128 MiB) | artifact over the limit → `export_failed`, file removed |
| `maxFeatures` | 64 | structural limit, `invalid_document` |
| `maxParameters` | 64 | structural limit, `invalid_document` |
| `minWallThicknessMm` | 0.2 | `wall_thickness` check warns below it |
| `meshToleranceMm` | 0.1 | tessellation linear deflection for GLB/STL/closed-shell |
| `meshAngularToleranceRad` | 0.2 | tessellation angular deflection |

#### 4.4.2 Artifacts

Fixed filenames, always written **directly inside `outputDir`** (no subdirectories):

| format | fileName | contentType |
| --- | --- | --- |
| step | `model.step` | `application/step` |
| glb | `model.glb` | `model/gltf-binary` |
| stl | `model.stl` | `model/stl` |
| svg | `preview.svg` | `image/svg+xml` |

* The host serves `model.glb` to the viewer and verifies `bytes`/`sha256` and
  that the file is a regular non-symlink file directly inside `outputDir`.
* STEP is written by OCCT `STEPControl_Writer` via build123d; GLB is the welded
  tessellation converted **Z-up (CAD) → Y-up (glTF)**; STL is binary, in CAD
  coordinates (Z-up, mm) — STL has no axis convention, consumers keep CAD axes;
  SVG is a hidden-line projection (visible solid, hidden dashed).
* `model.step`, `model.glb`, `model.stl` carry millimetres; GLB declares no unit
  itself, the host/viewer treats 1 unit = 1 mm.
* Atomicity and no-overwrite rules: §8.

### 4.5 `model.validate`

Runs structural validation plus the full geometry pipeline **without writing
files**. Request:

```json
{"jsonrpc":"2.0","id":"4","method":"model.validate",
 "params":{"document":{...},"checks":null,"limits":{...}}}
```

Result:

```json
{"ok":true,"valid":false,
 "checks":[{"id":"feature_effects","status":"fail","message":"..."}, ...],
 "report":{...same report keys as model.build, artifacts absent...}}
```

* Structurally invalid document → JSON-RPC error `-32602`,
  `data.code = "invalid_document"`, `details.path` (RFC 6901 pointer, e.g.
  `/features/1/diameter`) and `details.violations = [{path,message}]`.
* Geometry failure → normal result with `valid:false` and the failing checks
  (no JSON-RPC error, no artifacts, no `outputDir`).

### 4.6 `job.cancel`

Request: `{"jsonrpc":"2.0","id":"7","method":"job.cancel",
"params":{"requestId":"rq-1f0c...","reason":"cancelled by caller"}}`.

Result: `{"ok":true,"cancelled":true|false,"requestId":"rq-1f0c..."}`.

* Cancels the build whose `requestId` matches, whether it is queued (settles
  immediately) or running (cooperative cancel between feature steps and between
  artifact writes).
* The in-flight `model.build` answer is a **normal failed result**:
  `status:"failed"`, `error.code:"cancelled"`, `report` of the partial shape,
  `artifacts: []` (any artifact already written by the cancelled call is
  removed). Cancellation is bounded by one feature step — a single OCCT boolean
  operation is not interruptible, a 100-hole pattern loop checks between holes.
* Unknown/already-finished `requestId` → `{"ok":true,"cancelled":false}`.
  `job.cancel` is idempotent: repeated cancels keep answering `cancelled:true`
  until the build settles, then `cancelled:false`.
* Timeouts are **host-enforced** (§9), the runtime does not self-timeout.

---

## 5. Notifications (runtime → host, no `id`, no reply)

### `build.progress`

```json
{"jsonrpc":"2.0","method":"build.progress",
 "params":{"requestId":"rq-1f0c...","phase":"building","percent":40,
           "message":"feature 2/3 center_hole"}}
```

* `phase`: `validating` (0–5 %), `building` (5–90 %), `exporting` (90–100 %).
* `percent`: integer 0–100, monotonic within a build.
* Sent from the build worker thread; the frame writer is serialised.

### `runtime.log`

```json
{"jsonrpc":"2.0","method":"runtime.log","params":{"level":"warn","message":"warmup took 82134 ms"}}
```

`level` ∈ `info|warn|error`. Used for warmup outcome, shutdown and internal
recoveries; never for per-build chatter (that is `build.progress` + stderr).

---

## 6. Document model (`dsh.cad/document@1`)

Full rules in `docs/research/SPEC_P0.md` §2–§3. Implementation highlights and
the decisions this runtime pins down:

* **Units:** `units` must be `"mm"` (default `"mm"` + warning when omitted).
  Every length is millimetres, every angle degrees.
* **Axes:** right-handed, **Z is up**. Primitives are centred on the origin
  unless `center` is given (`center` accepts 2 or 3 numbers; 2 → z = 0).
* **Parameters:** `{name: number}`; names `^[A-Za-z][A-Za-z0-9_]{0,39}$`; ≤ 64;
  finite; `|value| ≤ 1e6`. Any numeric field may be the string `"$name"`; an
  unknown reference is `invalid_document` at that field's JSON-pointer path.
* **Features:** 1..64, ordered, unique `id` (`^[A-Za-z][A-Za-z0-9_-]{0,39}$`),
  closed catalogue; unknown `op`/field is rejected; **the first feature must add
  material** (`box`, `cylinder`, `union`). No partial application: a document is
  accepted whole or rejected whole.
* `schema` missing or `"dsh.cad/document@1"` accepted; other values rejected.
* `name`/`description` are optional strings (≤200/4000 chars), stored by the
  host, unused by geometry.

### 6.1 Feature semantics

| op | fields | semantics |
| --- | --- | --- |
| `box` | `length,width,height,center?` | axis-aligned box, origin-centred by default |
| `cylinder` | `diameter,height,center?,axis?` | cylinder, axis `z` (default) / `x` / `y`, origin-centred |
| `hole` | `diameter,at?,through?,depth?,axis?,face?` | subtract a round hole; `at` is 2 numbers in the plane normal to `axis`: `z→(x,y)`, `x→(y,z)`, `y→(x,z)`; `at` defaults `[0,0]`; `through` default `true` (spans the whole body with a 1 mm margin); when `through:false` a positive `depth` is required and the hole is sunk from `face` (`top` = max side of `axis`, default) or `bottom` |
| `hole_pattern` | `pattern,diameter,through?,depth?,…` | subtract N holes; `rect_corners`: exactly 4 at `(±(sx/2-inset), ±(sy/2-inset))` with `span` defaulting to the current body bbox size in x/y, origin-relative per SPEC §3.1, requirement `2*inset < min(span)`; `grid`: `count:[nx,ny]` ints 2..10, `spacing:[dx,dy]` > 0, `center` default `[0,0]`, positions `center + ((i-(nx-1)/2)*dx, (j-(ny-1)/2)*dy)`; `bolt_circle`: `count` int 3..24, `pitch_diameter` > 0, `center` default `[0,0]`, first hole at +X, counter-clockwise |
| `fillet` | `radius,target?` | round selected edges: `vertical_edges` (parallel to Z, default), `top_edges` (both vertices at bbox max Z), `bottom_edges` (bbox min Z), `all_edges` |
| `chamfer` | `distance,target?` | chamfer the same edge selections |
| `cut` | `shape:{op:"box"\|"cylinder",…}` | boolean subtract a primitive (same field rules, parameter refs allowed) |
| `union` | `shape:{op:"box"\|"cylinder",…}` | boolean add a primitive |

A `hole`/`hole_pattern` punch is material removal: it never union-adds a tool
body. `cut`/`union` primitives have no `id` and no nested features.

---

## 7. Geometry report and checks

Report keys (identical for `model.build` and `model.validate`):

| key | type | meaning |
| --- | --- | --- |
| `volume` | number | B-rep volume, mm³ |
| `surfaceArea` | number | B-rep area, mm² |
| `boundingBox` | `{min,max,size}` | mm, `[x,y,z]` each |
| `centroid` | `[x,y,z]` | centre of mass, mm |
| `topology` | `{faces,edges,vertices,solids}` | B-rep counts |
| `checks` | `[{id,status,message}]` | see below, ordered by `CHECK_IDS` |
| `featureReports` | `[{id,op,status,detail}]` | per feature, input order |
| `warnings` | string[] | non-fatal observations |
| `timings` | `{totalMs,buildMs,exportMs}` | milliseconds |

All numbers are finite; a shape-less failure reports zeros. `volume` etc. are
rounded to 6 decimals.

Additive report keys the host may ignore: `schema` (`dsh.cad/geometry-report@1`)
and `mesh` (`{vertices,triangles,watertight,closed,nonManifoldEdges,windingConsistent,volume,toleranceMm,angularToleranceRad}`).

Checks (`status` ∈ `pass`|`fail`|`warn`):

| id | passes when | notes |
| --- | --- | --- |
| `document_schema` | structural validation accepted the document | always `pass` when a report exists (structural failures are JSON-RPC `invalid_document` instead) |
| `single_solid` | the result has exactly one solid | `fail` if 0 or ≥2 |
| `brep_valid` | `Shape.is_valid` is true | OpenCASCADE B-rep validity |
| `positive_volume` | `volume > 0` | |
| `closed_shell` | the welded tessellation has no open boundary (every edge used an even number of times) | closed shell; degenerate zero-area triangles from OCC fillet seams are dropped first. A shell that is closed but non-2-manifold (a tessellation artefact of exactly tangent faces) still passes and adds a `warnings[]` entry |
| `bounding_box` | every bbox dimension ≤ `maxBoundingBoxMm` and finite | |
| `feature_effects` | every subtractive feature changed the face set as requested: the expected number of cylindrical faces of the requested radius appeared (and for box cuts/unions the face count changed) | catches silently absorbed holes; detail lists expected vs actual per feature |
| `wall_thickness` | every through-hole keeps ≥ `minWallThicknessMm` material to the bbox face in the perpendicular plane | **`warn` only** heuristic, never fails a build |

`status:"built"` requires no `fail` among the evaluated checks; warnings are
reported but do not fail the build.

---

## 8. Artifacts: atomicity, confinement, no overwrite

* `outputDir` must be an **absolute** path string. The runtime creates it
  (including parents) if missing, resolves symlinks and refuses to continue if it
  is not a directory. Everything is written directly in it — no subdirectories.
* Every artifact is encoded to a hidden `outputDir/.dsh-cad-tmp-<random>` file,
  flushed and `fsync`ed, then committed with an atomic `link` (fallback
  `rename`) that **fails if the final name already exists**. A pre-existing
  artifact therefore produces `export_failed` with
  `details.reason:"artifact_exists"` and is never overwritten or truncated.
* `bytes` is the committed file size and `sha256` its lowercase hex digest; both
  are computed from the committed bytes. A file over `maxArtifactBytes` is
  deleted and the build fails with `export_failed`.
* Leftover `.dsh-cad-tmp-*` files from a SIGKILL are swept at the start of the
  next build in that directory (and always removed in `finally` on the normal
  path), so no partial artifact can ever be observed by name.
* On any failed or cancelled build the runtime unlinks every artifact it wrote
  in that call; files that existed before the call are never touched.

---

## 9. Lifecycle, cancellation and timeouts

```
spawn → hello (waits warmup) → validated/health-polled → build(s) …
      → shutdown | stdin EOF | fatal → exit 0
```

* **Host-enforced timeout:** `buildTimeoutMs` (default 180 s) covers the whole
  `model.build` frame, including a virgin-venv cold warmup. On timeout the host
  SIGTERM/SIGKILLs and respawns; the runtime is safe to kill (see §8) and the
  host reports `timeout`. The runtime never self-kills a build.
* **Cancellation budget:** the host waits ≤ 2500 ms for the pending build frame
  after `job.cancel`. The cooperative cancel checks between feature steps,
  inside `hole_pattern` hole loops, and between artifact writes, so a bracket
  settles in milliseconds; the worst case is one OCCT boolean/fillet call.
* **Shutdown:** `runtime.shutdown` → respond → cancel in-flight jobs → drain
  window (250 ms, so a back-to-back second shutdown still gets an answer) →
  exit 0. Measured end-to-end: **~360 ms**, well inside the host's 2 s grace.
  stdin EOF → cancel + exit **~10 ms** (host died). SIGTERM / SIGINT → same as
  EOF with exit code 0.
* `runtime.health` keeps answering during builds because stdin reading and
  dispatch stay on the main thread; builds run on worker threads and are
  serialised by a dedicated build lock.
* At most one build executes geometry at a time (SPEC §4: one stateful runtime).
  Additional builds queue; their `requestId` can be cancelled while queued.

---

## 10. Error taxonomy

`error.data` is always `{"code","message","details"}`.

| `data.code` | numeric | when |
| --- | --- | --- |
| `protocol_error` | `-32700`/`-32600`/`-32601`/`-32602`/`-32603` | framing, envelope, unknown method, malformed params, duplicate in-flight requestId |
| `protocol_version_mismatch` | `-32000` | `runtime.hello` version differs (`details.expected/received`) |
| `invalid_document` | `-32602` | document failed structural validation (`details.path` RFC 6901 pointer, `details.violations`) — structural only; geometry failures use the normal failed result |
| `invalid_argument` | `-32602` | malformed runtime params (`outputDir` missing/relative/not a directory, unknown format, bad preview view) |
| `unsupported_operation` | `-32000` | reserved; unknown *method* is `protocol_error`, an unknown *feature op* is `invalid_document` |
| `build_failed` | `-32000` | unexpected modelling exception (`details.featureId`, traceback on stderr) |
| `invalid_geometry` | `-32000` | check/feature-level geometry failure (normal failed result + `details.checks`) |
| `export_failed` | `-32000` | artifact generation/commit failure (normal failed result; JSON-RPC only for malformed params) |
| `cancelled` | `-32000` | build cancelled (normal failed result `error.code:"cancelled"`) |
| `timeout` | `-32000` | reserved for the host |
| `internal_error` | `-32603` | unexpected runtime exception, traceback on stderr |

JSON-pointer paths are RFC 6901 (`/features/1/diameter`, `~0`/`~1` escaping).
`details.violations[]` entries carry `{path, message, field?}` where `field` is
the host-friendly bracket form (`features[1].diameter`).

---

## 11. Worked example: acceptance bracket

Request (trimmed):

```json
{"jsonrpc":"2.0","id":"b1","method":"model.build","params":{
  "requestId":"rq-0001",
  "model":{"id":"m-1a2b3c4d5e","revisionId":"r-0001"},
  "outputDir":"/tmp/dsh-cad-test/m-1a2b3c4d5e/r-0001",
  "formats":["step","glb"],
  "document":{
    "schema":"dsh.cad/document@1","units":"mm",
    "parameters":{"length":80,"width":60,"thickness":8},
    "features":[
      {"id":"base","op":"box","length":"$length","width":"$width","height":"$thickness"},
      {"id":"center_hole","op":"hole","diameter":20,"at":[0,0],"through":true},
      {"id":"corner_holes","op":"hole_pattern","pattern":"rect_corners","diameter":6,
       "inset":12,"span":["$length","$width"],"through":true}]}}}
```

Result (trimmed, real measured values):

```json
{"jsonrpc":"2.0","id":"b1","result":{
  "ok":true,"requestId":"rq-0001","buildId":"b-6f1c2a9d4e70","status":"built",
  "report":{
    "volume":34981.947193,"surfaceArea":12091.327412,
    "boundingBox":{"min":[-40,-30,-4],"max":[40,30,4],"size":[80,60,8]},
    "centroid":[0,0,0],"topology":{"faces":11,"edges":27,"vertices":18,"solids":1},
    "checks":[{"id":"single_solid","status":"pass","message":"..."}, "..."],
    "featureReports":[{"id":"base","op":"box","status":"pass","detail":"..."}, "..."],
    "warnings":[],"timings":{"totalMs":49.2,"buildMs":5.2,"exportMs":10.3}},
  "artifacts":[
    {"format":"step","fileName":"model.step","bytes":33561,"sha256":"<hex>","contentType":"application/step"},
    {"format":"glb","fileName":"model.glb","bytes":31788,"sha256":"<hex>","contentType":"model/gltf-binary"}],
  "error":null}}
```

A parameter edit (`length: 90`, `width: 70`) is the same call against a new
`revisionId`/`outputDir`; the runtime is stateless across builds (the host owns
revisions), so no state leaks between revisions.

---

## 12. Runtime installation and pins

| item | value |
| --- | --- |
| installer | `node python/setup-runtime.mjs` (also `npm run setup:python`) |
| installer output | exactly one JSON object on stdout (exit 0 success / non-zero failure) |
| venv | `python/.venv` or `$DSH_CAD_VENV` |
| interpreter | uv-managed CPython **3.12.13** (Homebrew Pythons are broken for uv on this machine: empty `platform.mac_ver()`) |
| direct pins | `build123d==0.13.0`, `trimesh==5.2.0`, `numpy==2.5.4` |
| transitive lock | `python/requirements.lock.txt` (full freeze) |
| OpenCASCADE | `cadquery-ocp-novtk==8.0.1.1.0` (OCP `8.0.1.1`) |
| dev | `python/requirements-dev.txt` (`pytest==9.2.0`) |

Measured on this machine (see `docs/research/STATUS_runtime.md`): cold first
`import build123d` ~80 s (bytecode compilation, once per venv), warm import
~1.4–2.8 s, sidecar `model.build` of the acceptance bracket step+glb **~50 ms**
wall, STEP ~20–50 ms, GLB ~10–30 ms, HLR SVG ~10–800 ms depending on view,
cooperative cancel ~25 ms (bounded by one batched boolean; one outlier at
~340 ms when the cancel lands during tessellation). That is why the process is
long-lived and the installer pre-warms the import.
