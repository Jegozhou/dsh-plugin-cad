# Compatibility matrix

Pinned and verified on **2026-10-30** on the development machine described below.
Every "installed" value is a fact read from the running environment with the
command shown in §3; nothing here is a version chosen from memory.

---

## 1. Host platform

| component | version | how verified | status on this machine |
| --- | --- | --- | --- |
| DeepSeek Harness app / CLI | **0.2.1-rc.3** | `dsh --version` → `0.2.1-rc.3`; `Info.plist` `CFBundleShortVersionString` = `0.2.1-rc.3`; asar `dsh/package.json` version = `0.2.1-rc.3` | verified |
| DSH upstream git commit | **not resolvable** | installed artifact is a release build (`app.asar`); no `.git` directory and no commit id embedded in a locally readable form | **honest gap** — see §4 |
| `@deepseek-ai/cordis` | **4.0.5** | `package.json.version` read from inside the asar runtime | verified |
| bundled Node | **24.21.0** | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/versions.json` | verified |
| bundled pnpm | **11.28.5** | same `versions.json`; also in `dsh plugin` output (`Done in 322ms using pnpm v11.28.5`, `tests/e2e/RESULTS.md` §M0) | verified |
| host Node engine requirement | **>= 22.5** | `package.json` `engines.node`; upstream `docs/architecture.md`/`AGENTS.md` state the floor | verified (declared) |
| CLI launcher | `~/.local/bin/dsh-wrapper` → `Contents/Resources/runtime/cli/bin/dsh` | `docs/research/DSH_PLUGIN_API_NOTES.md` §"Pinned host"; `ls -l ~/.local/bin/dsh*` | verified |
| profile root | `~/.dsh` (`DSH_HOME`), profiles in `~/.dsh/profiles/<name>` | profile inspection and `dsh --dump-config` | verified |
| in-app plugin manager state | `~/.dsh/profiles/<name>/.plugin-manager/` | directory present in `cadtest` | observed |
| stale copy under profile `node_modules` | `dsh 0.1.1-rc.2` | `docs/research/DSH_PLUGIN_API_NOTES.md` §8 — **do not read types from there** | known gotcha |

The plugin pins the host in `package.json`:

```json
"engines": { "node": ">=22.5", "dsh": "0.2.1-rc.3" }
```

---

## 2. Node / build toolchain (development machine)

| component | version | how verified | shipped? |
| --- | --- | --- | --- |
| local Node (nvm) | **24.15.0** | `node --version` | n/a |
| system `python3` | **3.9.6** | `python3 --version` | n/a — **unusable** (no build123d; see §3) |
| `three` | **0.186.1** | `node_modules/three/package.json` | yes — bundled into the viewer client |
| `@types/three` | 0.186.0 | `node_modules/@types/three/package.json` | no (types) |
| `esbuild` | **0.28.2** | `node_modules/esbuild/package.json` | no (build tool) |
| `typescript` | **5.9.3** | `node_modules/typescript/package.json` | no (build/typecheck tool) |
| `playwright-core` | **1.64.1** | `node_modules/playwright-core/package.json` | no (browser test driver) |
| `@types/node` | 26.6.6 | `node_modules/@types/node/package.json` | no (types) |
| `@types/react`, `@types/react-dom` | 19.3.0 | `node_modules/@types/react*/package.json` | no (types) |
| `react` / `react-dom` | **not bundled** | esbuild `--external:react` etc.; resolved from the harness page's shared module table at runtime | host-provided |
| pnpm (repo) | declared through the host's bundled pnpm 11.28.5 | `dsh plugin` output | n/a |

`package.json` declares the dev toolchain at `^` ranges; the versions above are
what the lockfile installed on this machine. A different developer's install may
resolve newer patch releases — that is why `pnpm-lock.yaml` is committed.

---

## 3. Python runtime

| component | version | how verified | status |
| --- | --- | --- | --- |
| uv | **0.9.13** (Homebrew) | `uv --version` | verified |
| CPython | **3.12.13** (uv-managed, `cpython-3.12-macos-aarch64-none`) | `uv python list`; `/Volumes/ZHITAI/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12 -V` | verified |
| virtualenv | `python/.venv` | `pyvenv.cfg` present; interpreter works | verified |
| `build123d` | **0.13.0** | `python/.venv/bin/python -c "import importlib.metadata as m; print(m.version('build123d'))"`; also pinned in `python/requirements.txt` | verified |
| `cadquery-ocp-novtk` (OCP bindings) | **8.0.1.1.0** | same command against the venv; `OCP.__version__` = `8.0.1.1` | verified |
| OpenCASCADE (OCCT) | **8.0.1** | as recorded in `python/requirements.txt` (the OCCT version bundled by `cadquery-ocp-novtk 8.0.1.1.0`) | verified via the binding package |
| `trimesh` | **5.2.0** | venv metadata; pinned in `python/requirements.txt` | verified |
| `numpy` | **2.5.4** | venv metadata; pinned in `python/requirements.txt` | verified |
| `pytest` (runtime tests, dev) | 9.2.0 | venv metadata; `python/requirements-dev.txt` | verified |
| transitive Python packages | 62 packages installed | `importlib.metadata` enumeration (see `THIRD_PARTY_NOTICES.md` §4); exact freeze in `python/requirements.lock.txt` (65 lines incl. header, generated with `uv pip freeze`) | verified — lock file present |
| interpreter floor | CPython **3.12** | `python/requirements.txt` header; `python/setup-runtime.mjs` selects 3.12; `python/.venv` or `$DSH_CAD_VENV` | verified |

Why 3.12 and uv: Homebrew Pythons on this machine are broken for uv (empty
`platform.mac_ver()`), and the PATH `python3` is 3.9.6 without build123d
(`docs/research/DSH_PLUGIN_API_NOTES.md` §8; `python3 --version` re-checked
2026-10-30). The supported interpreter is the uv-managed CPython 3.12, installed
and driven by `python/setup-runtime.mjs` (`npm run setup:python`) — also reachable
through `cad_runtime_status {action:"repair"}`.

Measured runtime behaviour: first `import build123d` after install ≈ **80 s**
(bytecode compilation), warm import ≈ **1.6 s** — the reason the runtime is a
long-lived process (ADR-0002), with `runtimeStartTimeoutMs = 240000`.

---

## 4. What is *not* verified, and the commit gap

| item | status | note |
| --- | --- | --- |
| DSH upstream commit hash | **not resolvable** | release asar; no repo metadata. Docs cite *release `0.2.1-rc.3`, asar runtime* and never invent a hash |
| DSH versions other than `0.2.1-rc.3` | **not tested** | host APIs are pre-stable; upstream states compatibility-breaking changes are expected (repo README "developer preview") |
| Windows / Linux | **not tested** | only macOS 26.2 arm64 was available; the Python bootstrap and the child-process supervisor are the platform-sensitive parts |
| Intel macOS | **not tested** | uv CPython used here is `macos-aarch64` |
| Python 3.11 / 3.13 | **not tested** | 3.12.13 is the supported interpreter |
| Browser matrix | **not tested exhaustively** | the viewer runs in the Harness Web UI; the in-app browser session is the tested target. Safari/Firefox/older Chromium are unverified |
| GPU / WebGL2 | **assumed** | three.js GLB rendering requires WebGL2; no fallback verified |
| 4K / HiDPI scaling | **not tested** | |
| Cordis versions other than 4.0.5 | **not tested** | the asar pins 4.0.5 |
| Node 22.5–24.20 | **not tested** | bundled 24.21.0 and dev 24.15.0 are what ran |

**Why the commit gap is left open:** the installed DeepSeek Harness is a signed
release bundle (`/Applications/DeepSeek Harness.app`, `app.asar`). There is no
`.git` directory, no `version.json` carrying a commit, and the upstream GitHub
API was rate-limited/unreachable from this sandbox when checked on 2026-10-30.
The honest record is the release identifier; fabricating a hash would be worse
than the gap.

---

## 5. Compatibility policy

1. **Host version is pinned** by `engines.dsh`; an upgrade to a new DSH release is
   a compatibility event requiring a re-run of the A–L acceptance scenarios, not a
   routine dependency bump. Reasons: tool/job/route/client APIs are pre-stable.
2. **Wire protocol is versioned** (`PROTOCOL_VERSION = '1.0'`) and negotiated by
   `runtime.hello`; a mismatch fails with `protocol_version_mismatch` instead of
   misbehaving. The document schema id `dsh.cad/document@1` is versioned the same
   way.
3. **Python dependencies are pinned exactly** (`==`) in `python/requirements.txt`;
   the repair path reinstalls from the frozen set, not from "latest".
4. **Node toolchain is locked** by `pnpm-lock.yaml`; the build emits a browser
   bundle targeting `es2022`, which the bundled Node 24 host and current Web UI
   both satisfy.
5. **Every accepted change that touches a version above must update this file and
   `THIRD_PARTY_NOTICES.md`** in the same change.

---

## 6. Re-verification commands

Copy-paste to re-check this matrix on another machine (macOS arm64 expected):

```sh
# host
~/.local/bin/dsh-wrapper --version                      # 0.2.1-rc.3
cat "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/versions.json"
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  -e "console.log(require('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/package.json').version)"

# local toolchain
node --version; esbuild --version 2>/dev/null || node -e "console.log(require('esbuild').version)"
node -e "console.log(require('three/package.json').version)"

# python runtime
uv --version
uv python list | grep cpython-3.12
python/.venv/bin/python - <<'PY'
import importlib.metadata as m
for p in ("build123d","cadquery-ocp-novtk","trimesh","numpy"):
    print(p, m.version(p))
import OCP; print("OCP", OCP.__version__)
PY

# OS
sw_vers; uname -m
```

Expected values: `0.2.1-rc.3` · node 24.21.0 bundled / 24.15.0 dev · cordis 4.0.5 ·
`build123d 0.13.0` · `cadquery-ocp-novtk 8.0.1.1.0` · `OCP 8.0.1.1` ·
`trimesh 5.2.0` · `numpy 2.5.4` · macOS 26.2 arm64.

---

## 7. Development machine reference

| item | value |
| --- | --- |
| OS | macOS 26.2 (build 25C56) |
| arch | arm64 (`uname -m`), Apple M4, 16 GB unified memory |
| harness home | `~/.dsh` |
| plugin repo | `/Volumes/ZHITAI/texttocad/dsh-plugin-cad` |
| Python venv | `/Volumes/ZHITAI/texttocad/dsh-plugin-cad/python/.venv` |
| uv CPython | `/Volumes/ZHITAI/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12` |
