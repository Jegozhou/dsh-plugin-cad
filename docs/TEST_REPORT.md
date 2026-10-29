# Test report — acceptance scenarios A–L

**Rule of this document:** a scenario is `PASS` only when a **recorded run** in
`tests/e2e/RESULTS.md` (or an owner status file it cites) supports it. `FAIL` is a
recorded failure — reported as such, with the defect, even when a fix is claimed
but not yet re-run. Every result below quotes the run that produced it.

**Authoritative source:** `tests/e2e/RESULTS.md` (Lead-owned, appended as runs
complete). This report is the aggregated reading of that file at the snapshot
below; **if the two ever disagree, `RESULTS.md` wins**.

**Snapshot:** 2026-10-30 07:26 (+08:00), verified tree **git commit `7b5d88f`**
(113 files, 28,709 insertions), `RESULTS.md` 24,136 bytes — updated top A–L table,
per-scenario §A–§L, the final F/G viewer run, the H attempt history, §H-PASS and
the "Final regression run" on a brand-new profile. Owner files:
`STATUS_runtime.md` (119 pytest cases), `STATUS_host.md` (88/88 host tests),
`STATUS_client.md`.

---

## 1. Environment under test

Quoted from the header of `tests/e2e/RESULTS.md`:

> Environment: macOS 26.2 (25C56) arm64 · DSH app/CLI **0.2.1-rc.3** · cordis
> 4.0.5 · bundled Node 24.21.0 · profile root `~/.dsh`.

Pinned runtime: CPython 3.12.13, build123d 0.13.0, OCP 8.0.1.1 (OCCT 8.0.1),
trimesh 5.2.0, numpy 2.5.4; freeze `python/requirements.lock.txt`. Profiles used:
`cadlife` (install/boot/disable/uninstall), `cadtest` (viewer), `cadheadless`
(agent), and `cadpkg` (distribution test, installed from the packed tarball). The
user's personal `desktop`/`web` profiles were not used.

---

## 2. Scenario results

| # | Scenario (project brief) | Result | Recorded evidence |
| --- | --- | --- | --- |
| A | Plugin installs and enables | **PASS** | §A: `PASS install exit=0 dependency=true bundle=true`; `PASS compose dump-config exit=0 row=true`; `PASS boot api/health=200 bootGraph=true clientBundle=200`; re-verified on brand-new profile `cadfinal` (§Final regression) |
| B | Agent discovers native CAD tools | **PASS** | §B: `PASS discover … toolNameInAnswer=true okMentioned=true 6.5s` — a real headless agent called `cad_list_models` and reported `ok:true` |
| C | Agent creates a parametric part with correct dimensions | **PASS** | §C/D/E: `PASS create model=m-3dad4f54a1 rev=r-0001 checks=12/12`; volume 34,981.947, bbox 80×60×8; store + workspace exports recorded |
| D | Python runtime returns valid real geometry | **PASS** | §C/D/E + §M1-D: 8/8 checks, 11 faces / 27 edges / 18 vertices / 1 solid, volume = analytic 34,981.947 |
| E | STEP opens in an independent CAD parser | **PASS†** | §C/D/E + §M1-E: independent pure-JS ISO-10303-21 verifier (770 entities, 0 dangling refs, 1 `MANIFOLD_SOLID_BREP`, 11 `ADVANCED_FACE`, radii [3,3,3,3,10]) + separate-process OCCT re-import reproducing the volume. † **No commercial CAD app on this machine → "opens in a commercial CAD system" is NOT verified** |
| F | In-Harness viewer displays the model | **PASS** | Final clean run `CLIENT E2E OK: 13 steps …` — real Harness UI in Chrome: panel from sidebar, WebGL canvas renders the real build123d GLB (`200` + `model/gltf-binary`), orbit, raycast pick, reload recovery, no plugin console errors; `client-e2e-report.json` `ok:true`; screenshot `client-00-panel.png` |
| G | Parameter change → viewer shows new revision | **PASS** | Final clean run: while the panel stayed open an external agent published **r-0006**; panel followed r-0005 → r-0006 by polling (`data-revision-id`, new GLB fetched and rendered, no reload); screenshot `client-04b-panel-revision.png`; revision immutability r-0001→r-0005 recorded in §G |
| H | Cancel mid-build leaves the runtime controlled | **PASS** (4th run) | §H-PASS: `PASS cancel jobIds=4 cancelObserved=true runtimeHealthy=true noCrash=true`; agent output `{"job_b_status":"killed","job_a_status":"completed","runtime_healthy":true}`; cancelled revision persisted `failed` / `cancelled` with **0 artifacts**; runtime healthy and the parallel build completed |
| I | Model reference survives harness restart | **PASS** | §I: `PASS restart models before=[m-3dad4f54a1] after=[m-3dad4f54a1]` after SIGTERM/cold restart; re-verified on `cadfinal` with 6 model ids identical before/after |
| J | Disable → tools unavailable, resources released | **PASS** | §J: `PASS disable row disabled=true routeAfterDisable=404`; tool absent from the agent's toolset (§M0-J) |
| K | Uninstall → no child process, no CAD data loss | **PASS** | §K: `PASS uninstall removeExit=0 stillBundled=false routeGone=true strayProcesses=0 dataPreserved=true`; 18/18 model files intact; re-verified on brand-new profile `cadfinal` |
| L | No path traversal outside the workspace | **PASS** | §L: `PASS security 7 traversal probes, leaked=false` — 7 probes incl. encoded/double-slash/absolute forms, all 4xx/404 JSON, no sentinel leak |

**Summary: 12 PASS, 0 FAIL, 0 PARTIAL.** † E is verified with an independent
parser + OCCT re-import, not a commercial CAD application (none installed).

---

## 3. H — cancellation: PASS after four recorded attempts

H is the most instructive scenario in the project: it failed three times for
three **distinct** host-contract drifts, each caught by a recorded run, fixed, and
regression-tested. The history is kept because it is the evidence that the final
PASS is real.

| attempt | outcome | recorded cause |
| --- | --- | --- |
| 1 (06:39) | FAIL | `background:true` threw `session "[object Object]" has no live agent`. `JobStart.owner` must be the session-id string (`exec.agent.id`), not the Agent object (stale 0.1.1-rc.2 d.ts). |
| 2 (06:46) | FAIL | Jobs created but `cad_get_job_status` answered `belongs to another session`: the registry fences `get/read/kill/list` by comparing `job.owner.id !== caller`, so the **caller** must also be the session-id string. That run's fixture also tripped `feature_effects` (see §5). |
| 3 (07:01) | FAIL | Cancel correctly answered `already-finished` (the fixture built in ~0.5 s, nothing in flight), then polling the settled job threw `internal: Cannot read properties of undefined (reading 'id')` — the shipped `read(id)` returns `{chunks,lossy,result,job}`, not the typings' `{text,snapshot}`. |
| 4 (07:18) | **PASS** | Fixture replaced with a part that genuinely takes ~4.4 s (200×200×20 plate, 10×10 Ø4 grid, 4 mm all-edge fillet; measured 4,442 ms over the protocol, all checks pass). |

Final recorded run (`RESULTS.md` §H-PASS):

```
$ node tests/e2e/agent-e2e.mjs --profile cadheadless --scenario cancel
PASS cancel jobIds=4 cancelObserved=true runtimeHealthy=true noCrash=true

agent output (verbatim):
{"job_a":"cad-3879eb8bf6d54b2d","job_b":"cad-34bce9ec2085464a"}
{"job_b_status":"killed","job_a_status":"completed","runtime_healthy":true}
```

Job A held the single build slot; job B queued behind it and the agent cancelled B
while queued. The registry reached terminal **`killed`**; the store shows the
cancelled revision persisted `failed` with `errorCode: "cancelled"` and **0
artifacts** (`m-3e43501490 r-0001 failed artifacts:0 err:cancelled`); the runtime
stayed healthy and the parallel A build completed. That is exactly the required
"runtime left in a controlled state" outcome.

Lower layers were already green and remain so: runtime `job.cancel` settles in a
median 26.6 ms with no artifacts (`tests/python`, 119 cases incl.
`test_cancel.py`); host unit/integration suites (88/88 per `STATUS_host.md`)
cover queued and in-flight cancellation plus a refused background start releasing
the model fence.

---

## 4. F/G — final clean viewer run

Command and result recorded in `RESULTS.md` "Final F/G viewer evidence (clean
run, current build)":

```
CLIENT E2E OK: 13 steps; model Rectangular Mounting Bracket (m-3dad4f54a1); revision r-0005 -> r-0006
GLB fetches: 4
```

Wire evidence from `tests/fixtures/out/client-e2e-report.json` (`ok:true`, 6,394
bytes, 2026-10-30T07:01): four GLB fetches — `…/r-0005/model.glb` and
`…/r-0006/model.glb`, all `200` with `content-type: model/gltf-binary`; the only
console errors are unrelated `[deepseek-account]` warnings. The report and the
screenshots are **tracked in the verified tree** (`git ls-files tests/fixtures/out`).

Screenshots (real Harness UI, Chrome): `client-00-panel.png` (bracket r-0005,
160×90×16, 223,563.89 mm³, 8/8 checks, 5-model rail, neutral idle-runtime badge,
history r-0005→r-0001), `client-01-viewer.png` (sidebar "CAD" entry),
`client-02-orbit.png`, `client-03-picked.png`, `client-04b-panel-revision.png`
(r-0006 after the live transition), `client-05-reload.png`.

F = the canvas really renders the just-created model; G = a revision published by
an external agent while the panel stayed open is followed by polling without
navigation or reload.

---

## 5. E caveat and the `feature_effects`-after-fillet limitation

**E caveat (verbatim from the evidence):** no FreeCAD / SolidWorks / Fusion / Rhino
is installed on this machine, so "opens in a commercial CAD system" is **not**
verified. E is PASS only in the structural + independent-parser sense: the pure-JS
ISO-10303-21 verifier checks the entity graph, dangling references,
`MANIFOLD_SOLID_BREP`, faces and cylindrical radii, and a separate OCCT re-import
reproduces the volume.

**Known limitation found while fixing H (state it precisely):** the runtime's
`feature_effects` check counts cylindrical faces **by radius**. If a fillet
radius equals a hole radius, the fillet consumes/merges the hole-rim faces and the
count can mis-fire. Recorded evidence: Ø8 bolt-circle holes (r=4) + `fillet
radius 4 all_edges` → `feature_effects` fails with "7 cylindrical face(s) r=4 mm
appeared (expected 24)" → `invalid_geometry`. With a distinct radius (Ø4 holes +
fillet 4) the same part builds and all 8 checks pass. This is a **conservative
heuristic limitation, not a kernel/geometry error** — the B-rep is valid.
Recommendation (also in `README.md` and `skills/parameterized-cad-design`): keep
the fillet radius different from any hole radius.

---

## 6. Other recorded evidence (not A–L scenarios)

- **Host half** — `STATUS_host.md`: typecheck exit 0; `lib/index.js` ESM with Node
  builtins only; **88/88 unit+integration tests pass**, including real build123d
  integration, queued/in-flight cancellation to terminal `killed`, refused
  background start releasing the model fence, store traversal/symlink refusal.
- **Python runtime** — `STATUS_runtime.md` §2: `--selftest` JSON (volume
  34981.947193 = analytic, bbox 80×60×8, 8 checks, four artifacts with sha256),
  installer `--check`, and **119 pytest cases pass** (reproduced twice).
- **Client half** — `STATUS_client.md` §2–§5: build output (factory bundle,
  React external, strict client typecheck exit 0), real-UI E2E evidence,
  deterministic mock-Host checks, disposal assertions.
- **Build + suites (commit `7b5d88f`)** — `node build.mjs` → host
  `lib/index.js` **186.9 KiB** (Node builtins only), browser `lib/client.js`
  **705.7 KiB** factory bundle, resources ok; `node --test
  tests/unit/*.test.mjs tests/integration/*.test.mjs` → **88/88 pass, 0 fail,
  0 skip**; `python/.venv/bin/python -m pytest tests/python -q` → **119 passed in
  35.92 s**.
- **Final lifecycle E2E on a brand-new profile** — `dsh --profile cadfinal
  --from-default-profile web` then `harness-e2e.mjs`: **7/7 PASS** (install,
  compose, boot, security 7 probes, restart with 6 identical model ids, disable
  route 404, uninstall 0 stray processes + data preserved);
  `tests/e2e/evidence/final-lifecycle-report.json` `ok:true`.
- **Distribution** — verified on this machine: `pnpm pack` produced
  `dsh-plugin-cad-0.1.0.tgz` (**297,501 bytes on disk**, 33 files, no
  `python/.venv`, no `__pycache__`); `DSH_CAD_VENV=$HOME/.dsh/cad/venv node
  python/setup-runtime.mjs` installed CPython 3.12.13 + pins + self-test
  (`~/.dsh/cad/venv/bin/python3` is Python 3.12.13); `dsh plugin --profile cadpkg
  add dsh-plugin-cad-0.1.0.tgz` installed it (`package.json` dependency
  `file:…/dsh-plugin-cad-0.1.0.tgz`, bundle list includes `dsh-plugin-cad`); a
  headless agent in that profile reported
  `runtime_python: /Users/<user>/.dsh/cad/venv/bin/python3` and built a 40×30×5
  plate with a Ø8 hole — report `volume 5748.672588`, bbox [40,30,5], all 8 checks
  pass (`~/.dsh/cad/models/m-6fcb1abc46/revisions/r-0001/report.json`).

Nothing in this section substitutes for an A–L scenario run.

---

## 7. Environment limitations (verbatim from the evidence file)

> * No commercial CAD application on this machine → "STEP opens in a commercial
>   CAD system" is NOT verified; independent parsing + OCCT re-import are.
> * Viewport rendering is verified in headless Chrome (WebGL via ANGLE/SwiftShader
>   or GPU if available); visual appearance on the user's desktop app is not
>   separately asserted.
> * DSH upstream git commit is not resolvable from the installed release asar;
>   the runtime is pinned by release version 0.2.1-rc.3 + asar contents.

Also not verified (owner statements): Windows/Linux (runtime reader loop is
POSIX-only), browser engines other than this machine's Chrome, STEP/STL/SVG
downloads in the viewer, explicit human-driven model switching in a real session
(auto-selection is verified), real-human keyboard shortcuts in the Harness UI
(exercised against the mock Harness).

---

## 8. How a scenario's result is changed

1. Run against the real plugin in a dedicated profile (`cadlife` / `cadtest` /
   `cadheadless` / `cadpkg`); never the user's personal profiles.
2. Record in `tests/e2e/RESULTS.md`: exact command, exit code, trimmed verbatim
   output; UI evidence under `tests/fixtures/out/` or `tests/e2e/evidence/`.
3. State what the run proves and what it does not (the E caveat and the H attempt
   history are the model to follow).
4. Only then does this report change the row, quoting the same evidence.

---

## 9. Honesty statement

At verified tree **`7b5d88f`**, the acceptance set is **12 PASS, 0 FAIL, 0 PARTIAL**, with two explicitly stated
caveats: E is verified by independent parsing + OCCT re-import, not by a
commercial CAD application, and H only passed on the fourth attempt after three
real host-contract defects were found and fixed. The documented limitation about
`feature_effects` and fillet radii applies to modelling guidance, not to
acceptance. Do not restate this as "fully verified against a commercial CAD
system" — that was never tested.
