# Clean-room provenance record

**Record date:** 2026-10-30
**Project:** `dsh-plugin-cad` — native DeepSeek Harness CAD plugin
**Reference (functional target only):** `earthtojake/text-to-cad` — **excluded**;
see §2
**Standing specification:** `docs/research/SPEC_P0.md`

This record states, in auditable terms, what the team did and did not consult
while designing and implementing this plugin. It is deliberately conservative:
where the team cannot prove something, it says so.

---

## 1. The claim, precisely

> `dsh-plugin-cad` is a **functionality-level clean-room replacement** for the
> capability described in the project brief. No source, documentation, asset,
> test or transcript of the reference project was cloned, fetched, read or
> executed by anyone on this team.
>
> This is **not** a verified clean-room reimplementation of the reference's
> internals. The team never inspected those internals, so it cannot certify that
> the implementation is internally dissimilar — only that the design was derived
> independently from the brief, from public third-party APIs, and from the host
> platform's own SDK.

Two different claims are often conflated; keeping them apart matters:

| claim | made? | basis |
| --- | --- | --- |
| We did not consult the reference project | **yes** | process rule + repository inventory (§2, §3) |
| The resulting implementation is internally dissimilar from the reference | **no** | cannot be established without inspecting the reference, which was excluded |

---

## 2. Excluded sources

The reference project was excluded at the process level, not by licence review:

- It was **not cloned** and does not exist anywhere under `/Volumes/ZHITAI` or the
  harness home; the workspace contains only `dsh-plugin-cad`.
- It was **not fetched** over the network by any team member.
- It was **not read** — no file, README, issue, screenshot or transcript of it
  entered any agent's context.
- It was **not executed**, built or installed.

What the exclusion is *not*: it is not a claim that individual designs are novel.
Declarative CAD documents, revision histories and 3D viewers are common
engineering patterns; their presence is general CAD knowledge, not derivation.

**How to audit this.** The workspace inventory is small and self-contained
(`find` on the repo and its parent shows only this project). The provenance of
each design input is listed in §4; anything not listed there was not consulted.
This record is a **team attestation**, not an independent audit — no third party
verified the absence of contamination, and this document does not pretend
otherwise.

---

## 3. What the reference's role actually is

The brief names it as the *thing being replaced*: a functional target with feature
categories (parametric CAD generation, assemblies, drawings, DFM, exports,
optimisation). Its **behaviour was not specified** in the brief beyond that
category list. That single fact drives the whole provenance design:

- Where the brief defines behaviour (e.g. "bracket 80×60×8 with Ø20 and four Ø6
  holes inset 12 mm"), `SPEC_P0.md` pins it precisely.
- Where the brief only names a category (assemblies, drawings, DFM packs, extra
  formats), `SPEC_P0.md` §9 records it as **unverified reference behaviour** and
  implementation is deferred; the plugin **does not implement it and does not
  claim to** (see `docs/IMPLEMENTATION_PLAN.md`).

The result is that the "clean room" has a real specification in the room — the
brief plus `SPEC_P0.md` — rather than an imagined one.

---

## 4. Sources actually consulted

### 4.1 Host platform SDK and documentation (primary)

| source | how obtained | what was taken |
| --- | --- | --- |
| Installed DeepSeek Harness `0.2.1-rc.3` runtime — `app.asar/dsh/node_modules/@deepseek-ai/*`, including `lib/types/**/*.d.ts` | read locally from the installed app; the asar was read with Electron-as-Node | the real `ctx` API (`effect`, `tools`, `jobs`, `inject`, `slots`, `locale`), tool/job/route contracts, client-module serving. Recorded in `docs/research/DSH_PLUGIN_API_NOTES.md` |
| Upstream DeepSeek Harness repo docs: `README.md`, `docs/architecture.md`, `docs/development.md`, `AGENTS.md`, `SAFETY.md` | fetched 2026-10-30 from `raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/…` (github.com HTML and web search were blocked in this sandbox) | profile/bundle layering model, plugin-everything architecture, Node/pnpm floors. Cited in `docs/DSH_INTEGRATION.md` §10 |
| Official docs site `https://deepseek-harness.github.io/deepseek-harness/` | reachable (HTTP 200) on 2026-10-30 | landing page only; no plugin-authoring page could be located by direct URL, so **not** used for API specifics |

No documentation page was used that could not be fetched and read; where a page
was unavailable (github.com HTML view, the docs site's internal authoring pages),
this record says so rather than citing it from memory.

### 4.2 Installed third-party Harness plugins (host-API usage references)

Two real, working native plugins already installed on this machine were read as
**behavioural references for the host API only** — how to register a tool, a job,
a slot, a route, a client bundle on this exact Harness version:

| plugin | location | licence | taken |
| --- | --- | --- | --- |
| `dsh-excalidraw` v0.1.0 | `/Volumes/ZHITAI/DSHExcalidraw` | MIT | registration patterns for tools, slots, client factory bundle |
| `dsh-plugin-bidkit` v0.1.0 | `/Volumes/ZHITAI/标书/dsh-plugin-bidkit` | MIT | registration patterns for tools, routes, jobs, locale |

Neither is a CAD project and neither is the reference project. What was taken is
API usage, not product design or CAD logic. Both are MIT-licensed, so no
attribution obligation is lost either way; they are nonetheless listed in
`THIRD_PARTY_NOTICES.md` because they materially informed the integration layer.

### 4.3 Public third-party library documentation

| source | what was taken |
| --- | --- |
| build123d documentation and installed package source (`build123d==0.13.0`) | builder API, shape validity/volume/bbox queries, export calls |
| OpenCASCADE (`cadquery-ocp-novtk 8.0.1.1.0`, OCCT 8.0.1) via its Python binding | B-rep semantics behind build123d (validity, sewing, tessellation) |
| trimesh (`trimesh==5.2.0`) documentation and source | GLB export, vertex welding, watertight check |
| three.js documentation | GLTF loading, orbit controls, lighting in the viewer |
| numpy (`numpy==2.5.4`) | array handling in the export/checks path |

Exact versions and licences: `THIRD_PARTY_NOTICES.md`; version pins:
`python/requirements.txt`.

### 4.4 This workspace

Black-box experimentation with the installed libraries (e.g. measuring the
cold/warm `import build123d` cost recorded in
`docs/research/DSH_PLUGIN_API_NOTES.md` §8), and the project brief itself.

---

## 5. What was *not* consulted

Recorded explicitly so future contributors do not assume otherwise:

- the reference project in any form (source, docs, issues, PRs, videos, blog
  posts about its internals);
- any other text-to-CAD product's source or internal documentation;
- CAD kernel code beyond the public APIs of the libraries in §4.3;
- the harness's own internal CAD-like plugins, if any exist (not investigated).

General engineering knowledge (JSON Schema, JSON-RPC, optimistic concurrency,
atomic file writes, three.js rendering) is not a "source" in the clean-room sense
and is not itemised.

---

## 6. Resulting independence of the design

Evidence that the design was derived from this project's constraints rather than
mimicked:

1. **The document schema is ours** (`dsh.cad/document@1`): a closed eight-op
   catalogue, `$parameter` references, 1..64 features, explicit rejection rules.
   It exists because ADR-0001 rejected code execution — a host-security decision,
   not a reference feature.
2. **The runtime boundary is measured**, not copied: one long-lived process
   because cold import is ≈80 s on this machine (ADR-0002).
3. **Revisions are immutable with optimistic concurrency** because the harness's
   retry and job semantics make duplicate writes normal (ADR-0003, ADR-0004).
4. **Artifacts are references served by the host** because the harness tool
   contract forbids binary payloads and prescribes route registration (ADR-0005).
5. **The P0 scope is a single part**, because that is what the brief specifies and
   can be accepted; everything else is deferred with a reviewed-spec gate.

---

## 7. Obligations that follow

1. New third-party dependencies or assets must be added to
   `THIRD_PARTY_NOTICES.md` with licence and version.
2. New *design* sources (including any future look at the reference) require a new
   ADR; silent consultation would invalidate this record.
3. Any P1/P2 feature inspired by the reference's category list must first get an
   independently reviewed spec (`SPEC_P0.md` §9 pattern), not an inferred one.
4. If the team ever obtains the reference for comparison, this document must be
   revised to say so — the claim above would no longer hold as written.

---

## 8. Related records

- `docs/research/SPEC_P0.md` — the independent specification, §9 unverified list
- `docs/adr/ADR-0006-clean-room-posture.md` — the decision record
- `docs/IMPLEMENTATION_PLAN.md` — P1/P2 candidates gated on a reviewed spec
- `THIRD_PARTY_NOTICES.md` — licences actually in use
- `docs/research/DSH_PLUGIN_API_NOTES.md` — host sources that were consulted
