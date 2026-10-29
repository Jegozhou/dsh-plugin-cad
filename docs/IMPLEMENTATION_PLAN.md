# Implementation plan — milestones, status, and the P0 slice

Status is **evidence-based**: a milestone is only `DONE` when a recorded run in
`docs/research/STATUS_*.md` or `tests/e2e/RESULTS.md` supports it. This file is
updated as those records land; anything without evidence is `IN PROGRESS` or
`NOT STARTED`, never assumed.

Snapshot: 2026-10-30 07:26, verified tree **git commit `7b5d88f`** (acceptance complete: 12 PASS / 0 FAIL; final lifecycle 7/7 on a brand-new profile). Final status lives in the evidence
files, not here — this plan records the *definition* of each milestone and the
scope decisions.

---

## 1. Milestone matrix

| milestone | definition (exit criteria) | status | evidence |
| --- | --- | --- | --- |
| **M0** — host integration proven | plugin package installs into a dedicated profile with the documented command; bundle row composes into the tree; host plugin loads, registers a native tool + HTTP route; client module appears in `__DSH_BOOT__` and is served; disable removes the tool | **DONE (probe package)** | `tests/e2e/RESULTS.md` §M0, §M0-B, §M0-J (probe bundle `dsh-plugin-m0probe`, not the real plugin — hence scenarios A/B are `PARTIAL` there) |
| **M1** — contracts and skeletons | tool/error/wire contracts frozen; host skeleton (config, paths, store, validation); runtime skeleton (protocol, document parsing, errors); both sides agree on protocol constants via a test | **DONE** | `src/contracts/*.js` + `python/cad_runtime/protocol.py` with the mirroring contract test; `docs/CAD_RUNTIME_PROTOCOL.md` normative; `STATUS_host.md` records host typecheck/tests, `STATUS_runtime.md` §4 lists the python suites |
| **M2** — real geometry | build123d builds all 8 feature ops; the 8 validation checks run and report; STEP + GLB always, STL/SVG on request; artifacts written atomically with bytes+sha256 | **PARTIAL — core proven** | `docs/research/STATUS_runtime.md` §1–§2 (all 8 ops implemented; `--selftest` JSON with volume 34981.947193 = analytic, bbox 80×60×8, 8/8 checks, four artifacts with sha256, installer `--check`), `tests/e2e/RESULTS.md` §M1-D (stdio RPC build) and §M1-E (independent STEP/GLB verifier PASS). `STATUS_runtime.md` §2 test suite: **119 pytest tests pass** (reproduced twice). Acceptance E2E exercises `box`+`hole`+`hole_pattern`; the other ops are covered by `tests/python/test_features.py` (recorded in the 119), not by an acceptance scenario |
| **M3** — host service, tools, revisions | 9 tools registered with schemas; revision store + optimistic concurrency + `request_id`; job controller and background builds; asset route admitted by the harness; export path confinement | **DONE** | `STATUS_host.md`: typecheck+bundle OK, **88/88 host tests pass** (incl. real build123d, ctx.jobs session-id owner/caller/read-shape drifts fixed with regression tests, refused-start lock release, cancel to terminal `killed`); acceptance `tests/e2e/RESULTS.md` §A, §B, §C, §G, §H, §I, §J, §K, §L |
| **M4** — in-Harness viewer | client bundle registers into `main` + `sidebar.panellist`; GLB loads by artifact reference; revision change refreshes without tearing; locale/theme respected; disable removes UI | **DONE — F/G acceptance PASS** | Final clean run: `CLIENT E2E OK: 13 steps … revision r-0005 -> r-0006`, `client-e2e-report.json` `ok:true` (4 GLB fetches, r-0005 then r-0006, all 200 `model/gltf-binary`), screenshots `client-00-panel.png` … `client-05-reload.png`; `STATUS_client.md` §2 build + §5 disposal |
| **M5** — acceptance + release | scenarios A–L evidenced; docs complete and consistent; `npm run build`, unit/integration/python tests green; README install/demo verified | **DONE — 12 PASS / 0 FAIL / 0 PARTIAL (E†)** | `docs/TEST_REPORT.md` §2-§4: H passed on the 4th run (3 recorded `dsh-jobs-local` contract drifts fixed in between); F/G final clean run r-0005→r-0006; test runs recorded at commit `7b5d88f`: host **88/88**, python **119 passed in 35.92 s**, build `lib/index.js` 186.9 KiB + `lib/client.js` 705.7 KiB; final lifecycle E2E on brand-new profile `cadfinal` **7/7 PASS**; distribution verified via `pnpm pack` (297,501 B tarball) → tarball install (§3b of `COMPATIBILITY_MATRIX.md`) |

Dependency order: M0 → M1 → (M2 ∥ M3) → M4 → M5. M2 and M3 can proceed in
parallel because the wire contract (`src/contracts/protocol.js`) is frozen; M4
depends on M3's asset route and revision metadata; M5 depends on everything.

---

## 2. The selected P0 slice (what we build now)

**One sentence:** an agent creates a parametric single part as a declarative
document, the plugin builds a real B-rep with build123d, validates it, exports
STEP/GLB, and shows it in the Harness viewer; changing a parameter creates a new
immutable revision that the viewer picks up.

In scope:

- document schema `dsh.cad/document@1` — parameters + 8 ops + `$param` references
  (`docs/research/SPEC_P0.md` §3, §3.1);
- immutable revision store with optimistic concurrency and idempotent writes
  (ADR-0003);
- one long-lived Python runtime (ADR-0002) with 8 validation checks and
  STEP/GLB/STL/SVG export (`SPEC_P0.md` §5);
- 9 native tools (`src/contracts/tools.js`);
- Harness jobs for background builds (ADR-0004);
- host-served artifact route + in-Harness three.js viewer (ADR-0005);
- the four CAD skills shipped as agent guidance (`skills/`).

Out of scope for P0 (explicit non-goals, `SPEC_P0.md` §8): assemblies and mates,
drawings, DFM rule packs, sheet metal, generative/topology optimisation, CAM,
user Python, multi-user editing, network/telemetry at runtime.

**Acceptance part** (`SPEC_P0.md` §1): bracket 80 × 60 × 8 mm, Ø20 central
through-hole, 4 × Ø6 corner holes inset 12 mm, then the same part with modified
parameters — exercised by scenarios C, D, E, G.

---

## 3. P0 / P1 / P2 feature candidates

`P0` = in this milestone. `P1` = next, needs a reviewed spec. `P2` = later /
exploratory. The gate is the same for every P1/P2 item: **an independently
reviewed specification** in the `SPEC_P0.md` style, then an ADR if it changes an
architecture decision.

| # | feature | tier | notes / gate |
| --- | --- | --- | --- |
| 1 | Document schema + 8 feature ops + `$param` refs | **P0** | specified, implemented |
| 2 | 8 validation checks + report (volume, bbox, topology) | **P0** | specified |
| 3 | Immutable revisions + optimistic concurrency + `request_id` | **P0** | ADR-0003 |
| 4 | STEP / GLB always; STL / SVG on request | **P0** | `src/contracts/protocol.js` `EXPORT_FORMATS`; SVG via `cad_render_preview` |
| 5 | In-Harness 3D viewer + sidebar entry + revision refresh | **P0** | ADR-0005, client half |
| 6 | Background builds via Harness jobs + `cad_get_job_status` | **P0** | ADR-0004 |
| 7 | Export into workspace with overwrite protection | **P0** | `cad_export_model` |
| 8 | Runtime bootstrap/repair (`npm run setup:python`, `cad_runtime_status repair`) | **P0** | README recovery path |
| 9 | Assemblies / mates / exploded views | P1 | **unverified reference behaviour** — brief names the category without definitions. Needs reviewed spec: part model, mate types, DOF, interference semantics. `skills/assembly-design/SKILL.md` explains the P0 workaround honestly |
| 10 | Engineering drawings (dimensions, sections, GD&T, title block) | P1 | **unverified reference behaviour**; P0 only has SVG projections. Needs a drawing spec (views, dimensioning rules, tolerance model) |
| 11 | DFM rule packs (process-specific min wall, tool radius, draft) | P1 | **unverified reference behaviour**; P0 has heuristics in skills + one 0.2 mm warn check only. Needs a process matrix spec |
| 12 | Additional export formats (STEP AP242, IGES, 3MF, DXF flat) | P1 | format semantics and validation per format must be specified; "opens in tool X" needs evidence |
| 13 | STEP/IGES **import** into a document (feature recognition or base solid) | P2 | hard problem (feature recognition); without a spec it would be a guess |
| 14 | Freeform modelling (sweep, loft, revolve, text) | P2 | extends the DSL; needs a grammar extension spec + runtime work |
| 15 | Incremental / topology optimisation ("generative") | P2 | **unverified reference behaviour**; no acceptance criteria in the brief |
| 16 | Multi-user concurrent editing | P2 | conflicts with ADR-0003 single-writer model; needs a real concurrency design |
| 17 | CAM toolpaths / G-code | P2 | different product; process/kernel validation out of scope |
| 18 | Sheet metal with flat pattern | P2 | needs bend model, K-factor, flat-pattern spec |

---

## 4. Unverified reference behaviour (do not implement by guessing)

The brief names feature *categories* of the reference project without defining
their inputs, outputs or acceptance criteria. Per `SPEC_P0.md` §9 and
`docs/CLEAN_ROOM_PROVENANCE.md`, these are recorded as unverified and **not
implemented**:

- assemblies / mates (how parts are represented and constrained);
- engineering drawings (what is dimensioned, which standard, output format);
- DFM rule packs (which processes, which thresholds, pass/fail semantics);
- additional export formats and their validation criteria;
- incremental optimisation (objective, constraints, iteration budget).

Any work on these starts by writing an independently reviewed spec (same
structure as `SPEC_P0.md`), not by guessing from the category name.

---

## 5. Risks to the plan

| risk | impact | mitigation |
| --- | --- | --- |
| Host API drift (pre-stable harness APIs) | tools/jobs/routes/break on upgrade | pin `engines.dsh`, re-run A–L on upgrade (docs/COMPATIBILITY_MATRIX.md §5) |
| Python cold start (~80 s) | first build feels slow | lazy start, 240 s start timeout, long-lived process (ADR-0002), documented in README |
| OCCT crash in a build | runtime death mid-request | supervisor restart, `runtime_crashed` (503), report the failure |
| Single serialised build | long queue for heavy parts | `maxConcurrentBuilds: 1` by design; background jobs + status tool keep the agent responsive |
| Clean-room scope creep | accidentally claiming reference parity | provenance record + P1/P2 spec gate (ADR-0006) |
| Docs drift from code | false claims | docs cite files/commands; TEST_REPORT only records observed runs |

---

## 6. Where the status actually comes from

Do not update this file to say a milestone is done without one of:

- `docs/research/STATUS_runtime.md` — runtime owner's verbatim command output;
- `docs/research/STATUS_host.md` — host owner's verbatim command output;
- `docs/research/STATUS_client.md` — client owner's evidence (boot graph, DOM,
  screenshots);
- `tests/e2e/RESULTS.md` — Lead's scenario A–L mapping.

`docs/TEST_REPORT.md` aggregates those files and is the only place a scenario is
marked PASS.
