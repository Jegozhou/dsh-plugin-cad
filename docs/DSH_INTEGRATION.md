# DeepSeek Harness integration

How `dsh-plugin-cad` attaches to the pinned Harness release: the profile/bundle
mechanism, the plugin row, the four registries it uses (tools, jobs, routes,
client slots), and the exact install/enable/disable/uninstall commands with the
outputs actually recorded.

**Pinned host:** DeepSeek Harness `0.2.1-rc.3`, `@deepseek-ai/cordis 4.0.5`,
bundled Node `24.21.0`, pnpm `11.28.5`. Full matrix and the provenance of each
number: `docs/COMPATIBILITY_MATRIX.md`.

**Evidence convention.** Every command below is tagged with where its output is
recorded:

- **[notes]** — `docs/research/DSH_PLUGIN_API_NOTES.md` (host recon by the team,
  checked against the installed asar runtime and two installed third-party
  plugins);
- **[docs-eng]** — run by the documentation owner while writing this file
  (2026-10-30); output quoted inline;
- **[lead]** — run by the Lead during the boot/install probe; the verbatim record
  belongs in `tests/e2e/RESULTS.md` (must be present before this file is cited
  as acceptance evidence);
- **[owner]** — owned by the runtime/host/client engineer and recorded in
  `docs/research/STATUS_<owner>.md`.

---

## 1. What "installing a plugin" means on this host

A running `dsh` is a **plugin tree composed at boot from ordered layers**
(upstream `docs/architecture.md` §"Profiles and bundles", fetched 2026-10-30 from
`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`).
There is no privileged core to patch: you extend the harness by mounting a
plugin beside the others, and registrations are effects that unwind on unload.

Terminology, verified on this machine:

| term | meaning here |
| --- | --- |
| **Harness home** | `~/.dsh` (`DSH_HOME`) |
| **profile** | a named composition directory `~/.dsh/profiles/<name>/` |
| **bundle** | a package that ships a `cordis.patch.yml` and is listed in a profile's `dsh.profile.bundles` |
| **plugin row** | one entry in the composed Cordis tree: `{id, name, config}`; the loader imports the package entry and calls `apply(ctx, config)` |
| **patch layer** | a top-level YAML array of `insert` / by-id override / `disabled` entries |

Our package is simultaneously the plugin *and* the bundle that inserts its own
row: `package.json` declares `dsh.plugin: true`, `dsh.kind: "server"`,
`dsh.bundle.patch: "./cordis.patch.yml"`.

### Profile directory layout [notes §1; `[docs-eng]` read of `~/.dsh/profiles/cadtest`]

```
~/.dsh/profiles/<name>/
  package.json          # {name: "dsh-profile-<name>", dependencies, dsh.profile.bundles[]}
  cordis.yml            # always [] — the tree is composed from patches
  cordis.patch.yml      # the user's patch layer, applied last
  pnpm-workspace.yaml   # packages: [.], nodeLinker: hoisted, autoInstallPeers: false
  node_modules/
  .plugin-manager/      # in-app plugin manager state (enable/disable)
```

Composition order: **each bundle patch in `dsh.profile.bundles` order → the
profile's `cordis.patch.yml` → `--patch` overlays**. A patch targets a row by
`id` and replaces its whole `config` (no deep merge); it can also `insert` new
rows or set `disabled: true`. `!!js` expressions are allowed.

`dsh --profile <p> --dump-config` prints the composed tree and is the
authoritative check that a row exists. `[docs-eng]` on this machine:

```console
$ ~/.local/bin/dsh-wrapper --version
0.2.1-rc.3

$ ~/.local/bin/dsh-wrapper --profile cadtest --dump-config | grep -A3 dsh-plugin-m0probe
- id: dsh-plugin-m0probe
  name: dsh-plugin-m0probe
  config:
    marker: m0-probe
```

(The `dsh-plugin-m0probe` row is the Lead's temporary probe plugin; the real
`dsh-plugin-cad` row appears the same way once installed.)

---

## 2. The plugin row and its config

`cordis.patch.yml` in this repository is the bundle patch. It contains one
`insert` entry:

```yaml
- insert:
    - id: dsh-plugin-cad
      name: 'dsh-plugin-cad'
      config:
        dataDir: ''
        pythonExecutable: ''
        pythonPath: ''
        allowExport: true
        allowModelWrite: true
        buildTimeoutMs: 180000
        runtimeStartTimeoutMs: 240000
        maxConcurrentBuilds: 1
        maxBoundingBoxMm: 2000
        maxArtifactBytes: 134217728
```

The `config` object is passed verbatim to `apply(ctx, config)`. A user override
must restate the **complete** object (patches replace `config` wholesale) — this
is documented in the file header so users do not lose defaults by accident.

| key | default | effect | where enforced |
| --- | --- | --- | --- |
| `dataDir` | `''` → `<DSH_HOME>/cad` | model store root | Host store |
| `pythonExecutable` | `''` → documented uv CPython | interpreter for the runtime child | runtime supervisor |
| `pythonPath` | `''` | extra `PYTHONPATH` for `cad_runtime` | runtime supervisor |
| `allowExport` | `true` | permit `cad_export_model` to write into the workspace | Host tool |
| `allowModelWrite` | `true` | permit create/modify (read-only mode when false) | Host tools |
| `buildTimeoutMs` | `180000` | per-build timeout → `timeout` | Host pipeline |
| `runtimeStartTimeoutMs` | `240000` | cold start allowance (≈80 s import) | supervisor |
| `maxConcurrentBuilds` | `1` | global build concurrency | build queue |
| `maxBoundingBoxMm` | `2000` | `bounding_box` validation check | runtime report |
| `maxArtifactBytes` | `134217728` | artifact size cap → `too_large` (413) | Host store/route |

Two further keys are accepted by the plugin's config normalizer but are **not**
declared in the shipped bundle patch, so they are opt-in only:
`allowRuntimeInstall` (default `false`; gates whether
`cad_runtime_status {action:"repair"}` may spawn the runtime installer) and
`checks` (subset of validation check ids). Everything is clamped in
`src/host/config.ts` (`normalizeConfig`); a malformed patch cannot raise a hard
limit.

---

## 3. Tool registration

Native tools are registered through `ctx.tools.register(definition)`, once per
tool, inside `apply(ctx, config)`, and the returned disposer is wrapped in
`ctx.effect` so a disable removes them [notes §2, §3]. The host owns the
`tools/pre-execute → tools/execute → tools/post-execute` pipeline: **permissions,
approvals, timeouts and cancellation are the harness's**, so the plugin
implements no approval flow and simply honours `exec.signal`.

Definition shape required by the host [notes §3]:

```js
ctx.tools.register({
  name: 'cad_create_model',
  description: '…',
  parameters: TOOL_SCHEMAS.cad_create_model,      // object-rooted JSON Schema
  output: {
    schema: {},                                    // mandatory canonical output schema
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  presentCall: args => ({ card: 'generic', title: 'Create CAD model', kind: 'other', rawInput: args }),
  async execute(args, exec) { /* … */ },
})
```

The nine names are frozen in `src/contracts/tools.js` (`TOOL_NAMES`):
`cad_create_model`, `cad_modify_model`, `cad_inspect_model`,
`cad_validate_model`, `cad_export_model`, `cad_render_preview`,
`cad_list_models`, `cad_get_job_status`, `cad_runtime_status`. Every tool returns
`{ok:true,…}` / `{ok:false,error:{code,message,details}}` with codes from
`src/contracts/errors.js`, and carries **references** to artifacts, never bytes
(ADR-0005).

`exec` (ToolRunContext) supplies `exec.agent` (job ownership), `exec.signal`
(caller cancellation), `exec.callId` / `exec.rootCallId`. Tool-call cancellation
is *not* job lifetime: an already-published Harness job outlives the call and is
cancelled only through the job registry [notes §5].

---

## 4. Jobs

The Host registers a `cad` job controller once, inside `ctx.effect`, and starts
every background build with `ctx.jobs.start({kind:'cad', label, owner: exec.agent,
run})`. `attachController('cad')` **must** run before the first `start()`, or the
registry refuses the work ("no controller serves the owner") [notes §5].
`cad_get_job_status` maps to `ctx.jobs.get/list/kill`; a background create/modify
returns `{ok:true, job_id}`. Rationale and rejected alternatives: ADR-0004.

There is no timer, promise queue or detached worker in the plugin. Disposing the
controller and killing the runtime child are both effects, so plugin disable
releases them (scenario J).

**Recorded gotcha (0.2.1-rc.3): pass the session id, not the Agent object.**
`tests/e2e/RESULTS.md` §H records a real failure of background builds:
`JobStart.owner` must be the **session-id string** (`exec.agent.id`). Passing the
Agent object produced
`session "[object Object]" has no live agent (background job owner must be live)`
and left the model locked at an `unbuilt` revision; a failed background start also
did not release the per-model lock. The 0.1.1-rc.2 `.d.ts` copy in the profile
`node_modules` is wrong about this shape — the asar type is authoritative
(`docs/research/DSH_PLUGIN_API_NOTES.md` §8 gotcha 1). The host half now forwards
`ownerSessionOf(exec)` (the session id) in `src/host/tools.ts`; the scenario stays
`FAIL` in `docs/TEST_REPORT.md` until a re-run is recorded.

---

## 5. HTTP routes (asset serving for the viewer)

```js
ctx.inject(['webServer'], webCtx => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: '/dsh-plugin-cad/assets',
    handler: (req, res) => { /* full Node IncomingMessage/ServerResponse */ },
  }), 'dsh-plugin-cad: assets')
})
```

Two harness rules are load-bearing [notes §4]:

1. **Every request is admitted by the harness connection service first** —
   `ctx.get('connection')?.requestRejection?.(req)`. The plugin must not invent a
   second auth scheme.
2. The page is same-origin with the harness UI, so relative routes need no CORS.
   The client bundle itself is served by the harness web carrier under the plugin
   prefix (see §6), not by this route.

Route behaviour: resolve `modelId`/`revisionId`/filename against the store root,
reject escapes (`path_escape` → 403) and oversized files (`too_large` → 413),
serve only known artifact names/content types. Policy: `docs/SECURITY_MODEL.md`.

The plugin registers **two** prefixes (`src/host/api.ts`, constants `API_PREFIX` /
`ASSET_PREFIX`), both through the same admission wrapper:

| prefix (`src/host/service.ts`) | routes | consumer |
| --- | --- | --- |
| `/dsh-plugin-cad/api` | `GET /health`; `GET /models?limit&include_failed`; `GET /models/:id?revision&history_limit&include=summary\|document\|full`; `GET /models/:id/revisions?limit`; `GET /models/:id/revisions/:revisionId`; `GET /models/:id/artifacts?revision=` | the viewer client (`src/client/api.ts`) |
| `/dsh-plugin-cad/assets` | `GET\|HEAD /models/<modelId>/<revisionId>/<fileName>` (`model.step\|model.glb\|model.stl\|preview.svg`), `GET\|HEAD /models/<modelId>/previews/<revisionId>/preview.svg` | GLB/STEP/STL/SVG bytes, same-origin |

Route details verified in `STATUS_host.md`: JSON is `no-store`; artifacts carry
`ETag:"<sha256>"`, `cache-control: public, max-age=31536000, immutable`,
`If-None-Match` → 304 and `?download=1` → `content-disposition`; content types are
the closed set `model/gltf-binary`, `application/step`, `model/stl`,
`image/svg+xml`. **There are no mutating routes** — POST/PUT/DELETE/PATCH get
`405` + `Allow: GET, HEAD`; the viewer is read-only and revision refresh happens
by polling while an agent writes.

The API surface is internal to the plugin (it is how the browser half reads host
state); it is **not** a new public API and it is not an alternative to the agent
tools. The artifact URL in tool results and API payloads is exactly the
`/dsh-plugin-cad/assets/...` form above.

`[lead]` The web carrier requires the boot token on non-root routes: booting
prints `dsh web: http://127.0.0.1:<port>/?token=<token>` and a request without
the token cookie gets 401; `curl -c jar -b jar "http://127.0.0.1:<port>/?token=…"`
returns 303 and sets the cookie. This applies to the asset route as well and is
why the viewer's fetches are same-origin from an already-admitted page.

---

## 6. Client module

`package.json` declares the browser half:

```json
"dsh": {
  "plugin": true,
  "kind": "server",
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-locale",
               "@deepseek-ai/dsh-client-ui-layout",
               "@deepseek-ai/dsh-client-ui-sidebar"]
  }
}
```

The Node half of `@deepseek-ai/dsh-client-modules` scans enabled loader entries for
web `dsh.client` packages, resolves `exports["./client"]`, hashes the built bundle
into `window.__DSH_BOOT__` and serves it under `/plugins` [notes §6].
`[lead]` The bundle is addressable as `plugins/??<package>/client.js&rev=<hash>`
(relative, no leading slash) and appears in `window.__DSH_BOOT__`; that is how the
client half is proven loaded without a browser.

The bundle must be a **factory-registration** file, not an ESM module:

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-cad",
  factory(require) { /* esbuild IIFE, globalName __dshPluginCad */ return __dshPluginCad },
});
```

Build constraints (esbuild): `--bundle --format=iife --global-name=__dshPluginCad
--platform=browser --target=es2022 --jsx=automatic`, with
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` **external**
(resolved from the page's shared module table — bundling a second React breaks
hooks and inflates the boot payload).

The client plugin module exports `inject = ['locale','slots']` and `apply(ctx)`.
Verified slot names on this version [notes §6]: **`main`** (full-size main panel
page) and **`sidebar.panellist`** (sidebar icon list). Every registration is an
effect; disabling removes the page and the icon. The client calls the plugin's own
HTTP prefix — it must not import harness internals or patch built-in components.

---

## 7. Install / enable / disable / uninstall

### 7.1 Create a dedicated profile (never the user's `desktop`/`web`)

```sh
# web-capable profile for the viewer demo
dsh --profile cadtest --from-default-profile web --dump-config

# headless profile for one-shot agent runs
dsh --profile cadheadless --from-default-profile headless
```

`[lead]` Both forms are verified. `--from-default-profile` copies the shipped
template (`web` / `headless` / `tui` / `sdk` / `acp` are the shipped templates per
upstream `docs/architecture.md`); `--dump-config` then prints the composed tree
(our `[docs-eng]` run above). **The user's personal `desktop` and `web` profiles
are never modified by this plugin, its tests or these instructions** — all work
happens in `cadtest` / `cadheadless`.

### 7.2 Install the plugin

```sh
dsh plugin --profile cadtest add /Volumes/ZHITAI/texttocad/dsh-plugin-cad
```

`[lead]` Verified twice on this machine: this single command runs `pnpm add`
**inside the profile** and also adds the package to the profile's
`dsh.profile.bundles`, so the bundle patch (and therefore our `insert` row) takes
effect without hand-editing `package.json`. This is the documented install flow.

Verify composition:

```sh
dsh --profile cadtest --dump-config | grep -A3 dsh-plugin-cad
```

A row `- id: dsh-plugin-cad` with the config from §2 must be printed. If the row
is missing, the package is installed but not composed — check
`dsh.profile.bundles` in `~/.dsh/profiles/<name>/package.json`.

### 7.3 Boot the web app (managed background job)

```sh
dsh --profile cadtest --no-open --port 64899
# prints: dsh web: http://127.0.0.1:64899/?token=<token>
```

`[lead]` Verified, including the token behaviour described in §5. Booting must be
a managed background job, not a foreground command; always use an explicit
`--port` so the URL is knowable.

### 7.4 Enable / disable

- **Enable/disable in the running app**: the in-app plugin manager
  (`@deepseek-ai/dsh-plugin-manager` + `dsh-client-ui-settings-plugins`) tracks
  third-party bundle enable state under `~/.dsh/profiles/<name>/.plugin-manager/`
  [notes §7; `[docs-eng]` observed the directory in `cadtest`].
- **Disable by patch** (reproducible, what tests should use):

  ```yaml
  - id: dsh-plugin-cad
    disabled: true
  ```

  in the profile's `cordis.patch.yml`, then restart the profile. Disabling runs
  the effect disposers: tools unregister, the asset route disappears, the job
  controller detaches, the Python child is killed. **User model data is not
  deleted** (ADR-0005).
- Re-enabling is removing that patch entry (or flipping the manager toggle) and
  restarting.

### 7.5 Uninstall

```sh
dsh plugin --profile cadtest remove dsh-plugin-cad
```

`[lead]` Verified: `remove` deletes the package dependency **and** the
`dsh.profile.bundles` entry, so the loader no longer composes the row (also
recorded for the probe bundle in `tests/e2e/RESULTS.md` §M0-K). Confirm manually
anyway, because a stale bundle entry with no package is a boot error:

```sh
grep -n dsh-plugin-cad ~/.dsh/profiles/cadtest/package.json
dsh --profile cadtest --dump-config | grep dsh-plugin-cad || echo "row absent (expected)"
```

**Expected resource behaviour after uninstall** (design + mechanism, *not yet a
recorded real-plugin run* — scenario K is `NOT RUN` in
`tests/e2e/RESULTS.md`): the Python child was owned by the plugin and killed by
its disposer, so no child process should remain; user data under `~/.dsh/cad` is
deliberately left intact so a reinstall can still read the models. Deleting CAD
data is a separate, explicit user action documented in `README.md`. Do not quote
the process/data half of K as verified until a run records `pgrep`/store output.

---

## 8. What each lifecycle step does, in one table

| step | command | effect on the harness | effect on this plugin |
| --- | --- | --- | --- |
| install | `dsh plugin --profile P add <path>` | pnpm add into profile + append to `dsh.profile.bundles` | package present; nothing running |
| compose | boot / `--dump-config` | applies bundle patches, then user patch, then `--patch` | row `dsh-plugin-cad` inserted with config §2 |
| enable | (default) or remove `disabled` patch | loader mounts the plugin | `apply()` runs; tools/jobs/route/effects registered; runtime **not** started yet |
| use | agent tool call | pipeline approval/timeout/cancel | lazy runtime start, build, revision persisted |
| disable | in-app toggle or `disabled: true` + restart | loader unmounts | disposers: tools, route, controller, child killed; data kept |
| uninstall | `dsh plugin --profile P remove dsh-plugin-cad` | pnpm remove + bundle entry removed | package gone; data kept unless the user deletes it |

---

## 9. Gotchas verified on this host

From `docs/research/DSH_PLUGIN_API_NOTES.md` §8, all of which cost the team time:

1. The `dsh` package copy under `~/.dsh/profiles/node_modules` is **stale**
   (0.1.1-rc.2). Read types from the asar runtime, not there.
2. `app.asar` is not a directory. Read it with Electron-as-Node:
   `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e "…"`.
3. Homebrew Pythons are broken for uv here (empty `platform.mac_ver()`); use the
   uv-managed CPython 3.12. First `import build123d` ≈ 80 s, warm ≈ 1.6 s → the
   runtime must be long-lived (ADR-0002).
4. Do not modify the user's `desktop`/`web` profiles; work in `cadtest` /
   `cadheadless`.
5. The system `python3` on PATH is **3.9.6** and has no build123d
   [`[docs-eng]` `python3 --version`]. Anything that resolves "python3" silently
   picks the wrong interpreter; the runtime must use the configured/uv path.

---

## 10. Upstream documentation consulted

Accessed 2026-10-30. `github.com` HTML pages and web search were **unreachable
from this sandbox** (hostnames resolve to non-public addresses), so upstream
material was fetched from `raw.githubusercontent.com` and the published docs site.

| source | URL | used for |
| --- | --- | --- |
| repo README | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md | project identity, MIT licence, docs-site pointer |
| architecture doc | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md | profiles/bundles/layers, "everything is a plugin", application-launch rules |
| development guide | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/development.md | Node/pnpm floors, repo layout, build faces |
| `AGENTS.md` | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/AGENTS.md | repository layout, package groups (jobs, bundle, skill, …) |
| docs site | https://deepseek-harness.github.io/deepseek-harness/ | reachable (HTTP 200); landing page only — no plugin-authoring page could be located by direct URL, so it is **not** cited for API specifics |
| safety notice | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/SAFETY.md | developer-preview compatibility warnings |

The authoritative source for every API detail in this repository remains the
installed asar runtime's own type definitions, as recorded in
`docs/research/DSH_PLUGIN_API_NOTES.md`. The upstream docs describe intent; the
installed artifact defines behaviour.

**Upstream commit:** the installed artifact is a release build (`app.asar`);
there is no `.git` directory and no commit hash is embedded in a locally
readable form. This document therefore cites *release `0.2.1-rc.3`, asar
runtime* and does **not** invent a commit hash. See
`docs/COMPATIBILITY_MATRIX.md`.
