# STATUS — Web Client half (`dsh-plugin-cad` browser plugin)

Owner: **client-eng**. Scope: `src/client/**`, `locale/*.json`, `tests/e2e/client*.mjs`,
`docs/research/STATUS_client.md`. This file records **only observed** results; every
claim below was produced by a command that is quoted next to it.

Pinned host: DSH **0.2.1-rc.3**, Cordis **4.0.5**, three.js **0.186.1** (bundled).
Harness Web instance used for the real-UI evidence:
`http://127.0.0.1:64899/?token=<redacted>` (throwaway profile `cadtest`), Chrome
(`playwright-core` 1.64.1, `channel: "chrome"`).

---

## 1. Delivered files

| file | purpose |
| --- | --- |
| `src/client/index.tsx` | Cordis client plugin. Exports `inject = ['locale','slots']` and `apply(ctx)`. Registers en+zh dictionaries, one injected `<style>`, a `main` slot page (`key: 'dsh-plugin-cad'`) wrapped in an error boundary, and a `sidebar.panellist` entry with an inline SVG glyph. Every registration is a `ctx.effect` with a disposer; no Harness internal is imported beyond the documented `slots`/`locale` services. |
| `src/client/page.tsx` | The page: model rail, geometry/validation readout, revision history, viewer overlays, inspect card, polling, empty/loading/error/runtime states, keyboard shortcuts, aria labels, `localStorage` selected-model id only. |
| `src/client/viewer.ts` | Imperative three.js viewer: `WebGLRenderer`, `PerspectiveCamera`, `OrbitControls` (`three/examples/jsm/controls/OrbitControls.js`), `GLTFLoader`, `RoomEnvironment` PMREM IBL + studio lights, ground grid, axes + X/Y/Z sprites, `EdgesGeometry` CAD outlines, raycast selection (emissive highlight + `BoxHelper`), and a complete `dispose()`. |
| `src/client/api.ts` | Read-only viewer API client (health, models, model detail, revisions, artifact bytes) with typed parsing of the Host contract v1 and stable `ApiError`/`GlbError` codes. |
| `src/client/locale.ts` | en + zh runtime dictionaries (the `locale/*.json` files carry Plugin-Manager metadata only). |
| `src/client/styles.ts` | One stylesheet using Harness theme tokens (`--dsh-color-*` with the host's `--dsw-alias-*` fallbacks, dark-mode fallbacks under `[data-cad-theme="dark"]`), no fixed sizing that breaks the main panel, reduced-motion handling. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager metadata (title/description) + panel labels. |
| `tests/e2e/client-viewer.e2e.mjs` | Real-Harness Playwright E2E (skips with exit 0 when `DSH_WEB_URL` is unset). |

The authoritative shapes are host-eng's frozen contract: `src/host/api.ts` lines 1–140
and the "Viewer API (read-only) — authoritative shapes" section of
`docs/research/STATUS_host.md` (asserted by `tests/unit/api.test.mjs` 10/10 and
`tests/integration/runtime.test.mjs` 4/4). The client was reconciled against it field
by field (`modelId`, condensed list/history `report`, full detail `revision.report`
with both `boundingBox` and `bbox`, `latestStatus`/`failing`, `document`,
`viewer.glbUrl` = current revision). There are deliberately no `/api/jobs` calls:
`latestStatus:"unbuilt"` is treated as a build in flight and polled.

**Read-only by contract**: the client calls only
`GET /dsh-plugin-cad/api/{health,models,models/:id,models/:id/revisions}` and
`GET /dsh-plugin-cad/assets/models/...`. There is no create/rebuild/edit UI and no
mutating request anywhere in `src/client/**` (verified with grep for
`method: 'POST'|'PUT'|'DELETE'` → no match; the only `fetch` calls are GET). The Host
answers 405 `Allow: GET, HEAD` to any write method on both prefixes, and the client
would surface that as a typed `ApiError` rather than retrying.

---

## 2. Build

```
$ node build.mjs
host half  : lib/index.js        182.6 KiB
browser half: lib/client.js      705.7 KiB  (global __dshDshPluginCad)
resources  : ok
```

`lib/client.js` is the factory-registration format the Harness client module loader
consumes:

```
window.__ModuleLoader__.load({
  id: "dsh-plugin-cad",
  factory(require) { ... return __dshDshPluginCad; },
});
```

* three.js is **bundled locally** (no CDN fetch at runtime; the only absolute URL in
  the bundle is the inert `jcgt.org` citation string from three's source).
* `react` and `react/jsx-runtime` stay **external** (esbuild's dynamic-require helper
  appears as `ls("react")` / `ls("react/jsx-runtime")` in the minified output) and
  resolve through the factory's `require` from the shell module table — no duplicate
  React is shipped.
* The final artifact sizes on disk are `lib/client.js` = 722,618 bytes (705.7 KiB) and
  `lib/index.js` = 187,298 bytes.
* Typecheck of the client half (strict, standalone flags):
  `node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --jsx react-jsx --skipLibCheck --lib ES2022,DOM,DOM.Iterable --allowImportingTsExtensions --resolveJsonModule src/client/index.tsx`
  → exit 0, no diagnostics.
* The running Harness serves the rebuilt bundle without a restart: its client-modules
  route re-hashes the file per request (observed `dsh-plugin-cad/client.js&rev=` change
  from `89ff037286e7` to `6deecbf2a96c` while the process (started 06:27:31) stayed up).

---

## 3. Real Harness UI verification (primary evidence)

Script: `tests/e2e/client-viewer.e2e.mjs`, run against the live instance. It drives the
UI exactly as a person does: sidebar → CAD panel → orbit with a real pointer drag →
click to pick → refresh → page reload. It does **not** create or modify a model.

```
$ DSH_WEB_URL="http://127.0.0.1:64899/?token=<redacted>" DSH_E2E_WAIT_REVISION=0 \
  node tests/e2e/client-viewer.e2e.mjs
- boot the Harness Web UI ... ok
- the plugin Host API is reachable from the page ... ok
- open the CAD panel from the sidebar and render the canvas ... ok
- a model is auto-selected and shows the Host current revision ... ok
- a model.glb artifact was fetched with HTTP 200 and model/gltf-binary ... ok
- orbit with a real pointer drag ... ok
- raycast selection shows the part inspect card ... ok
- the panel revision matches the Host current revision after Refresh ... ok
  (revision-change step skipped by DSH_E2E_WAIT_REVISION=0)
- a page reload rediscovers the model and revision from the Host alone ... ok
- polling really re-read the detail endpoint while the panel was open ... ok
- the browser console stayed free of plugin errors ... ok

CLIENT E2E OK: 12 steps; model Rectangular Mounting Bracket (m-3dad4f54a1); revision r-0003 -> r-0003
GLB fetches: 3; screenshots + report: tests/fixtures/out
```

Observed on the wire during that run (`client-e2e-report.json` → `glbResponses`,
`apiRequests`): `GET /dsh-plugin-cad/api/health -> 200`,
`GET /api/models?limit=100&include_failed=true -> 200`,
`GET /api/models/m-3dad4f54a1?include=full -> 200`,
repeated `GET /api/models/m-3dad4f54a1?include=summary -> 200` (2 s polling),
and `200` with `content-type: model/gltf-binary` for
`/dsh-plugin-cad/assets/models/m-3dad4f54a1/r-0001/model.glb` and `…/r-0003/model.glb`.
No plugin console errors (the only console error in the profile is the unrelated
`[deepseek-account] … 403` of the shell).

**Scenario F evidence (real Harness panel, not the mock)** —
`tests/fixtures/out/client-00-panel.png` is an element screenshot of the live panel
inside the Harness UI (1160 × 900). It shows, from a real build123d GLB served by the
Host: the CAD page with model rail (2 models), the 3D bracket with its Ø20 bore and
four Ø6 holes rendered in WebGL, the geometry readout (revision r-0003, volume
95,672.92 mm³, surface area 22,164.25 mm², bbox 120 × 12 × 70 mm, solids 1, faces 11,
edges 27, vertices 18, 1,292 triangles), `校验 8/8 通过 · 0 警告`, parameters
(center_hole_diameter 20, corner_hole_diameter 6, corner_inset 12, length 120,
thickness 12, width 70), revision history r-0003/r-0002/r-0001 with volumes, and the
neutral runtime badge `运行时空闲（首次构建时启动）` — no false "runtime unavailable"
banner. Full-page captures: `client-01-viewer.png`, `client-02-orbit.png`,
`client-03-picked.png`, `client-05-reload.png`.

The panel is registered in the real shell too: the sidebar panellist button carries
`aria-label="CAD"` and opens the `main` slot page; the page root exposes
`data-model-id`, `data-revision-id`, and the automation hooks `cad-canvas`,
`cad-model-list` (each row carries its own `data-model-id`), `cad-revision`,
`cad-status`, `cad-model-name` (plus `cad-refresh`, `cad-fit`, `cad-reset`). The E2E can
pin the model under test with `DSH_E2E_MODEL_ID` (it clicks that row) instead of
depending on auto-selection.

### Artifact regeneration after another teammate cleaned the scratch dir

host-eng deleted the gitignored `tests/fixtures/out/` scratch directory at ~06:46 while
cleaning generated files (and the Harness instance was restarted, new URL token). The
artifacts above were regenerated against the restarted instance with the current build;
this run also exercises the new `DSH_E2E_MODEL_ID` pinning step:

```
$ DSH_WEB_URL="http://127.0.0.1:64899/?token=<redacted>" DSH_E2E_MODEL_ID=m-3dad4f54a1 \
  DSH_E2E_EXPECT_REVISION=r-0004 DSH_E2E_WAIT_REVISION=1 \
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

CLIENT E2E OK: 13 steps; model Rectangular Mounting Bracket (m-3dad4f54a1); revision r-0004 -> r-0004
GLB fetches: 4; screenshots + report: tests/fixtures/out
```

The Host already sat at r-0004 when this run started (that revision was created by the
live-change run documented below), so this regeneration confirms the r-0004 state and
the 200 GLB, but it is **not** a second live r→r+1 transition; the live transition is
the run below. All screenshots listed in §3 now exist again and show r-0004.

### Revision refresh while the panel is open (scenario G) — PASS

The first 240 s watch window expired **without** the external writer creating a
revision (Host `currentRevisionId` stayed `r-0003` — verified). The step was re-run
with a 600 s window and `DSH_E2E_EXPECT_REVISION=r-0004`; while the panel stayed open
on `m-3dad4f54a1` (r-0003), a **real headless agent in another process** created
r-0004 (`parameters length 140 / width 80 / thickness 14`, STEP+GLB exported). The
complete run:

```
$ DSH_WEB_URL="http://127.0.0.1:64899/?token=<redacted>" DSH_E2E_WAIT_REVISION=1 \
  DSH_E2E_EXPECT_REVISION=r-0004 DSH_E2E_REVISION_TIMEOUT_MS=600000 \
  node tests/e2e/client-viewer.e2e.mjs
- boot the Harness Web UI ... ok
- the plugin Host API is reachable from the page ... ok
- open the CAD panel from the sidebar and render the canvas ... ok
- a model is auto-selected and shows the Host current revision ... ok
- a model.glb artifact was fetched with HTTP 200 and model/gltf-binary ... ok
- orbit with a real pointer drag ... ok
- raycast selection shows the part inspect card ... ok
- the panel revision matches the Host current revision after Refresh ... ok
- a revision published while the panel is open is followed by polling ...
  waiting up to 600s for an external writer to create the next revision…
ok
- a page reload rediscovers the model and revision from the Host alone ... ok
- polling really re-read the detail endpoint while the panel was open ... ok
- the browser console stayed free of plugin errors ... ok

CLIENT E2E OK: 12 steps; model Rectangular Mounting Bracket (m-3dad4f54a1); revision r-0003 -> r-0004
GLB fetches: 4; screenshots + report: tests/fixtures/out
```

Report (`tests/fixtures/out/client-e2e-report.json`, `ok: true`) records the GLB
responses observed on the wire, all `200` + `model/gltf-binary`:
`…/m-3dad4f54a1/r-0003/model.glb`, then `…/m-3dad4f54a1/r-0004/model.glb` (fetched
again after the page reload). The open panel followed the revision without navigation:
`data-revision-id` r-0003 → r-0004, and the post-change element screenshot
`tests/fixtures/out/client-04b-panel-revision.png` shows the real Harness UI with the
**new geometry**: header `修订 r-0004`, revision badge r-0004, volume
150,818.41 mm³, bbox 140 × 14 × 80 mm (glTF Y-up; = 140 × 80 × 14 mm CAD), 1,292
triangles, parameters length 140 / width 80 / thickness 14, `校验 8/8 通过 · 0 警告`,
history r-0004/r-0003/r-0002/r-0001, and the toast
`Host 发布了 r-0004，查看器已重新加载。` Full-page capture:
`tests/fixtures/out/client-04-revision2.png`.

---

## 4. Deterministic mock-Host verification (secondary evidence)

Because the real Python runtime cannot be rebuilt on demand by the browser test, the
viewer was also exercised against a local mock Host implementing the **exact** contract
v1 shapes (`/tmp/cad-smoke/mock-server.mjs`, not shipped) with two generated GLB
revisions and a fake module loader that renders the *same built* `lib/client.js`
through a fake `slots`/`locale` context. This isolates the browser half:

```
MOCK SMOKE OK: 14 steps, 4 GLB fetches, screenshots in /tmp/cad-smoke/out
```

Steps (all ok): boot via factory bundle + `apply` (main + sidebar registered, sidebar
aria-label CAD) · WebGL canvas appears and `cad-status=ready` · Host model/revision
rendered · `model.glb` 200 `model/gltf-binary` · orbit changes the rendered image ·
click raycasts, highlights and shows the inspect card · R/F/Esc · Host-published
r-0002 is picked up by polling and its GLB is fetched · a failed latest build shows the
banner while the last good revision stays rendered · a **stopped-but-healthy** runtime
shows no banner (idle badge only) · an errored runtime shows the offline banner ·
empty store shows the empty state · unmounting the slot removes the canvas and leaves
no plugin errors.

Pixel evidence (Pillow): `01-initial.png` std-dev ≈ 19 per channel (real rendered
content, not a blank canvas); orbit diff RMS ≈ 12.5; revision-2 diff RMS ≈ 15.6.

---

## 5. Resource disposal

`CadViewer.dispose()` is called from the page's React unmount effect and is idempotent:
aborts in-flight GLB fetches, cancels the RAF loop, removes pointer/context/visibility
listeners, disconnects the `ResizeObserver`, disposes the selection `BoxHelper`, every
model geometry/material/texture (including `EdgesGeometry`/`LineSegments`), grid, axes,
label canvas textures, the PMREM render target and `RoomEnvironment`, then
`controls.dispose()`, `renderer.dispose()`, `renderer.forceContextLoss()` and removes
the canvas. The mock run's final step asserts the `<canvas>` is gone after unmount and
the console is clean. Keyboard handling and the 2 s polling interval live in React
effects with cleanup; polling also stops while `document.visibilityState !== 'visible'`
or the slot is not visible.

---

## 6. Bugs found and fixed during real-UI verification

1. **False "runtime unavailable" banner.** The viewer treated
   `runtime.available === false` as a fault, but the Python runtime is spawned lazily:
   in the web process a healthy runtime is `{available:false, state:"stopped",
   lastError:null}`. The page now shows a neutral badge
   `运行时空闲（首次构建时启动）` for that state and only shows the offline banner for
   `lastError != null` or `state ∈ {crashed,error,failed}` (or an unreachable health
   route). Verified in the real panel screenshot above and in the mock smoke test.
2. **Auto-selection picked an unbuilt model** (newest by `updatedAt`), leaving the
   viewer on an empty state even though a built model existed. The page now prefers the
   newest model that has built geometry, falling back to the newest model when none is
   built. Verified on the real instance: the newer 200×200 plate (unbuilt r-0001) exists,
   yet the panel auto-selects the built bracket r-0003.
3. **`unbuilt` rendered as an error.** Per the Host contract `latestStatus:"unbuilt"`
   means a build is in flight, so the page now shows a build-in-progress card
   (`正在构建…`), keeps polling, and flips to the geometry when the Host publishes the
   built revision.
4. **Revision history pinned-view GLB.** `viewer.glbUrl` always describes the Host's
   *current* revision; when the user pins an older revision from history the page now
   loads that revision's own artifact URL (or shows its failed/unbuilt state) instead
   of silently showing the current geometry.
5. **Locale-dependent E2E assertions.** The real profile runs in Chinese; the E2E
   asserts bilingual labels (`triangles|三角形`, `bounding box|包围盒`) and uses
   `data-testid` hooks rather than localized button names.

---

## 7. What is verified visually vs. what is not

Verified in the real Harness UI (screenshots + network + DOM assertions listed above):
panel registration and sidebar entry; real GLB from the real build123d runtime rendered
in WebGL; orbit by pointer; raycast highlight + inspect card; geometry/validation/
parameters/history readouts; panel/Host revision agreement; reload recovery from Host
state; polling traffic; no plugin console errors; idle-runtime badge without a banner.

Verified in the real Harness UI, in addition: an externally created revision
(r-0003 → r-0004) is picked up by polling while the panel is open, the new GLB is
fetched and rendered without navigation, and the page reload afterwards rediscovers the
same model at r-0004 from the Host alone (§3, PASS).

Verified against the deterministic mock Host: a failed latest build keeping the last
good geometry rendered, runtime error banner, empty state, stopped-but-healthy idle
badge, unmount disposal, R/F/Esc shortcuts.

**Not verified**: STEP/STL/SVG artifact downloads or the SVG preview cache (out of
scope for this viewer); explicit human-driven switching between two models in a real
browser session (auto-selection was verified; the model rail click handler is exercised
by the same code path as selection); real-Human keyboard shortcuts in the Harness UI
(they were exercised in the mock harness and the page's guard is shared); WebGL on
GPUs/drivers other than this machine's Chrome/SwiftShader.

---

## 8. Reproduce

```sh
# build both halves
cd <repo> && node build.mjs

# real-Harness E2E (skips cleanly, exit 0, when DSH_WEB_URL is unset)
DSH_WEB_URL="http://127.0.0.1:64899/?token=..." node tests/e2e/client-viewer.e2e.mjs

# show the skip path even in an agent session whose env already defines
# DSH_WEB_URL (e.g. the desktop GUI URL, which is not the cadtest profile):
env -u DSH_WEB_URL node tests/e2e/client-viewer.e2e.mjs
# [client-viewer.e2e] SKIPPED: DSH_WEB_URL is not set.   (exit 0)

# wait for an external writer to publish the next revision (Lead's headless agent):
DSH_WEB_URL="http://127.0.0.1:64899/?token=..." \
DSH_E2E_WAIT_REVISION=1 DSH_E2E_EXPECT_REVISION=r-0004 \
DSH_E2E_REVISION_TIMEOUT_MS=600000 node tests/e2e/client-viewer.e2e.mjs

# pin the model instead of relying on auto-selection:
DSH_E2E_MODEL_ID=m-3dad4f54a1 DSH_E2E_EXPECT_REVISION=r-0004 \
DSH_WEB_URL="http://127.0.0.1:64899/?token=..." node tests/e2e/client-viewer.e2e.mjs
```
