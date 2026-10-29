# Security model

Scope: what `dsh-plugin-cad` trusts, what it never does, and where the harness (not
the plugin) is the control point. Anything not implemented yet is labelled
**unimplemented** rather than described as if it worked; verification status lives
in `docs/research/STATUS_*.md` and `tests/e2e/RESULTS.md`.

Normative inputs: `src/contracts/errors.js` (stable codes/HTTP statuses),
`src/contracts/tools.js` (the only agent-facing surface), `src/contracts/protocol.js`
(wire surface), `cordis.patch.yml` (limits and switches),
`docs/research/DSH_PLUGIN_API_NOTES.md` (host behaviour),
`docs/research/SPEC_P0.md` (product rules).

---

## 1. Actors and trust levels

| actor | trust | notes |
| --- | --- | --- |
| **Model / agent** | untrusted input | produces JSON tool arguments; may be wrong, may be steered by prompt injection from any content it read |
| **Harness Host process** | trusted | runs as the user; owns approvals, timeouts, cancellation; the plugin is one plugin in its tree |
| **Plugin Host half** | trusted-but-minimised | our code; owns documents, store, child process, HTTP route |
| **Python runtime child** | semi-trusted | our code, but a crash/bug boundary; **no** network, no credential access, no user-path authority |
| **Browser / viewer** | untrusted display | renders geometry assets; same origin as the harness UI; must not receive capabilities beyond the admitted page session |
| **Local user** | trusted | can read/delete the model store with their own tools; the plugin protects against accidents, not against the account owner |
| **Third-party content** | untrusted | feature names, model names, descriptions, warnings that are echoed back into tool output and the UI |

**The model is the adversary for path and resource questions.** It can pass any
string in `output_path`, `model_id`, `request_id`, `name`, `description`. It
cannot pass code (ADR-0001) and cannot pass bytes (ADR-0005).

---

## 2. Trust boundaries and controls

| boundary | what crosses | control | reference |
| --- | --- | --- | --- |
| model → tool | JSON arguments | object-rooted strict JSON Schema (`additionalProperties:false`), harness approval/timeout/cancel pipeline | `src/contracts/tools.js`; notes §3 |
| tool → Host | document, ids, paths | document validation before any revision exists; id/format validation; workspace confinement for export | SPEC §3, §7 |
| Host → runtime | NDJSON RPC | fixed method set, 8 MiB frame cap, protocol version handshake, no code/exec payload | `src/contracts/protocol.js` |
| runtime → Host | report + artifact bytes | Host chooses destinations; runtime receives no user path; artifacts checked (bytes/sha256) | ADR-0002, ADR-0005 |
| browser → Host route | HTTP GET/HEAD | harness connection admission (`connection.requestRejection`), same-origin page, store-confined resolution | notes §4 |
| Host → filesystem | store writes, export copies | store root confinement, workspace confinement, atomic writes, overwrite protection | §4, §5, §6 below |
| runtime → machine | process, imports | interpreter path fixed by config/bootstrap; no network client; no shell-outs to user data | §7, §8 |

---

## 3. Approvals: what the plugin does and does not ask for

The harness owns approvals. The plugin **does not implement an approval flow** and
must not (notes §3): tools run inside the host pipeline, which applies the user's
permission policy. Consequences:

- `cad_create_model` / `cad_modify_model` / `cad_export_model` are ordinary tool
  calls from the harness's point of view. The harness decides whether the tool is
  allowed to run at all; the plugin decides whether the *arguments* are
  acceptable.
- `cad_runtime_status {action:"repair"}` is explicitly documented in its tool
  description as **a write/execute operation** (it runs the documented runtime
  installer). It must be treated by policy as the highest-impact CAD tool, and it
  is additionally gated by the `allowRuntimeInstall` config flag (default
  **false**, §9) — with defaults the plugin will not install anything.
- Nothing in this plugin requests elevated permissions, spawns a privileged
  helper, installs a system service, or edits harness settings.
- Background builds (`background: true`) are created as harness jobs owned by the
  calling agent (`exec.agent`), so the host's job-access fencing applies to them;
  the plugin does not add a second visibility or cancellation path.

---

## 4. Read/write roots

| root | access | contents |
| --- | --- | --- |
| `<DSH_HOME>/cad/` (or `dataDir`) | read/write | `models/`, `previews/`, `requests.json` — the authoritative model store |
| workspace-relative directory from `cad_export_model.output_path` | write-only copies | exported STEP/GLB/STL/SVG |
| `python/cad_runtime/` + the resolved interpreter/venv | read/execute | the runtime itself and its pinned dependencies |
| everything else | **denied** | documents, credentials, `~/.ssh`, browser profiles, harness session logs, other plugins' stores |

The runtime interpreter is resolved in this order (`src/host/config.ts`):
`config.pythonExecutable` → `$DSH_CAD_PYTHON` → `<DSH_HOME>/cad/venv/bin/python3` →
`<pluginRoot>/python/.venv/bin/python3` → a PATH `python3` that can
`import build123d`. The last step is a **probe**, not a guess: the system
`python3` (3.9, no build123d) fails it and is not used.

Rules:

1. The store root is resolved once from config at `apply()` time and canonicalised;
   all store paths are built from validated ids, never from a caller-supplied path.
2. `output_path` is interpreted as workspace-relative, canonicalised, and must
   remain under the session workspace root — after symlink resolution (§6).
3. The runtime never receives a path from the caller. It receives a document and
   writes through a destination the Host provides.
4. Nothing reads the user's home directory, environment secrets, or the network.

---

## 5. Temp-dir isolation and atomicity

- Every write goes through `writeAtomic`: a sibling `.tmp-<uuid>` file in the
  **same directory**, `fsync`, then `rename()` over the target. A concurrent
  reader sees the old file or the complete new one; never a partial STEP/GLB.
  Nothing is staged in a shared temp directory, so there is no cross-user temp
  surface and no cross-filesystem rename.
- Revision directories are **write-once**: a later build completes the already
  allocated revision (ADR-0003) and revision numbers are never reused.
- A crash can leave a stale temp file in a revision directory: host JSON staging
  is `.tmp-<uuid>`, runtime artifact staging is `.dsh-cad-tmp-*`. Both are inert
  (never served, never referenced) and cannot corrupt a published revision.
  The **runtime sweeps its own `.dsh-cad-tmp-*` files** in the output directory on
  the next build (`python/cad_runtime/artifacts.py`); the host's `.tmp-<uuid>`
  files are **not** swept automatically in P0 — the failure mode is bounded disk
  waste, not data loss.
- Temp files are not made more permissive than the directory's own mode; the
  plugin does not chmod anything.

---

## 6. Path-traversal defence

Traversal has three separate entry points, each defended independently:

1. **Model/revision identity.** `modelId` must match `^m-[0-9a-f]{10}$` and
   `revisionId` `^r-\d{4,}$` (`src/host/paths.ts` `MODEL_ID_PATTERN` /
   `REVISION_ID_PATTERN`; SPEC §4 specifies the `m-<10 hex>` / `r-<4 digits>`
   forms). These are also the only values accepted by the asset route. Because
   they are validated by an anchored regex before any string concatenation,
   `../`, absolute paths and NUL bytes are not expressible as an id.
2. **Asset URL.** The route handler parses the path against
   `/dsh-plugin-cad/assets/<modelId>/<revisionId>/<filename>`, requires `filename`
   to be one of the known artifact names, and additionally verifies that the
   fully resolved real path is inside the real store root (defence in depth if an
   id rule ever loosens). A failure is `path_escape` → **HTTP 403**
   (`src/contracts/errors.js`), not 404, so an attempted escape is visible in
   logs rather than indistinguishable from a missing file.
3. **Export destination.** `output_path` is workspace-relative; the resolved real
   path must stay inside the workspace root; `overwrite:false` (default) refuses
   to replace an existing file. Violations are `path_escape` (403) or
   `invalid_argument` (400).

Symlinks are resolved before the containment check (realpath), so a symlink
planted inside the store or the workspace cannot be used to reach outside it.
Non-canonical paths (`..`, `.`, duplicated separators) are rejected rather than
normalised silently.

**Honest limitation:** the plugin runs in the user's process as the user. This is
containment against *mistakes and agent errors*, not a sandbox against a
compromised host or a malicious local account.

---

## 7. Resource limits

Limits are declared once and enforced at the layer that can enforce them cheaply:

| limit | value | enforced by | failure |
| --- | --- | --- | --- |
| document parameters | ≤ 64, names `^[A-Za-z][A-Za-z0-9_]{0,39}$` | document validation (`maxParameters`) | `invalid_document` |
| features | 1..64, unique ids (`maxFeatures`) | document validation | `invalid_document` |
| pattern counts | `grid` 2..10 per axis, `bolt_circle` 3..24 | — | document validation (host/runtime) | `invalid_document` |
| document JSON | ≤ 256 KiB | `maxDocumentBytes = 262144` | host validation | `too_large` |
| API request body | ≤ 1 MiB | `maxBodyBytes = 1048576` | host API | `too_large` |
| name / description | ≤ 200 chars | `maxNameLength` | host validation | `invalid_argument` |
| `request_id` | ≤ 128 chars | `maxRequestIdLength` | host validation | `invalid_argument` |
| artifact file name | ≤ 64 chars, closed set | `maxArtifactNameLength` | store / route | `path_escape` / `not_found` |
| bounding box | `maxBoundingBoxMm` (2000) | config, clamped 1..100000 | build validation check `bounding_box` | `invalid_geometry` |
| artifact size | `maxArtifactBytes` (128 MiB) | config, clamped 4 KiB..1 GiB | store write + asset route | `too_large` (413) |
| RPC frame | 8 MiB | `MAX_FRAME_BYTES` | runtime frame reader | `protocol_error` |
| build time | `buildTimeoutMs` (180 s) | config, clamped 5 s..30 min | host pipeline | `timeout` (504) |
| runtime start | `runtimeStartTimeoutMs` (240 s) | config, clamped 10 s..10 min | supervisor | `runtime_unavailable` (503) |
| concurrent builds | `maxConcurrentBuilds` (1) | config, clamped 1..4 | build queue | queued, not failed |
| history entries returned | ≤ 100 | `maxHistoryEntries` | read path | truncated result |
| models listed | ≤ 200 | `maxModelsListed` | list path | truncated result |
| runtime stderr kept | 64 KiB ring | `maxStderrBytes` | supervisor | diagnostics only |
| tool output size | harness-owned output limits | — | host | host policy |

Numeric fields are finite numbers or `$param` references; `NaN`/`Infinity` are
rejected (JSON cannot carry them, and the validator refuses them anyway). Feature
edits are validated *before* a build, so a rejected edit costs no geometry time.
Hard limits marked `max*` are **not user-tunable** — they are compiled-in defense
in depth (`src/host/config.ts` `CadLimits`), so a malformed profile patch cannot
raise them.

---

## 8. Artifact access authorization

- The viewer is a page in the harness UI. Its asset fetches are **same-origin and
  admitted by the harness connection service**; the plugin adds no token, cookie
  or query-secret of its own.
- `[lead]` Verified host behaviour: non-root HTTP routes require the boot token
  cookie (`?token=` → 303 + cookie, otherwise 401). The asset prefix inherits
  that, so an unauthenticated client cannot read artifacts.
- The route serves only artifact files that exist in a revision directory; there
  is no directory listing, no index, and no path wildcard. Content types are the
  closed set `model/gltf-binary`, `application/step`, `model/stl`,
  `image/svg+xml`; responses carry `ETag:"<sha256>"` + `immutable` caching and
  support `If-None-Match` (304) and `HEAD` only — no mutating routes exist
  (`GET/POST` asymmetry: POST/PUT/DELETE/PATCH → 405 with `Allow: GET, HEAD`).
- Every artifact declaration is verified host-side before a revision is marked
  built: one fixed file per format, a regular non-symlink file inside the revision
  directory, and matching `bytes` **and** `sha256`; a lying runtime fails the
  build and its files are removed (`STATUS_host.md` §6).
- Artifacts are user data, not secrets, but they are still only served through the
  admitted page session and never inlined into model-visible tool results
  (ADR-0005).

---

## 9. Python runtime: dependency install timing and network posture

- **No installation at plugin load, tool call or build.** The runtime is expected
  to be prepared once, explicitly, by:
  - `npm run setup:python` (`node python/setup-runtime.mjs`) — documented bootstrap,
    with `$DSH_CAD_VENV` / `--venv` choosing the environment location;
  - or `cad_runtime_status {action:"repair"}` — the same non-interactive installer,
    explicitly declared a write/execute operation in its description.
- **Repair is gated in configuration:** `allowRuntimeInstall` (default **false**)
  decides whether `cad_runtime_status {action:"repair"}` may spawn the installer.
  With the default config the tool re-resolves the interpreter, restarts the
  supervised runtime and, when the runtime is unavailable, returns the exact
  `node python/setup-runtime.mjs` command in `details` instead of installing.
  When enabled, the installer is spawned with an args array (no shell). This is
  the behaviour recorded in `STATUS_host.md` §3.
- Installation therefore happens at a **user-initiated, visible** moment, with
  network access, on the user's terms. It is not a side effect of opening the
  viewer or of a first build.
- **At runtime the plugin makes no network calls:** no telemetry, no analytics, no
  update check, no model-provider call, no package fetch during builds. All
  geometry is local. (The harness itself talks to the LLM provider; the plugin is
  not part of that path.)
- The child process inherits a **minimal environment**: interpreter path, the
  runtime package path, `PYTHONPATH`/`PYTHONUNBUFFERED` as needed, and the store
  destination — not the harness's full environment, and no credentials. The child
  is spawned in its own process group (`detached`), stdin EOF makes it exit, and
  disposal runs `runtime.shutdown` → stdin EOF → SIGTERM (group) → SIGKILL with
  bounded waits, so no orphan survives a host death (`STATUS_host.md` §7).
- The runtime imports only `build123d`/OCP/`trimesh`/`numpy` (+ stdlib) and
  contains no `eval`/`exec` of agent input (ADR-0001). A document is data.

---

## 10. Telemetry and network

- **Telemetry: none.** The plugin emits nothing to any endpoint. Diagnostics are
  host logs (`ctx.logger`) plus the revision report stored on disk.
- **Network at runtime: none** (see §9). No HTTP client dependency exists in the
  runtime requirements (`python/requirements.txt`).
- `cad_render_preview` and build output are produced locally; no external
  rendering service.

---

## 11. Data retention, uninstall, deletion

| event | effect on `~/.dsh/cad/models` |
| --- | --- |
| disable plugin | untouched |
| restart Harness | untouched; model references remain valid (scenario I) |
| uninstall plugin | untouched — no child process left, no silent data loss (scenario K) |
| user deletes data | explicit, documented: remove `~/.dsh/cad` (or `dataDir`) with the user's own tools |

Rationale: a plugin uninstall is a package operation; deleting user CAD history
because a package was removed is destructive and surprising. The README documents
the exact directory and what deleting it means. There is no automatic retention
sweeper in P0; growth is bounded only by `maxArtifactBytes` per artifact and by
revision count, both visible in `cad_list_models` / `cad_inspect_model`.

---

## 12. Known limitations / what this model does not claim

1. **Not a sandbox.** A bug in the plugin or the Python runtime runs with the
   user's privileges. Mitigations are input validation, no code execution and no
   network, not OS confinement.
2. **Local user is trusted.** File permissions are the account's; the store is
   readable by anyone who can read the user's home.
3. **The kernel itself is a complex C++ dependency** (OCCT). A malicious *document*
   is constrained by the schema and limits, but OCCT robustness holes are an
   inherited risk, mitigated by running geometry in a child process that can be
   killed and restarted.
4. **Tool descriptions and rendered content are untrusted text.** Model names,
   descriptions and warnings are echoed into tool output and UI; they must be
   rendered as text (no HTML/markdown execution in the viewer) and never treated
   as instructions by an agent.
5. **What the harness owns, we do not test here:** user approval policy, session
   isolation, job-access fencing. Those are host properties; this document
   records the contract we rely on, not a re-verification of it.

---

## 13. Verification map

| claim | evidence file (expected) |
| --- | --- |
| tools register and unregister cleanly, disable removes them (J) | `tests/e2e/RESULTS.md` §J **PASS** (route 404 after disable); `STATUS_host.md` unit tests |
| no child process after disable/uninstall (K) | `tests/e2e/RESULTS.md` §K **PASS** (`strayProcesses=0`, `dataPreserved=true`); `STATUS_host.md` §7 disposal test |
| path traversal rejected, workspace confinement (L) | `tests/e2e/RESULTS.md` §L **PASS** (7 probes); `STATUS_host.md` store/asset traversal unit tests |
| job cancel stops the build, runtime usable after (H) | `tests/e2e/RESULTS.md` §H **FAIL** — recorded defect; unit-level fix in `STATUS_host.md` §1, acceptance re-run outstanding |
| artifact declaration verified (bytes+sha256) | `STATUS_host.md` §6 + unit tests |
| runtime start/repair runbook | `README.md`; `STATUS_host.md` §3; `STATUS_runtime.md` §1 |
| artifact route admitted by harness | `tests/e2e/RESULTS.md` §A/§L; `STATUS_host.md` api tests |

Where a row has no recorded run, it is **not verified** and must not be described
as passing.
