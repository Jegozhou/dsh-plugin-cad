# DSH 0.2.1-rc.3 — verified native-plugin API notes

Reconnaissance performed against the **running installed host**, not against
documentation guesses. Every claim below was checked in at least one of:

* the packaged runtime inside the installed app
  (`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/*`),
* the type definitions shipped with those packages (`lib/types/**/*.d.ts`),
* two **real, working third-party native plugins already installed on this
  machine** and used as behavioural references: `dsh-excalidraw`
  (`<dsh-excalidraw-checkout>`, TS source) and `dsh-plugin-bidkit`
  (`<dsh-plugin-bidkit-checkout>`, JS source). These are host-ecosystem
  examples; they are **not** the isolated reference project and reading them is
  part of researching the host.

Pinned host:

| item | value |
| --- | --- |
| DSH app / CLI | **0.2.1-rc.3** |
| CLI launcher | `~/.local/bin/dsh-wrapper` → `Contents/Resources/runtime/cli/bin/dsh` |
| CLI entry (inside asar) | `app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/cli.js` |
| `@deepseek-ai/cordis` | **4.0.5** |
| bundled Node | `24.21.0` (`runtime/versions.json`), host requires `node >=22.5` |
| pnpm | `11.28.5` (bundled) |
| profile root | `~/.dsh` (`DSH_HOME`), profiles in `~/.dsh/profiles/<name>` |
| `dsh` package shipped in profiles node_modules | 0.1.1-rc.2 (stale copy; **the asar runtime is authoritative**) |

The reference plugins' `package.json` declare `engines.node >=22.5` only; they do
**not** pin the DSH version. We pin ours explicitly (`engines.dsh`) and document
compatibility in `docs/COMPATIBILITY_MATRIX.md`.

## 1. Bundle / profile composition

A profile directory is a pnpm workspace:

```
~/.dsh/profiles/<name>/
  package.json          # name dsh-profile-<name>, dependencies, dsh.profile.bundles[]
  cordis.yml            # always `[]` — the tree is composed from patches
  cordis.patch.yml      # the user's patch layer, applied last
  pnpm-workspace.yaml   # packages: [.], nodeLinker: hoisted, autoInstallPeers: false
  node_modules/
```

`package.json.dsh.profile.bundles` is an ordered list of bundle package names.
Each bundle contributes `cordis.patch.yml`. Composition order: every bundle
patch in order → `cordis.patch.yml` → `--patch` overlays. `dsh --profile X
--dump-config` prints the composed tree (authoritative check that a plugin row
is present); `--dump-config-schema` prints the entry/patch JSON Schema.

Patch entry syntax (`patch` = top-level YAML **array**):

```yaml
- insert:                       # append rows (new plugin)
    - id: dsh-plugin-cad        # row id, the address used by later overrides
      name: 'dsh-plugin-cad'    # npm package name to load
      config: {...}             # passed to the plugin's apply(ctx, config)
- id: some-existing-row         # override an existing row
  config: {...}                 # REPLACED wholesale, never deep-merged
- id: some-existing-row
  disabled: true
```

`!!js` expressions are allowed inside patches (`disabled: !!js '!ctx.get(...)'`).

A plugin package is loaded as a **Cordis plugin module**: the loader imports the
package entry (its `main` / `exports["."]`) and calls `apply(ctx, config)`.

## 2. Host plugin entry contract

```js
export const name = 'dsh-plugin-cad'      // diagnostics
export const inject = ['tools']           // hard service dependencies (Cordis DI)
export function apply(ctx, config = {}) { /* register everything as effects */ }
```

Verified `ctx` members used by real plugins:

| member | shape | semantics |
| --- | --- | --- |
| `ctx.effect(fn, label?)` | `fn` returns an optional disposer | **the** lifecycle primitive; disposer runs on disable/unload |
| `ctx.logger.info/warn/error` | `(msg) => void` | host logging |
| `ctx.provide(name, value)` | returns disposer | register a Cordis service for other Host plugins |
| `ctx.get(name)` | service or `undefined` | read another service (`'connection'`, `'jobs'`, `'webServer'`) |
| `ctx.inject(names, callback)` | dependency-gated sub-scope | use for optional/late services such as `webServer` |
| `ctx.tools.register(definition)` | returns disposer | agent tool registration |
| `ctx.jobs` | `JobRegistry` service | background jobs (see §5) |
| `ctx.slots` / `ctx.locale` | client-only | see §6 |

Rules that real plugins follow and we must follow:

* nothing is registered outside `apply()`, and everything registered is an
  `effect` with a disposer — disabling the plugin must leave no tool, route,
  timer, listener or child process behind;
* `ctx.provide` disposal is itself wrapped in `ctx.effect`;
* optional capabilities are acquired with `ctx.inject([...], cb)`, never by
  assuming the service exists.

## 3. Native tools (`ctx.tools`)

From `@deepseek-ai/dsh-tools` type definitions:

```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode        // object-rooted JSON Schema
  output: {
    schema: JsonSchemaNode          // MANDATORY canonical output schema
    render(args, value): ContentBlock[]   // model-facing projection; [{type:'text',text}]
  }
  presentCall?(args): unknown       // optional UI card
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}
```

`exec` (ToolRunContext) exposes:

* `exec.agent` — the `Agent` on whose behalf the call runs (use for job owner /
  session ownership; may be `undefined` for non-agent callers);
* `exec.signal` — `AbortSignal` for **caller cancellation**. Tools must observe
  it and settle only after their owned work reaches quiescence;
* `exec.callId`, `exec.rootCallId` — call identity.

The pipeline (`tools/pre-execute` → `tools/execute` → `tools/post-execute`) is
owned by the host: **permissions, approvals, timeouts and cancellation are
applied by the harness**, not by the plugin. A plugin tool must therefore not
implement its own approval flow; it just runs and honours `exec.signal`.

Return values must be lossless JSON (the canonical value declared by
`output.schema`). Real plugins return `{ok:true, ...}` / `{ok:false,error:{code,message,details}}`
so the model sees a stable error code instead of a transport exception. We adopt
that envelope. **Never** put binary data or whole model files in a tool result —
return artifact references (`artifactId`, `path`, byte size, sha256) instead.

Working registration shape (from excalidraw, proven on this version):

```js
const dispose = ctx.tools.register({
  name: 'cad_create_model',
  description: '...',
  parameters: TOOL_SCHEMAS.create,
  output: { schema: {}, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
  presentCall: args => ({ card: 'generic', title: 'Create CAD model', kind: 'other', rawInput: args }),
  async execute(args, exec) { ... },
})
```

## 4. Host HTTP routes (needed by the Viewer)

```js
ctx.inject(['webServer'], webCtx => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'prefix',
    path: '/dsh-plugin-cad/assets',
    handler: (req, res) => { ... },      // full Node IncomingMessage/ServerResponse
  }), 'dsh-plugin-cad: assets')
})
```

`register` returns a disposer; wrap it in `effect`. Every request must first be
admitted by the harness connection service — do **not** invent a second auth
scheme:

```js
const connection = ctx.get('connection')
const rejection = connection?.requestRejection?.(req)   // number | undefined
```

Origin: the browser page is same-origin with the harness UI, so the plugin's
relative routes work without CORS. The web carrier serves the plugin client
bundle under `/plugins` automatically (see §6).

## 5. Background jobs (`ctx.jobs`, `@deepseek-ai/dsh-jobs`)

`ctx.jobs` is the process-local `JobRegistry` service. Contract:

* `attachController(name) => disposer` — **must** be called (effect-scoped)
  before `start()`, otherwise `start` refuses the work ("no controller serves
  the owner"). The controller makes the job cancellable/readable by the host.
* `start({ kind, label, owner?, outputLimitBytes?, run() }) => JobId`
  — `run()` is called once, synchronously, and returns hooks:
  `{ cancel(reason?), done: Promise<JobOutcome>, readOutput?() }`.
  `kind` is the id prefix (`cad-1`, `cad-2`, …). `owner` is the calling
  `Agent` (from `exec.agent`) — access is fenced by its session id and agent
  disposal cancels + awaits the job.
* `get(id, caller?)`, `list(caller?)`, `read(id, caller?)`,
  `kill(id, caller?, reason?)`, `wait(id, timeoutMs, caller?, signal?)`,
  `onJobDone(listener)`, `onJobsChanged(listener)`.

`kill()` calls the producer's `cancel()` and only then marks the job `stopping`;
settlement is first-wins. The producer's `done` promise settles the record.
Distinguish **tool-call cancellation** (`exec.signal`, may abort the call that
started the job) from **job lifetime** (an already-published job outlives the
tool call and is cancelled only via `kill`/owner disposal/plugin disposal).

We register a `cad` controller in `apply()` and every background build goes
through `ctx.jobs.start`. No second task system.

## 6. Web client plugin (`dsh.client`)

`package.json`:

```json
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
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

The Node half of `@deepseek-ai/dsh-client-modules` scans enabled loader entries
for web `dsh.client` packages, resolves `exports["./client"]`, hashes the built
bundle into `window.__DSH_BOOT__`, and serves it under `/plugins`. The bundle
must be a **factory-registration** file, not an ESM module:

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-cad",
  factory(require) { /* esbuild IIFE output with globalName __dshPluginCad */ return __dshPluginCad },
});
```

Built with esbuild: `--bundle --format=iife --global-name=__dshPluginCad
--platform=browser --target=es2022 --jsx=automatic --external:react
--external:react/jsx-runtime --external:react-dom --external:react-dom/client`
(`react` resolves from the page's shared module table — never bundle a second
copy). CSS is imported with `--loader:.css=text` and injected by the plugin.

Client plugin module exports `apply(ctx)` and `inject`:

```js
export const inject = ['locale', 'slots']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('dsh-plugin-cad', { en, zh }), '...')
  const t = ctx.locale.bind('dsh-plugin-cad')
  ctx.effect(() => { const s = document.createElement('style'); /* ... */ return () => s.remove() }, '...')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'dsh-plugin-cad', locale: 'dsh-plugin-cad',
    inject: () => ({ t }),
  }, CadViewerPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'dsh-plugin-cad', order: 40,
    locale: 'dsh-plugin-cad', label: () => t('panel'),
  }, CadIcon))
}
```

Verified slot names: `main` (full-size main panel page) and `sidebar.panellist`
(sidebar icon list). Everything added is an effect so disabling removes it.
The client half must call the host through the plugin's own HTTP prefix; it must
not import harness internals or patch built-in components.

## 7. Install / enable / disable / uninstall (verified commands)

```sh
# create a throwaway profile from a shipped template (web | headless | tui)
dsh --profile cadtest --from-default-profile web --dump-config

# install a plugin package into a profile (pnpm add + restart of the app)
dsh plugin --profile cadtest add /path/to/dsh-plugin-cad

# verify composition contains the row
dsh --profile cadtest --dump-config | grep -A3 dsh-plugin-cad

# boot a web profile on an explicit port (managed background job)
dsh --profile cadtest --no-open --port 64899

# one-shot headless agent run (requires an LLM provider in the profile)
dsh --profile cadheadless headless "create a bracket ..."
```

`dsh plugin --profile <p> <pnpm args>` forwards to pnpm inside the profile dir
(`add`, `remove`, `install`, ...). Installing a package does **not** edit the
composed tree: the row must exist in a bundle patch or the user patch layer
(our `cordis.patch.yml` is the bundle patch, so installing + having the bundle
listed is what takes effect; for a single plugin profile the row can also be
inserted directly in the profile's `cordis.patch.yml`).

The in-app plugin manager (`@deepseek-ai/dsh-plugin-manager`,
`dsh-client-ui-settings-plugins`) tracks enable/disable state; a third-party
bundle appears there once installed and listed in `dsh.profile.bundles`.

## 8. Gotchas learned the hard way

* The `dsh` package copy under `~/.dsh/profiles/node_modules` is **stale**
  (0.1.1-rc.2); read types from the asar runtime, not from there.
* `app.asar` is not a directory. Read it with Electron-as-Node:
  `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e "..."`.
* Homebrew Pythons on this machine are broken for uv (empty
  `platform.mac_ver()`); use the uv-managed CPython 3.12
  (`uv python install 3.12`). First `import build123d` costs ~80 s (bytecode
  compile); warm import is ~1.6 s. The runtime process must therefore be
  **long-lived**, never spawned per build.
* Do not modify the user's `desktop`/`web` profiles. Work in a dedicated
  profile (`cadtest`, `cadheadless`) created with `--from-default-profile`.
