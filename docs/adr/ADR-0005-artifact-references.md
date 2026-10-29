# ADR-0005 — Artifacts are references; bytes are served by the Host, never in tool results

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead, host-eng, client-eng
- **Milestone:** P0 (M0–M5)

## Context

Two consumers need the same bytes:

- the **agent**, which must be told that a model exists without having megabytes
  of GLB/STEP pasted into its context, and
- the **in-Harness viewer**, which must fetch the GLB from the page that the
  Harness is already serving, under the Harness's existing admission control.

The harness contract is explicit that tool results are lossless JSON and that
binary payloads do not belong in them
(`docs/research/DSH_PLUGIN_API_NOTES.md` §3: "Never put binary data or whole
model files in a tool result — return artifact references instead"). The route
mechanism is also prescribed: `ctx.inject(['webServer'], …)` →
`webServer.register({kind:'prefix', path, handler})`, and every request must be
admitted by the harness connection service rather than a second auth scheme (§4).

## Decision

**Reference model.**

An artifact is addressed by a stable reference and never inlined
(`docs/research/SPEC_P0.md` §6):

```jsonc
{ "artifactId": "m-1a2b3c4d5e:r-0002:glb", "format": "glb",
  "bytes": 31704, "sha256": "…",
  "url": "/dsh-plugin-cad/assets/models/m-1a2b3c4d5e/r-0002/model.glb",
  "contentType": "model/gltf-binary" }
```

- Tool payloads carry references only. `cad_export_model` with `output_path`
  copies bytes into a workspace-relative directory; it never returns them.
- The viewer fetches `url` **same origin**; no CORS, no plugin auth.

**Serving.**

- The Host registers a prefix route `/dsh-plugin-cad/assets` inside
  `ctx.inject(['webServer'], …)` and wraps `webServer.register` in `ctx.effect`
  so disable removes the route.
- Every request is admitted with the harness connection service
  (`connection?.requestRejection?.(req)`); the plugin adds **no** second auth
  scheme.
- Files are resolved by parsing `modelId` / `revisionId` / filename against the
  store layout `<DSH_HOME>/cad/models/<modelId>/<revisionId>/`, rejecting any
  path that escapes it (`path_escape` → HTTP 403, `src/contracts/errors.js`).
  Only known artifact filenames/content types are served; directory listing is
  not a feature.
- Size limits: `maxArtifactBytes` (128 MiB default, `cordis.patch.yml`) →
  `too_large` → HTTP 413.

**Store.**

- Default root `<DSH_HOME>/cad/models/`, overridable with `dataDir`; override is
  how the plugin is tested in a throwaway profile.
- Artifacts are written atomically inside a revision directory and recorded with
  bytes + sha256, so a reader never sees a partial file and a tampered file is
  detectable.

## Consequences

**Positive**

- The agent's context stays bounded regardless of model complexity, and the
  model can still verify integrity from `bytes` + `sha256`.
- No second authentication surface: the asset route inherits the page's session
  admission, which is also what makes scenario L (no path traversal) testable
  with plain `curl`.
- Artifacts survive session restarts and plugin reloads, which is what makes
  scenario I (recover model reference after restart) possible without a database.
- A future exporter (P1) can add formats without changing the tool payload shape.

**Negative / accepted costs**

- **Data outlives the plugin** by design: uninstall does not delete user CAD data
  (scenario K). Cleanup is a documented, user-initiated action, not an implicit
  side effect.
- **The viewer depends on the Host route prefix.** A host change to route
  registration or to connection admission breaks rendering first; both are
  host-API couplings pinned by `engines.dsh`.
- **Artifact names are a small protocol.** `<revision>/model.<ext>` plus report;
  renaming files is a breaking change for stored references, so the naming is
  documented in `docs/CAD_RUNTIME_PROTOCOL.md` (runtime owner) and must not drift.

## Alternatives considered

- **Base64 in tool results (rejected).** Bloats model context, impossible to
  stream, and violates the host's stated tool contract.
- **Data URLs (rejected).** Same bloat; the page would hold an entire GLB in a
  string.
- **A plugin-operated HTTP server on its own port (rejected).** New port, new
  auth/origin story, and it would not be admitted by the harness connection
  service.
- **Serving from the workspace with `file://` (rejected).** Browsers cannot read
  arbitrary files; the viewer is a page.
- **Database blobs (rejected).** No DB dependency in P0; files are inspectable
  and already backed up by point-in-time copy.

## References

- `docs/research/SPEC_P0.md` §6
- `docs/research/DSH_PLUGIN_API_NOTES.md` §3, §4
- `src/contracts/tools.js` — `cad_export_model` (`output_path`, `overwrite`),
  `cad_render_preview`, `cad_inspect_model`
- `src/contracts/errors.js` — `path_escape: 403`, `too_large: 413`,
  `not_found: 404`
- `cordis.patch.yml` — `maxArtifactBytes`, `dataDir`, `allowExport`
- Related: ADR-0002 (artifacts produced by the runtime), ADR-0003 (immutability)
