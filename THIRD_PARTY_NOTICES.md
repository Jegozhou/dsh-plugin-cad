# Third-party notices

`dsh-plugin-cad` itself is MIT licensed (`LICENSE`, © 2026 dsh-plugin-cad
contributors). It builds on the components below. **Nothing here is a claim of
authorship**; the table records what is actually installed on this machine and
how it is used.

Two distribution facts decide the obligations:

1. **Python dependencies are not bundled.** The npm package ships
   `python/cad_runtime/**` and `python/requirements.txt`, not a virtualenv. At
   setup the user's machine installs the pinned wheels from PyPI with uv
   (`python/setup-runtime.mjs`). So licensing obligations for those wheels are
   discharged by the upstream packages themselves; this project does not
   redistribute them.
2. **JavaScript libraries are bundled.** `three` is compiled into the viewer
   client bundle (`lib/client.js`), so its MIT notice must travel with it. React
   is **not** bundled (esbuild `--external:react`); it is resolved from the
   Harness page's shared module table.

Versions verified 2026-10-30; sources listed per component.

---

## 1. Host platform

| component | version | license | source | use |
| --- | --- | --- | --- | --- |
| DeepSeek Harness (`dsh`) | 0.2.1-rc.3 | MIT | https://github.com/deepseek-ai/deepseek-harness | the application this plugin extends |
| `@deepseek-ai/cordis` | 4.0.5 | MIT | https://github.com/cordiverse/cordis (vendored by DSH) | plugin/effect/service framework the plugin is written against |

Both were read from the installed app bundle
(`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/…`).
Upstream `README.md` states the MIT licence (`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md`,
fetched 2026-10-30).

---

## 2. Shipped JavaScript dependencies

| component | version | license | copyright | source | how shipped |
| --- | --- | --- | --- | --- | --- |
| three.js (`three`) | 0.186.1 | MIT | © 2010-2026 three.js authors | https://github.com/mrdoob/three.js | **bundled** into the viewer client bundle (`lib/client.js`) by esbuild |
| react / react-dom | not bundled | MIT | © Meta Platforms, Inc. and affiliates | https://react.dev | **external** — supplied by the Harness page's shared module table; the plugin bundles no copy |

MIT obligations are met by retaining the copyright and permission notice for
three.js. The full MIT text is reproduced in §6.

---

## 3. Build- and test-time dependencies (not distributed)

| component | version | license | copyright | source |
| --- | --- | --- | --- | --- |
| esbuild | 0.28.2 | MIT | © 2020 Evan Wallace | https://github.com/evanw/esbuild |
| typescript | 5.9.3 | Apache-2.0 | © Microsoft Corporation | https://github.com/microsoft/TypeScript |
| playwright-core | 1.64.1 | Apache-2.0 | © Microsoft Corporation | https://github.com/microsoft/playwright |
| @types/node | 26.6.6 | MIT | DefinitelyTyped contributors | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react, @types/react-dom | 19.3.0 | MIT | DefinitelyTyped contributors | same |
| @types/three | 0.186.0 | MIT | DefinitelyTyped contributors | same |

These are declared in `package.json` `devDependencies` and installed by pnpm;
they are not part of the published runtime artifacts.

---

## 4. Python runtime dependencies

### 4.1 Direct (pinned in `python/requirements.txt`)

| package | version | license | source | role |
| --- | --- | --- | --- | --- |
| build123d | 0.13.0 | **Apache-2.0** | https://github.com/gumyr/build123d · https://pypi.org/project/build123d/ | declarative B-rep modelling over OCCT |
| cadquery-ocp-novtk | 8.0.1.1.0 | **Apache-2.0** (Python binding package) | https://pypi.org/project/cadquery-ocp-novtk/ | OCP bindings; **bundles OpenCASCADE 8.0.1 binaries, which are LGPL-2.1 with the OCCT exception** — see §5 |
| trimesh | 5.2.0 | MIT (© 2023 Michael Dawson-Haggerty) | https://github.com/mikedh/trimesh · https://pypi.org/project/trimesh/ | GLB export, vertex welding, watertight check |
| numpy | 2.5.4 | BSD-3-Clause (plus bundled components under 0BSD/MIT/Zlib/CC0) | https://github.com/numpy/numpy · https://pypi.org/project/numpy/ | numeric arrays |

> **Correction to a common assumption:** build123d 0.13.0 is Apache-2.0, not
> LGPL. This was read from the installed `METADATA`
> (`python/.venv/lib/python3.12/site-packages/build123d-0.13.0.dist-info/METADATA`,
> `License: Apache-2.0`) and from PyPI JSON (2026-10-30). The LGPL-2.1-with-
> exception term applies to **OpenCASCADE (OCCT)**, whose binaries ride inside
> the `cadquery-ocp-novtk` wheel.

### 4.2 Transitive Python environment

Snapshot from `python/.venv` on 2026-10-30 (62 distributions). `†` marks
packages pulled only for testing/CI. This is the reproducibility record for the
installed environment; the exact frozen set is `python/requirements.lock.txt`
(65 lines incl. header, generated with `uv pip freeze`), and dev-only additions
(pytest) are pinned in `python/requirements-dev.txt`.

| package | version | license |
| --- | --- | --- |
| anytree | 2.13.0 | Apache-2.0 |
| asttokens | 3.0.2 | Apache-2.0 |
| bd_materials | 0.2.5 | Apache-2.0 |
| build123d | 0.13.0 | Apache-2.0 |
| cadquery-ocp-novtk | 8.0.1.1.0 | Apache-2.0 (bundles OCCT, LGPL-2.1 + exception) |
| cadquery-ocp-proxy | 8.0.1.1.0 | Apache-2.0 |
| certifi | 2026.10.23 | MPL-2.0 |
| charset-normalizer | 3.5.2 | MIT |
| cloudpickle | 3.1.2 | BSD-3-Clause |
| dataclasses-json | 0.6.7 | MIT |
| deprecated | 3.0.0 | MIT |
| executing | 2.3.0 | MIT |
| ezdxf | 1.4.5 | MIT |
| fonttools | 4.68.0 | MIT |
| idna | 3.20 | BSD-3-Clause |
| iniconfig † | 2.3.1 | MIT |
| ipython | 9.17.1 | BSD-3-Clause |
| ipython_pygments_lexers | 1.1.1 | BSD |
| jedi | 0.20.1 | MIT |
| joblib | 1.6.0 | BSD-3-Clause |
| lib3mf | 2.5.0 | BSD |
| marshmallow | 3.26.2 | MIT |
| matplotlib-inline | 0.2.2 | BSD-3-Clause |
| mpmath | 1.3.0 | BSD |
| mypy_extensions | 1.1.0 | MIT |
| narwhals | 2.28.0 | MIT |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| ocp_gordon | 0.3.1 | Apache-2.0 |
| ocpsvg | 0.7.0 | Apache-2.0 |
| packaging † | 26.3 | Apache-2.0 OR BSD-2-Clause |
| parso | 0.8.7 | MIT |
| pexpect | 4.9.0 | ISC |
| pillow | 13.0.0 | MIT-CMU |
| platformdirs | 4.14.0 | MIT |
| pluggy † | 1.7.0 | MIT |
| prompt_toolkit | 3.0.53 | BSD |
| psutil | 7.2.2 | BSD-3-Clause |
| ptyprocess | 0.7.0 | ISC |
| pure_eval | 0.2.4 | MIT |
| pygltflib | 1.16.5 | MIT |
| pygments | 2.21.0 | BSD-2-Clause |
| pyparsing | 3.3.3 | MIT |
| pytest † | 9.2.0 | MIT |
| requests | 2.34.2 | Apache-2.0 |
| scikit-learn | 1.9.1 | BSD-3-Clause |
| scipy | 1.18.1 | BSD-3-Clause |
| stack-data | 0.6.3 | MIT |
| svgelements | 1.9.6 | MIT |
| svgpathtools | 1.8.0 | MIT |
| svgwrite | 1.4.3 | MIT |
| sympy | 1.14.0 | BSD |
| threadpoolctl | 3.7.0 | BSD-3-Clause |
| threejs-materials | 1.2.5 | Apache-2.0 |
| traitlets | 5.16.1 | BSD-3-Clause |
| trianglesolver | 1.2 | MIT |
| trimesh | 5.2.0 | MIT |
| typing-inspect | 0.9.0 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.8.0 | MIT |
| wcwidth | 0.9.4 | MIT |
| webcolors | 24.8.0 | BSD-3-Clause |
| wrapt | 2.5.1 | BSD-2-Clause |

Licence values were read from each distribution's `METADATA`
(`License`, `License-Expression`, or `Classifier: License :: …`) and, where the
metadata was silent, from the licence file shipped in its `dist-info/licenses/`.
Platform-only conditional dependencies (e.g. `py-lib3mf` on Linux aarch64) resolve
to the platform-appropriate package listed above.

---

## 5. OpenCASCADE (OCCT) — LGPL-2.1 with exception

`cadquery-ocp-novtk` embeds OpenCASCADE Technology binaries. OCCT's own terms,
verified 2026-10-30 at https://dev.opencascade.org/resources/licensing:

> OCCT is distributed under **LGPL 2.1 with an additional exception** (the "OCCT
> exception"), which permits linking proprietary applications against OCCT
> without the LGPL's relinking obligation for the proprietary code.

How this project complies:

- The OCCT binaries are **installed from PyPI into the user's own environment**
  (`python/.venv`), not redistributed in this repository or npm package. No OCCT
  source or binary is committed here.
- OCCT is used **dynamically**, through Python extension modules, at runtime.
- The user can replace the OCCT build by reinstalling the Python dependency;
  nothing in this project statically links or forks OCCT.
- If this project ever starts **redistributing** a Python environment (e.g. a
  bundled runtime), the OCCT licence text and LGPL relinking path must be shipped
  with it — that is a release-blocking review item, not an assumption.

The OCCT licence text is available upstream
(https://dev.opencascade.org/resources/licensing, `LGPL_21.txt` and
`LGPL_EXCEPTION.txt` links on that page).

---

## 6. Retained MIT notice (three.js)

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Retained copies of the other MIT notices (trimesh © 2023 Michael
Dawson-Haggerty; esbuild © 2020 Evan Wallace; and the MIT `@types/*` packages)
are preserved verbatim in their `dist-info`/`node_modules` licence files on any
installed system, and are reproduced by the package managers' own licence
collection (`pnpm licenses list`, `pip show -f`).

---

## 7. Host-API references (not shipped, no code copied)

Two installed third-party Harness plugins were read as references for **how to
use the host API**, not for product design or CAD logic
(`docs/CLEAN_ROOM_PROVENANCE.md` §4.2):

| project | version | license | location |
| --- | --- | --- | --- |
| dsh-excalidraw | 0.1.0 | MIT (© 2026 Jegozhou) | `/Volumes/ZHITAI/DSHExcalidraw` |
| dsh-plugin-bidkit | 0.1.0 | MIT (© 2026 BidKit contributors) | `/Volumes/ZHITAI/标书/dsh-plugin-bidkit` |

Neither is a dependency, neither is bundled, and neither is the text-to-CAD
reference project.

---

## 8. Maintenance rule

Any new runtime dependency, bundled asset, or vendored snippet must be added to
this file (name, version, licence, source, and whether it is redistributed) in the
same change that introduces it, and the versions must agree with
`docs/COMPATIBILITY_MATRIX.md` and `python/requirements.txt`.
