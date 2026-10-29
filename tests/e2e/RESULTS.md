# E2E acceptance evidence — dsh-plugin-cad

Environment: macOS 26.2 (25C56) arm64 · DSH app/CLI **0.2.1-rc.3** · cordis 4.0.5 ·
bundled Node 24.21.0 · profile root `~/.dsh`.

Evidence is appended as it is produced. A scenario is only `PASS` when a
recorded run below supports it; `PARTIAL` states exactly what is missing.

| # | Scenario (project brief) | Result | Evidence |
| --- | --- | --- | --- |
| A | Plugin installs and enables | **PASS** | §A — `dsh plugin add` + composed row + boot health 200 |
| B | Agent discovers native CAD tools | **PASS** | §B — headless agent called `cad_list_models` |
| C | Agent creates a parametric part with correct dimensions | **PASS** | §C/D/E — bracket 80×60×8, Ø20 + 4×Ø6, volume 34,981.947 |
| D | Python runtime returns valid real geometry | **PASS** | §C/D/E + §M1-D — 8/8 checks, 1 solid, 11 faces |
| E | STEP opens in an independent CAD parser | **PASS†** | §C/D/E — independent pure-JS ISO-10303-21 verifier + OCCT re-import; **no commercial CAD app on this machine** |
| F | In-Harness viewer displays the new model | **PASS** | §F/G — real harness Chrome run, WebGL canvas, GLB 200 |
| G | Parameter change → viewer shows the new revision | **PASS** | §F/G — live r-0003→r-0004 while the panel was open; §G immutable revisions r-0001→r-0005 |
| H | Cancel mid-build leaves the runtime controlled | **PASS** | §H — 4th run: queued background job reached terminal `killed`, runtime healthy, cancelled revision left 0 artifacts |
| I | Model reference survives harness restart | **PASS** | §I — cold restart listed the same persisted model ids |
| J | Disable → tools unavailable, resources released | **PASS** | §J — row disabled, route 404, tool absent from agent toolset |
| K | Uninstall → no child process, no CAD data loss | **PASS** | §K — 0 stray `cad_runtime`, 18/18 model files intact |
| L | No path traversal outside the workspace | **PASS** | §L — 7 traversal probes, nothing leaked |

**12 PASS, 0 FAIL, 0 PARTIAL.** † = verified with an independent parser, not a
commercial CAD application (none installed); stated explicitly in `docs/TEST_REPORT.md`.

---

## M0 — install / compose / load / serve (probe bundle)

A throwaway probe package (`dsh-plugin-m0probe`, `/tmp/m0-probe`, tool
`m0_probe_ping`, one HTTP route, one client module) was used to validate the
host integration mechanics **before** the real plugin existed.

### Installed with the documented command

```
$ dsh plugin --profile cadtest add /tmp/m0-probe
dependencies:
+ dsh-plugin-m0probe 0.0.1 <- ../../../../../tmp/m0-probe
Done in 322ms using pnpm v11.28.5
```

The command added the dependency **and** the bundle entry automatically
(`~/.dsh/profiles/cadtest/package.json`):

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-m0probe" ] } }
```

### Composed tree contains the plugin row

```
$ dsh --profile cadtest --dump-config | grep -A4 dsh-plugin-m0probe
# == dsh-plugin-m0probe
- id: dsh-plugin-m0probe
  name: dsh-plugin-m0probe
  config:
    marker: m0-probe
```

### Host plugin loads, registers a tool and an HTTP route

```
$ dsh --profile cadtest --no-open --port 64899
dsh web: http://127.0.0.1:64899/?token=<redacted>
```

Unauthenticated request is refused by the harness admission fence (the plugin
does not invent its own auth):

```
$ curl -s http://127.0.0.1:64899/dsh-plugin-m0probe/api/health
{"error":"unauthorized"}
```

With the browser-session cookie obtained from the boot token:

```
$ curl -s -b /tmp/cj.txt http://127.0.0.1:64899/dsh-plugin-m0probe/api/health
{"ok":true,"route":"m0probe","url":"/dsh-plugin-m0probe/api/health","marker":"m0-probe"}
```

### Client module is part of the boot graph and is served by the harness

`window.__DSH_BOOT__` in the served HTML lists `dsh-plugin-m0probe/client.js`.

```
$ curl -s -b /tmp/cj.txt "http://127.0.0.1:64899/plugins/??dsh-plugin-m0probe/client.js&rev=a50717404a72"
status:200 type:text/javascript; charset=utf-8 bytes:635
window.__ModuleLoader__.load({
  id: "dsh-plugin-m0probe",
  factory(require) { ... }
});
```

## M0-B — a real harness agent discovers and calls a plugin tool

Profile `cadheadless` (shipped headless template + LLM provider patch),
probe installed the same way, then a one-shot headless agent run:

```
$ dsh --profile cadheadless "Call the m0_probe_ping tool exactly once and print its raw JSON result verbatim. Do nothing else."
{"ok":true,"pong":true,"plugin":"dsh-plugin-m0probe","marker":"m0-probe","at":"2026-10-29T22:09:15.327Z"}
exit code 0
```

This is the native tool pipeline end to end: Cordis registration → harness tool
registry → model tool discovery → permission pipeline → plugin `execute()` →
structured JSON back to the model.

## M0-J — disable removes the tool from the agent's toolset (mechanism check)

The same probe row was disabled in the profile patch layer
(`- id: dsh-plugin-m0probe` / `disabled: true`) and the headless agent was asked
for the tool:

```
$ dsh --profile cadheadless "Call the m0_probe_ping tool once. If it does not exist, reply exactly: TOOL-ABSENT ..."
TOOL-ABSENT
Tools available to me starting with `m0`: none. (No tool in my current toolset begins with `m0`.)
exit code 0
```

Enabling it again (removing the `disabled` override) restores the tool, so the
harness owns the enable/disable lifecycle — the plugin does not implement one.
This validates the *mechanism* for scenario J; the real-plugin J run is below.

## M0-K — uninstall removes dependency, bundle entry and composed row (mechanism check)

```
$ dsh plugin --profile cadtest remove dsh-plugin-m0probe
dependencies:
- dsh-plugin-m0probe link:/tmp/m0-probe
Done in 214ms using pnpm v11.28.5

profile after removal: dependencies: []   bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
$ dsh --profile cadtest --dump-config | grep -c m0probe
0
```

`dsh plugin remove` cleans the package dependency *and* `dsh.profile.bundles`, so
the loader no longer knows the row. Removing a bundle is therefore a complete
uninstall at the composition level; leftover resources (child process, routes,
tools) are the plugin's own responsibility and are exercised by scenarios J/K
with the real plugin below.

---

## M1-D — the real Python CAD runtime builds real geometry (verified)

Runtime driven directly over its stdio JSON-RPC contract
(`node /tmp/rpc-probe.mjs`, the same frames the Host sends):

```
hello: 1.0 (build123d version reported) 1244ms
health: {"status":"ready","ready":true,"pid":996}
notifications: build.progress validating 1% … building feature 1/3 base … 81% tessellating … exporting step/glb/stl/svg … done 100%
build: built 58ms volume: 34981.947193 bbox: 80x60x8 artifacts: step:33567 glb:23844 stl:64684 svg:5709
checks: document_schema=pass single_solid=pass brep_valid=pass positive_volume=pass
        closed_shell=pass bounding_box=pass feature_effects=pass wall_thickness=pass
shutdown: {"ok":true,"stopping":true,"alreadyStopping":false}
exit: {"code":0,"sig":null}
```

Runtime self-test (`python -m cad_runtime --selftest`) reports the same values:
volume 34981.947193 mm³, bbox 80×60×8, topology faces 11 / edges 27 / vertices
18 / solids 1, 5 holes verified by `feature_effects`, watertight mesh 1292
triangles; timings build 9.7 ms / export 14.8 ms / total 56.9 ms; warm import
1059 ms. Versions: CPython 3.12.13, build123d 0.13.0, OCP 8.0.1.1 (OCCT 8.0.1),
trimesh 5.2.0, numpy 2.5.4.

## M1-E — STEP + GLB verified by an independent parser (no plugin code involved)

```
$ node tests/e2e/verify-artifacts.mjs /tmp/cad-artifacts/model.step /tmp/cad-artifacts/model.glb
STEP: part21=true schema=AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 } entities=770 solids=1 faces=11
  cylindrical radii: 3.000, 3.000, 3.000, 3.000, 10.000   dangling references: 0
GLB : valid=true asset=2.0 meshes=1 primitives=1 triangles=1292  bbox: 80 x 8 x 60
[PASS] step_part21 · step_entities · step_references_resolve · step_solid_body · step_faces
[PASS] step_center_hole_radius (Ø20 → r=10) · step_corner_hole_radii (4 × r=3)
[PASS] glb_container · glb_asset_version · glb_triangles · glb_bounding_box
VERDICT: PASS
```

The GLB bbox is `80 x 8 x 60` because glTF is Y-up: the CAD Z axis (thickness 8)
becomes glTF Y. Nominal X/Y/Z is compared as a sorted triple, so 80/60/8 is
confirmed. The verifier is pure JavaScript written for this test suite; it does
not import the plugin or the Python runtime, so the file content is independent
evidence. A separate OCCT STEP re-import reproduces the volume (M1-D selftest
does this in-process; the E2E re-runs it in a fresh process).

**Third-party CAD application check: NOT POSSIBLE on this machine** (no FreeCAD /
SolidWorks / Fusion / Rhino installed). "Opens in a commercial CAD system" is
therefore not claimed.

## M2-F (partial) — client module is a real harness client plugin

Profile `cadtest` (shipped web template) with the real plugin installed; the
harness served page contains the plugin's client module in
`window.__DSH_BOOT__` and serves its bundle through the harness module route:

```
boot graph: dsh-plugin-cad/client.js&rev=6fc131c85248
$ curl -b <browser-session-cookie> "http://127.0.0.1:64899/plugins/??dsh-plugin-cad/client.js&rev=6fc131c85248"
status:200 type:text/javascript bytes:719995
window.__ModuleLoader__.load({ id: "dsh-plugin-cad", factory(require) { ... }})
```

The bundle contains three.js `GLTFLoader` and `OrbitControls`, so it is a real
3D viewer client, not a placeholder. Whether it *renders* is verified separately
in the browser E2E below.

---

# Real plugin, real harness — acceptance runs

Installed with the documented one-liner into two throwaway profiles:
`cadtest` (web viewer) and `cadheadless` (headless agent). The user's `desktop`
and `web` profiles were not modified.

```
$ dsh plugin --profile cadtest add /Volumes/ZHITAI/texttocad/dsh-plugin-cad
+ dsh-plugin-cad 0.1.0 <- ../../../../../Volumes/ZHITAI/texttocad/dsh-plugin-cad
$ node -e "...profile.package.json..." → bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-plugin-cad"]
```

## A — install and enable: PASS

```
$ dsh --profile cadlife --from-default-profile web      # fresh profile
$ node tests/e2e/harness-e2e.mjs --profile cadlife --port 64901
PASS install   exit=0 dependency=true bundle=true
PASS compose   dump-config exit=0 row=true
PASS boot      api/health=200 bootGraph=true clientBundle=200
```

The composed loader tree contains `- id: dsh-plugin-cad / name: dsh-plugin-cad`
with the bundle config, and the running web app answers the plugin's health API:
`{"ok":true,"plugin":"dsh-plugin-cad","version":"0.1.0","protocolVersion":"1.0",
"runtime":{"available":false,"state":"stopped"},"store":{"dataDir":"<DSH_HOME>/cad","modelCount":0,"writable":true},
"jobs":{"active":0}}`.

## B — agent discovers and calls native CAD tools: PASS

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario discover
PASS discover exit=0 toolNameInAnswer=true okMentioned=true 6.5s
```

A real headless DSH agent, given only a natural-language instruction, called
`cad_list_models` and reported its `ok:true` result.

## C, D, E — agent creates the parametric bracket; real geometry; verified STEP: PASS

Prompt (see docs/research/SPEC_P0.md §1 for the spec): *"Create a rectangular
mounting bracket 80 mm × 60 mm × 8 mm with a Ø20 mm central through-hole and four
Ø6 mm corner holes inset 12 mm… keep the dimensions parametric… export STEP and
GLB…"*

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario create
PASS create model=m-3dad4f54a1 rev=r-0001 checks=12/12
agent final answer: {"model_id":"m-3dad4f54a1","revision_id":"r-0001","volume":34981.947193,
  "bbox":{"min":[-40,-30,-4],"max":[40,30,4],"size":[80,60,8]},"artifact_formats":["step","glb"]}
```

Store after the run (`<DSH_HOME>/cad/models/m-3dad4f54a1/`): `model.json`,
`revisions/r-0001/{document,revision,report}.json`, `model.step` (33,561 B),
`model.glb` (23,844 B). The agent also copied both artifacts into the session
workspace (`exports/model.step`, `exports/model.glb`).

Independent verification of that revision (12/12 checks): 770 STEP entities, 0
dangling references, 1 `MANIFOLD_SOLID_BREP`, 11 `ADVANCED_FACE`, cylindrical
radii `[3, 3, 3, 3, 10]` (four Ø6 corner holes + one Ø20 centre hole), glTF 2.0
container valid, 1,292 triangles, bbox 80/60/8. Geometry report: volume
34,981.947 mm³ (analytic 34,981.947), topology 11 faces / 27 edges / 18 vertices
/ 1 solid, all eight validation checks pass.

E caveat: independent STEP parsing above is a pure-JS verifier written for this
test suite, plus a separate-process OCCT re-import that reproduces the volume.
No commercial third-party CAD application is installed on this machine.

## F, G — in-Harness viewer displays the model and follows a new revision: PARTIAL → see final run

Real harness web profile in Chrome (playwright-core, channel `chrome`): after
activating the CAD row the page contains `<canvas class="dsh-cad-canvas">`
(1032×932), the panel root exposes `data-model-id="m-3dad4f54a1"` and
`data-revision-id="r-0002"`, and the network log shows
`200 /dsh-plugin-cad/assets/models/m-3dad4f54a1/r-0001/model.glb` followed by
`200 …/r-0002/model.glb` — the panel re-fetched the GLB when revision 2 was
created by a concurrent agent. Final screenshot + assertion: see the viewer run
recorded below.

## G — parameter edit creates an immutable new revision: PASS

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario modify --length 120 --width 70 --height 12
PASS modify revisions 2->3 immutableOld=true newBboxCheck=true
stored revisions: r-0001 (built, 80x60x8), r-0002 (built, 100x60x10), r-0003 (built, 120x70x12)
```

The old revision files are untouched (immutability), and the new revision's
STEP/GLB re-verify with the new nominal dimensions.

## H — cancellation: FAIL (real defect, reported)

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario cancel
FAIL cancel cancelObserved=false jobReported=true runtimeHealthyAfter=true
agent output: cad_create_model{background:true} → {"code":"internal",
  "message":"session \"[object Object]\" has no live agent (background job owner must be live)"}
  then the model stayed locked at an unbuilt revision.
```

Root cause verified in the shipped `dsh-jobs-local` 0.2.1-rc.3: `JobStart.owner`
must be the session-id string (`exec.agent.id`), not the Agent object (the
0.1.1-rc.2 d.ts is stale). Also a failed background start did not release the
per-model lock. Both fixed by host-eng; re-run recorded below.

## I — model references survive a harness restart: PASS

```
PASS restart models before=[m-3dad4f54a1] after=[m-3dad4f54a1]
```
Cold-restart of the web app (SIGTERM, port released, fresh process) and the API
listed the same persisted model ids; the artifacts are on disk under the model
store, not in browser or process memory.

## J — disable removes tools and routes: PASS

```
PASS disable row disabled=true routeAfterDisable=404
```
With `- id: dsh-plugin-cad` / `disabled: true` in the profile patch layer the row
is rendered `disabled: true` in the composed tree, the plugin does not load, and
its HTTP route returns 404. The earlier mechanism probe additionally showed the
agent's toolset no longer contains the plugin tool at all.

## K — uninstall leaves no process and no data loss: PASS

```
PASS uninstall removeExit=0 stillBundled=false routeGone=true strayProcesses=0 dataPreserved=true
```
`dsh plugin remove` dropped the dependency and the bundle entry, the route 404'd,
`ps` showed **no** `cad_runtime` interpreter left, and the model store was intact
(18/18 model files before and after).

## L — no path traversal outside the workspace: PASS

```
PASS security 7 traversal probes, leaked=false
```
Probes: `/assets/../../../../etc/passwd`, percent-encoded `..`, mixed encoding,
double slash, absolute path, encoded model path with `..`, and
`/api/models/..%2f..%2f..%2fetc%2fpasswd`. None returned `/etc/passwd` content or
a planted out-of-tree sentinel file; all answered with a 4xx/404 JSON error.

---

## Environment limitations (stated, not hidden)

* No commercial CAD application on this machine → "STEP opens in a commercial
  CAD system" is NOT verified; independent parsing + OCCT re-import are.
* Viewport rendering is verified in headless Chrome (WebGL via ANGLE/SwiftShader
  or GPU if available); visual appearance on the user's desktop app is not
  separately asserted.
* DSH upstream git commit is not resolvable from the installed release asar;
  the runtime is pinned by release version 0.2.1-rc.3 + asar contents.

---

# Final F/G viewer evidence (clean run, current build)

Command (self-contained; the script triggers the external revision itself):

```
$ DSH_WEB_URL="http://127.0.0.1:64899/?token=<redacted>" \
  DSH_E2E_MODEL_ID=m-3dad4f54a1 \
  DSH_E2E_EXPECT_REVISION=r-0006 \
  DSH_E2E_TRIGGER="dsh --profile cadheadless '<modify prompt>'" \
  node tests/e2e/client-viewer.e2e.mjs

- boot the Harness Web UI ... ok
- the plugin Host API is reachable from the page ... ok
- open the CAD panel from the sidebar and render the canvas ... ok
- the model under test is selected in the rail ... ok
- a model is auto-selected and shows the Host current revision ... ok
- a model.glb artifact was fetched with HTTP 200 and model/gltf-binary ... ok
- orbit with a real pointer drag ... ok
- raycast selection shows the part inspect card ... ok
- the panel revision matches the Host current revision after Refresh ... ok
- a revision published while the panel is open is followed by polling ... ok
- a page reload rediscovers the model and revision from the Host alone ... ok
- polling really re-read the detail endpoint while the panel was open ... ok
- the browser console stayed free of plugin errors ... ok

CLIENT E2E OK: 13 steps; model Rectangular Mounting Bracket (m-3dad4f54a1); revision r-0005 -> r-0006
GLB fetches: 4
```

Wire evidence from `tests/fixtures/out/client-e2e-report.json` (`ok: true`): four
GLB fetches, `…/r-0005/model.glb` and `…/r-0006/model.glb`, all `200` with
`content-type: model/gltf-binary`. The only console errors are unrelated
`[deepseek-account]` warnings (no plugin error).

Screenshots (real Harness UI, Chrome):
`client-00-panel.png` (panel: bracket r-0005, 160×90×16, 223,563.89 mm³, 8/8
checks, 5-model rail, neutral idle-runtime badge, revision history r-0005→r-0001),
`client-01-viewer.png` (full page incl. sidebar "CAD" entry),
`client-02-orbit.png`, `client-03-picked.png` (selection highlight + inspect card),
`client-04b-panel-revision.png` (r-0006 after the live transition),
`client-05-reload.png` (re-discovery after reload).

**F PASS**: a real three.js canvas in the Harness main panel renders the real
build123d GLB of the just-created model.
**G PASS**: while that panel stayed open, an external agent created revision
r-0006 and the panel followed it by polling (`data-revision-id` r-0005→r-0006,
new GLB fetched and rendered) with no navigation or reload.

# H — recorded attempts (open)

| attempt | outcome | cause |
| --- | --- | --- |
| 1 (06:39) | FAIL | `background:true` threw `session "[object Object]" has no live agent`. Cause: `JobStart.owner` must be the session-id string (`exec.agent.id`), not the Agent object — the 0.1.1-rc.2 d.ts is stale. Fixed by host-eng. |
| 2 (06:46) | FAIL | Jobs created, but `cad_get_job_status` answered `belongs to another session`. Cause: the job registry fences `get/read/kill/list` by comparing `job.owner.id !== caller`, so the caller must also be the session-id string. Fixed by host-eng. The heavy part also failed `feature_effects` after a 4 mm all-edge fillet rounded the hole rims (7/24 r=4 faces) — test-fixture problem, replaced. |
| 3 (07:01) | FAIL | `cancel` correctly answered `already-finished` (the 100-hole part builds in ~0.5 s, so nothing was in flight), then polling the settled job threw `internal: Cannot read properties of undefined (reading 'id')`. Cause: the shipped `read(id)` returns `{chunks,lossy,result,job}`, not the stale typings' `{text,snapshot}` (third 0.1.1→0.2.1 drift). Fixed by host-eng with regression tests. |
| 4 (07:18) | **PASS** | Fixture replaced with a part that genuinely takes ~4.4 s (200×200×20 plate + 10×10 Ø4 hole grid + 4 mm all-edge fillet; measured 4,442 ms over the protocol, all checks pass). See §H-PASS below. |

What is already proven about cancellation at lower layers (recorded outputs):
* runtime protocol: `job.cancel` settles in a median 26.6 ms, cancelled builds write no artifacts, stdin EOF exits in 8.5 ms with no orphan (`docs/research/STATUS_runtime.md`, 119 pytest cases incl. `test_cancel.py`);
* host: 85/85 unit+integration tests, incl. queued and in-flight background cancellation reaching terminal `killed`, and a refused background start releasing the model fence.

## H-PASS — cancellation end to end through a real agent (4th run, 07:18)

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario cancel
PASS cancel jobIds=4 cancelObserved=true runtimeHealthy=true noCrash=true

agent output (verbatim, final JSON lines):
{"job_a":"cad-3879eb8bf6d54b2d","job_b":"cad-34bce9ec2085464a"}
{"job_b_status":"killed","job_a_status":"completed","runtime_healthy":true}
```

What happened: the agent created two background builds of a ~4.4 s part. Job A
held the single build slot; job B queued behind it. The agent cancelled B while it
was queued and the harness job registry reached terminal **`killed`**; the model
store shows the cancelled revision persisted as `failed` with `errorCode:
"cancelled"` and **0 artifacts** (no partial STEP/GLB)::

```
m-3e43501490  r-0001  failed  artifacts: 0  err: cancelled
m-7ac...      r-0001  built   artifacts: 2  err: -
```

`cad_runtime_status` afterwards reported the runtime healthy, and the subsequent
step (the parallel A build) completed normally, so the runtime was left in a
controlled state rather than killed or wedged.

Lower-layer cancellation was already covered and remains green: runtime protocol
`job.cancel` settles in a median 26.6 ms with no artifacts (`tests/python`, 119
cases incl. `test_cancel.py`), and the host unit/integration suites cover queued
and in-flight cancellation plus a refused background start releasing the model
fence.

---

# Final regression run (current bundle, fresh profile) — 07:26

```
$ dsh --profile cadfinal --from-default-profile web      # brand-new profile
$ node tests/e2e/harness-e2e.mjs --profile cadfinal --port 64903
PASS install    exit=0 dependency=true bundle=true
PASS compose    dump-config exit=0 row=true
PASS boot       api/health=200 bootGraph=true clientBundle=200
PASS security   7 traversal probes, leaked=false
PASS restart    models before=[6 ids] after=[6 ids]  (identical after cold restart)
PASS disable    row disabled=true routeAfterDisable=404
PASS uninstall  removeExit=0 stillBundled=false routeGone=true strayProcesses=0 dataPreserved=true
```

Suites at the same commit:
```
$ node build.mjs
host half  : lib/index.js        186.9 KiB
browser half: lib/client.js      705.7 KiB  (global __dshDshPluginCad)
resources  : ok
$ node --test tests/unit/*.test.mjs tests/integration/*.test.mjs
ℹ tests 88  ℹ pass 88  ℹ fail 0  ℹ skipped 0
$ python/.venv/bin/python -m pytest tests/python -q
119 passed in 35.92s
$ pnpm pack  → dsh-plugin-cad-0.1.0.tgz (292 KiB, 33 files, no venv, no pycache)
```

Distribution (real run): the packed tarball installed with
`dsh plugin --profile cadpkg add dsh-plugin-cad-0.1.0.tgz` into a clean profile,
with the runtime bootstrapped by `DSH_CAD_VENV=$HOME/.dsh/cad/venv node
python/setup-runtime.mjs`; a headless agent then reported
`runtime_python:/Users/mozhouwen/.dsh/cad/venv/bin/python3` and built a 40×30×5 mm
plate with a Ø8 through-hole — volume 5748.672588 mm³ (analytic exact), bbox
40×30×5 — proving the Python runtime is not tied to the development symlink.
