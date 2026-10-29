# dsh-plugin-cad

Native CAD modelling for **DeepSeek Harness** (`dsh`): an agent describes a
mechanical part, the plugin builds a **real B-rep** with build123d / OpenCASCADE,
stores it as an **immutable revision**, and shows it in the Harness Web UI — the
STEP, GLB, STL and SVG files are real engineering artifacts, not mockups.

P0 is a **single-part** parametric modeller with nine native tools. It is not an
assembly modeller, a drawing generator, a DFM rule engine or a CAM package — see
[Known limitations](#known-limitations).

| | |
| --- | --- |
| Harness | `0.2.1-rc.3` (pinned via `engines.dsh`) |
| Platform | macOS arm64 (tested); Linux/Windows untested |
| Geometry | build123d 0.13.0 → OCP / OpenCASCADE 8.0.1, trimesh 5.2.0 |
| Licence | MIT (this plugin); third-party terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

---

## What it does

- **Parametric documents.** A part is `{parameters, features}` in a closed
  declarative schema (`dsh.cad/document@1`) with eight ops: `box`, `cylinder`,
  `hole`, `hole_pattern`, `fillet`, `chamfer`, `cut`, `union`. No agent-authored
  code is ever executed (`docs/adr/ADR-0001-declarative-feature-dsl.md`).
- **Real geometry.** Each build produces a validated solid, a geometry report
  (volume, area, bbox, centroid, topology, per-check results) and artifact files
  with byte size + sha256.
- **Immutable revisions.** A parameter edit creates revision N+1; nothing
  overwrites history; concurrent writes are rejected with `revision_conflict`
  (`docs/adr/ADR-0003-immutable-revisions.md`).
- **In-Harness viewer.** The model appears in the main panel and the sidebar; a
  parameter change swaps in the new revision without a half-built frame.
- **Background builds.** Heavy builds run as native Harness jobs and can be
  cancelled with `cad_get_job_status`.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
Host integration: [docs/DSH_INTEGRATION.md](docs/DSH_INTEGRATION.md) ·
Security: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

---

## Prerequisites

1. **DeepSeek Harness `0.2.1-rc.3`** installed, with the `dsh` CLI on PATH
   (`~/.local/bin/dsh-wrapper`, symlinked as `dsh`). Verify:
   ```sh
   dsh --version       # → 0.2.1-rc.3
   ```
2. **Node.js ≥ 22.5** for building/installing the plugin. The harness ships its
   own Node (`24.21.0`); the local Node only runs the build.
3. **Python.** *Nothing to install manually if you use the bootstrap*: it installs
   a uv-managed **CPython 3.12** and the pinned wheels. Requirements: `uv` on PATH
   (or network access to install it) — see
   [Python runtime bootstrap](#python-runtime-bootstrap).
   **Do not point this plugin at the macOS system `python3` (3.9) or a Homebrew
   Python**; they do not work here (`docs/COMPATIBILITY_MATRIX.md` §3).

---

## Install

Use a **dedicated profile**. This plugin's tests and demos never modify the
user's personal `desktop`/`web` profiles.

```sh
# 1. create a throwaway profile from the shipped template
dsh --profile cadtest --from-default-profile web --dump-config          # viewer profile
dsh --profile cadheadless --from-default-profile headless --dump-config # agent profile

# 2. install this plugin (adds the package AND its bundle entry)
dsh plugin --profile cadtest add /Volumes/ZHITAI/texttocad/dsh-plugin-cad

# 3. confirm the plugin row is composed into the tree
dsh --profile cadtest --dump-config | grep -A3 dsh-plugin-cad
```

`dsh plugin add` forwards to pnpm inside the profile and adds the package to
`dsh.profile.bundles`, which is what makes the plugin's `cordis.patch.yml` take
effect. There is no manual profile editing step. (Verified on this machine; see
[acceptance status](#acceptance-status).)

### Install from a packed tarball (distribution path, verified)

For a packaged install instead of a checkout:

```sh
pnpm pack                                    # → dsh-plugin-cad-0.1.0.tgz (297,501 B, 33 files)
DSH_CAD_VENV=$HOME/.dsh/cad/venv node python/setup-runtime.mjs   # one-time venv + self-test
dsh plugin --profile cadpkg add dsh-plugin-cad-0.1.0.tgz
```

Recorded on this machine: the tarball contains no `python/.venv` and no
`__pycache__`; the setup step created `~/.dsh/cad/venv` with CPython 3.12.13 and
the pinned wheels and passed the self-test; installing the `.tgz` added it to the
profile's `dependencies` (`file:…/dsh-plugin-cad-0.1.0.tgz`) and
`dsh.profile.bundles`; a headless agent in that profile reported
`runtime_python: /Users/<user>/.dsh/cad/venv/bin/python3` and built a 40×30×5 plate
with a Ø8 hole (volume 5748.672588, all 8 checks pass).

The plugin row and its configuration are documented in
[docs/DSH_INTEGRATION.md](docs/DSH_INTEGRATION.md) §2. Defaults are safe; override
only if you need to (e.g. `dataDir`, `pythonExecutable`, `maxConcurrentBuilds`).

## Run

```sh
dsh --profile cadtest --no-open --port 64899
# prints: dsh web: http://127.0.0.1:64899/?token=<token>
```

Open that URL in a browser and exchange the token for the browser-session cookie
(the app does this on load). Plugin HTTP routes answer only with that cookie —
without it they return `401`, which is the harness admission fence, not a plugin
bug. In the app, open the **CAD** panel from the sidebar.

For agent-only (headless) runs use the `cadheadless` profile:

```sh
dsh --profile cadheadless "Create a rectangular mounting bracket …"
```

---

## Python runtime bootstrap

The runtime is a **one-time, user-visible install** (never triggered silently at
build time). Two equivalent entry points:

```sh
# from the installed plugin / repo directory
npm run setup:python
```

or, from an agent conversation:

```
cad_runtime_status {"action":"repair"}
```

Both run the same non-interactive installer (`python/setup-runtime.mjs`), which
has a check mode and explicit flags:

```sh
node python/setup-runtime.mjs --check     # verify pins vs installed, print JSON, change nothing
node python/setup-runtime.mjs             # create/repair python/.venv, install, self-test
node python/setup-runtime.mjs --no-dev    # skip pytest (runtime-only install)
node python/setup-runtime.mjs --venv /path/to/venv   # choose the venv location
```

It creates/repairs the venv (default `python/.venv`, override `$DSH_CAD_VENV` or
`--venv`) with **uv-managed CPython 3.12**, installs `python/requirements.txt`
(`build123d==0.13.0`, `trimesh==5.2.0`, `numpy==2.5.4` + the exact transitive
freeze in `python/requirements.lock.txt`, plus pytest from
`python/requirements-dev.txt` unless `--no-dev`), then runs the runtime self-test.
It prints one JSON object on stdout (human output on stderr), fails non-zero with
a `recovery` hint, needs no sudo, sends no telemetry, and touches the network only
to reach the package index. The self-test reports the real versions it imported,
the acceptance-bracket volume/bbox/topology, and the four artifact sizes.

The plugin then resolves the interpreter in this order
(`src/host/config.ts`): `pythonExecutable` config → `$DSH_CAD_PYTHON` →
`<DSH_HOME>/cad/venv/bin/python3` → `<plugin>/python/.venv/bin/python3` → a PATH
`python3` that can `import build123d`. The last step is a real probe, so the
system Python 3.9 is skipped rather than silently used. Install into one of the
first two locations, or set `pythonExecutable` explicitly.

The venv is **not** part of the plugin package (it is machine-specific). When the
plugin was installed from a tarball rather than from this checkout, run the
installer that ships inside the installed package:

```sh
node ~/.dsh/profiles/<profile>/node_modules/dsh-plugin-cad/python/setup-runtime.mjs
```

or point `$DSH_CAD_PYTHON` / `config.pythonExecutable` at an existing interpreter
that has build123d.

`cad_runtime_status {action:"repair"}` is additionally gated by the
`allowRuntimeInstall` config flag, which defaults to **false**: with the shipped
patch the tool reports status but the installer is run by you, not by the agent.

**Expect the first import to be slow.** A cold `import build123d` costs ≈ 80 s
(bytecode compilation); a warm import ≈ 1.6 s. That is why the runtime is a
long-lived process with a 240 s start allowance, and why the first build after a
fresh install can take a minute. Do not kill it and conclude it is broken.

### Recovery path

| symptom | cause | fix |
| --- | --- | --- |
| `runtime_unavailable` / `runtime_crashed` (HTTP 503) | runtime not installed, or the child died | `cad_runtime_status` (status), then `{"action":"repair"}`; re-run `npm run setup:python` if the venv is missing |
| first build takes ~1–2 min | cold import | wait; subsequent builds reuse the warm process |
| `ModuleNotFoundError: build123d` in logs | wrong interpreter (system 3.9 / Homebrew) | set `pythonExecutable` in the plugin config to the uv CPython 3.12 path, or re-run the bootstrap |
| build `timeout` (504) | part exceeds `buildTimeoutMs` (180 s) | simplify the part, raise `buildTimeoutMs`, or build in the background |
| no CAD panel in the UI | plugin disabled / client bundle not loaded | re-check `--dump-config`, restart the profile, confirm the plugin is enabled |

---

## Demo (acceptance part)

Paste this into a Harness agent conversation (agent runs use the `cadheadless`
profile; the viewer uses `cadtest` on port 64899):

> **Create a rectangular mounting bracket 80 mm × 60 mm × 8 mm with a Ø20 mm
> central through-hole and four Ø6 mm corner holes inset 12 mm from the edges.
> Keep the dimensions parametric as length, width, thickness,
> center_hole_diameter, corner_hole_diameter and corner_inset, build it with the
> native CAD tools, export STEP and GLB, and report the model id, revision id,
> volume and bounding box.**

Expected: a model appears in the viewer; the report shows one solid, valid B-rep,
bbox 80 × 60 × 8 mm, volume 34981.947193 mm³ — the value the runtime actually
measured for exactly this part in
[tests/e2e/RESULTS.md](tests/e2e/RESULTS.md) §M1-D
(80·60·8 − π·10²·8 − 4·π·3²·8). A parameter edit (e.g. `length: 100`) creates
revision `r-0002` and the viewer updates in place without showing a partial
model. The exported STEP is the acceptance artifact — its ISO-10303-21 structure,
solid body and hole radii are independently verified in §M1-E.

The recorded result of the acceptance run is **not claimed here** — see
[acceptance status](#acceptance-status).

---

## Update

```sh
dsh plugin --profile cadtest add /path/to/dsh-plugin-cad   # re-install new version
dsh --profile cadtest --dump-config | grep -A3 dsh-plugin-cad
```

A new release may change the runtime protocol version or the document schema;
both are negotiated/versioned and fail loudly rather than silently
(`docs/COMPATIBILITY_MATRIX.md` §5). Re-running the acceptance demo after an
update is the recommended smoke test.

## Disable / re-enable

In-app: Settings → Plugins → `dsh-plugin-cad` → toggle.
Reproducibly, via the profile patch layer:

```yaml
# ~/.dsh/profiles/cadtest/cordis.patch.yml
- id: dsh-plugin-cad
  disabled: true
```

then restart the profile. Disabling unregisters the tools, removes the asset
route and viewer panel, stops accepting builds and kills the Python child.
**Your models are not deleted.**

## Uninstall

```sh
dsh plugin --profile cadtest remove dsh-plugin-cad
grep -n dsh-plugin-cad ~/.dsh/profiles/cadtest/package.json   # expect nothing
```

`remove` deletes the dependency **and** the `dsh.profile.bundles` entry, so the
loader no longer composes the row. No child process is left behind (it was an
effect of the plugin). **Your CAD data stays** in `~/.dsh/cad` (or `dataDir`).

### Deleting your CAD data

This is a separate, explicit action — the plugin never does it:

```sh
rm -rf ~/.dsh/cad          # default store: all models, revisions and artifacts
```

If you set `dataDir`, delete that directory instead. Check the size first
(`du -sh ~/.dsh/cad`); every revision keeps its own STEP/GLB.

---

## Fixed versions

| component | version |
| --- | --- |
| verified tree | git commit `7b5d88f` (113 files, 28,709 insertions) |
| DeepSeek Harness (`dsh`) | `0.2.1-rc.3` |
| `@deepseek-ai/cordis` | `4.0.5` |
| bundled Node / pnpm in Harness | `24.21.0` / `11.28.5` |
| Node required by this plugin | `>= 22.5` |
| Python | CPython `3.12.13` (uv-managed) |
| build123d | `0.13.0` |
| cadquery-ocp-novtk (OCP / OCCT) | `8.0.1.1.0` (OCCT `8.0.1`) |
| trimesh | `5.2.0` |
| numpy | `2.5.4` |
| three.js (viewer) | `0.186.1` |

Exact commands used to verify each number, and what is **not** verified:
[docs/COMPATIBILITY_MATRIX.md](docs/COMPATIBILITY_MATRIX.md).

---

## Acceptance status

The project brief defines twelve acceptance scenarios (A–L). The authoritative,
evidence-backed table is
[tests/e2e/RESULTS.md](tests/e2e/RESULTS.md); the aggregated reading with the
exact missing evidence per scenario is
[docs/TEST_REPORT.md](docs/TEST_REPORT.md). **A scenario is only PASS when a
recorded run supports it** — this README never upgrades a result.

As of `docs/TEST_REPORT.md` (profiles `cadlife` / `cadtest` / `cadheadless` /
`cadpkg`; snapshot 2026-10-30):

| # | Scenario | Status |
| --- | --- | --- |
| A | Plugin installs and enables | **PASS** |
| B | Agent discovers native CAD tools | **PASS** |
| C | Agent creates the bracket with correct dimensions | **PASS** (volume 34,981.947 mm³, bbox 80×60×8) |
| D | Runtime returns valid real geometry | **PASS** (8/8 checks, 1 solid, 11 faces) |
| E | STEP verified by an independent parser | **PASS†** — independent ISO-10303-21 verifier + OCCT re-import; **no commercial CAD application installed**, so "opens in a commercial CAD system" is not verified |
| F | Viewer displays the model | **PASS** (real Harness UI: panel, WebGL canvas renders the build123d GLB, orbit/raycast; `client-e2e-report.json` `ok:true`) |
| G | Parameter change → new revision in viewer | **PASS** (clean run: r-0005 → r-0006 published by an agent while the panel stayed open, followed by polling with no reload) |
| H | Cancel mid-build leaves runtime controlled | **PASS** (4th run: queued background job reached terminal `killed`, cancelled revision persisted `failed`/`cancelled` with 0 artifacts, runtime healthy) |
| I | Model reference survives restart | **PASS** |
| J | Disable → tools gone, resources released | **PASS** (route 404 after disable) |
| K | Uninstall → no child process, data kept | **PASS** (`strayProcesses=0`, `dataPreserved=true`) |
| L | No path traversal outside the workspace | **PASS** (7 probes, no leak) |

Summary: **12 PASS, 0 FAIL, 0 PARTIAL** at verified tree **git commit `7b5d88f`**
(113 files, 28,709 insertions). † E is verified with an independent parser + OCCT
re-import, not a commercial CAD application (none installed on this machine). H
passed only on the fourth recorded attempt after three real host contract defects
were found and fixed — the full history is in `docs/TEST_REPORT.md` §3.

The final lifecycle regression ran on a **brand-new profile** (`cadfinal`):
**7/7 PASS** — install, compose, boot, security (7 traversal probes), restart
(6 model ids identical before/after), disable (route 404), uninstall (0 stray
`cad_runtime` processes, data intact). Recorded in
[tests/e2e/RESULTS.md](tests/e2e/RESULTS.md) "Final regression run".

Earlier mechanism proofs (with a throwaway probe package) are recorded in
`tests/e2e/RESULTS.md` §M0…§M0-K; they prove the harness mechanics, not this
plugin.

---

## Known limitations

P0 is deliberately narrow (`docs/research/SPEC_P0.md` §8):

- **Single parts only.** No assemblies, mates, exploded views or interference
  checks. Multi-part requests are decomposed into separate part models
  (`skills/assembly-design/SKILL.md` explains this honestly).
- **No engineering drawings.** `cad_render_preview` produces SVG projections for
  humans; there are no dimensions, sections, GD&T or title blocks.
- **No DFM rule packs, sheet metal, generative/topology optimisation or CAM.**
  `skills/mechanical-design-review/SKILL.md` gives engineering heuristics, not a
  manufacturability sign-off.
- **No import.** STEP/IGES files are not imported into a model, and there are no
  freeform features (sweep/loft/revolve/text) in P0.
- **One build at a time.** `maxConcurrentBuilds` defaults to 1 because one
  stateful Python process serves all builds; background jobs keep the agent
  responsive but do not add throughput.
- **Cold start.** First build after install can take ~1–2 min (Python import).
- **Single writer.** Optimistic concurrency only; no multi-user editing.
- **Platform.** Tested on macOS 26.2 arm64 with the uv-managed **CPython 3.12**
  only. Windows/Linux, Intel Mac and other Python versions are untested (the
  runtime's reader loop is POSIX-only).
- **STEP verification is structural.** The exported STEP is checked by an
  independent pure-JavaScript ISO-10303-21 structural verifier
  (`tests/e2e/verify-artifacts.mjs`) and re-imported by the OCCT STEP reader in a
  separate process. **No third-party CAD application (FreeCAD/SolidWorks/… ) is
  installed on this machine, so "opens in a commercial CAD system" is not
  verified** — do not claim it.
- **Host APIs are pre-stable.** Upgrading the Harness beyond `0.2.1-rc.3` is a
  compatibility event, not a routine bump.
- **Known limitation: `feature_effects` counts cylindrical faces by radius.**
  If a fillet radius equals a hole radius, the fillet consumes/merges the
  hole-rim faces and the check can mis-fire. Recorded evidence: Ø8 bolt-circle
  holes (r=4) + `fillet radius 4 all_edges` → `feature_effects` fails with
  "7 cylindrical face(s) r=4 mm appeared (expected 24)" → `invalid_geometry`.
  With a distinct radius (Ø4 holes + fillet 4) the same part builds and all 8
  checks pass. This is a **conservative heuristic limitation, not a kernel or
  geometry error** — the B-rep is valid. **Recommendation: keep the fillet radius
  different from any hole radius** (the skills say the same).
- **Windows/Linux unsupported.** The runtime's stdio reader uses POSIX `select()`;
  macOS/Linux is the target, Windows is untested.

---

## Documentation map

| document | contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, lifecycle, data model, revisions, decisions, non-goals |
| [docs/DSH_INTEGRATION.md](docs/DSH_INTEGRATION.md) | profile/bundle mechanism, plugin row, tools/jobs/routes/slots, install/disable/uninstall |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | trust boundaries, roots, traversal defence, limits, telemetry/network posture, retention |
| [docs/COMPATIBILITY_MATRIX.md](docs/COMPATIBILITY_MATRIX.md) | pinned versions, verification commands, untested matrix |
| [docs/CLEAN_ROOM_PROVENANCE.md](docs/CLEAN_ROOM_PROVENANCE.md) | what was and was not consulted; exact scope of the clean-room claim |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | M0–M5 status, P0/P1/P2 candidates, unverified reference behaviour |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | scenario A–L results, strictly from recorded evidence |
| [docs/adr/](docs/adr/) | ADR-0001 … ADR-0006 |
| [docs/research/SPEC_P0.md](docs/research/SPEC_P0.md) | the P0 product specification |
| [docs/research/DSH_PLUGIN_API_NOTES.md](docs/research/DSH_PLUGIN_API_NOTES.md) | verified host-platform recon |
| [skills/](skills/) | agent guidance for the four CAD workflows |

---

## Development

```sh
npm install            # or pnpm install
npm run build          # esbuild: lib/index.js + lib/client.js
npm run typecheck      # tsc --noEmit
npm run test:unit      # node --test tests/unit/*.test.mjs
npm run test:integration
npm run verify         # build + unit + integration
```

The build is esbuild for the client half (`lib/client.js`, IIFE with React
external) and the host half (`lib/index.js`, ESM, Node builtins only); `tsc` is
type-checking only. Recorded test runs: host **88/88** unit+integration tests
(`docs/research/STATUS_host.md`, including a real build123d integration test) and
Python **119** cases (`docs/research/STATUS_runtime.md` §2).

Python tests live in `tests/python/` and need the runtime venv; the npm script now
uses the venv interpreter directly:

```sh
npm run test:python        # python/.venv/bin/python -m pytest tests/python -q
```

---

## Licence and provenance

- This plugin: **MIT** — see [LICENSE](LICENSE).
- Third-party components, versions, licences and the OCCT LGPL-2.1-with-exception
  note: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The upstream text-to-CAD reference project was **not cloned, fetched, read or
  executed**; this is a functionality-level clean-room replacement, not a verified
  clean-room reimplementation of its internals. Details and audit notes:
  [docs/CLEAN_ROOM_PROVENANCE.md](docs/CLEAN_ROOM_PROVENANCE.md).
