# P0 autonomous specification (clean-room)

**Status:** authoritative for this milestone. Written **only** from the task
definition in the brief, general CAD knowledge, the build123d/OpenCASCADE public
APIs and black-box experimentation in this workspace. The upstream reference
project was **not** cloned, fetched, read or executed; no file of it entered any
agent context. See `docs/CLEAN_ROOM_PROVENANCE.md`.

Anything the brief describes that this spec could not independently pin down is
listed in §9 as **unverified reference behaviour** and is **not implemented**
rather than guessed.

## 1. Product slice

A harness user (through the DSH agent) describes a mechanical part in natural
language. The agent turns it into a **structured, declarative CAD document**
(parameters + ordered features). Native DSH tools persist the document, ask a
long-lived Python runtime (build123d → OpenCASCADE) to build a real B-rep,
validate it, and export engineering artifacts (STEP / GLB / STL / SVG). The
Harness Web UI shows the model in an in-Harness 3D viewer, and a parameter change
produces a new immutable revision that the viewer picks up.

Acceptance part for the whole milestone: a **rectangular mounting bracket**
80 × 60 × 8 mm with a Ø20 mm central through-hole and four Ø6 mm corner holes
inset 12 mm from the edges, then the same part with modified parameters.

## 2. Units and coordinate conventions

* Units are millimetres for every length, always. The document declares
  `"units": "mm"`; nothing else is accepted in P0.
* Right-handed coordinate system, **Z is the extrusion/viewer up axis**.
* A primitive is centred on the origin unless `center` is given.
* "Through hole" means a cylindrical cut normal to the face, spanning the whole
  solid, so the resulting body stays a single solid with a tunnel.
* Every angle is in degrees.

## 3. Document format (`dsh.cad/document@1`)

```jsonc
{
  "schema": "dsh.cad/document@1",
  "units": "mm",
  "parameters": { "length": 80, "width": 60, "thickness": 8 },
  "features": [
    { "id": "base", "op": "box", "length": "$length", "width": "$width", "height": "$thickness" },
    { "id": "center_hole", "op": "hole", "diameter": 20, "at": [0, 0], "through": true },
    { "id": "corner_holes", "op": "hole_pattern", "pattern": "rect_corners",
      "diameter": 6, "inset": 12, "span": ["$length", "$width"], "through": true }
  ]
}
```

Rules:

* `parameters` — object of **finite numbers** only. Names match
  `^[A-Za-z][A-Za-z0-9_]{0,39}$`. At most 64 parameters.
* A numeric field may be a number or a parameter reference string `"$name"`.
* `features` — ordered, 1..64 entries, each with a unique `id`
  (`^[A-Za-z][A-Za-z0-9_-]{0,39}$`). Features are applied in order to a single
  body; the body starts empty and the first feature must create material.
* Unknown feature `op`, unknown field on a feature, unknown parameter reference,
  duplicate feature id, non-finite or negative-where-invalid numeric → the
  document is rejected with `invalid_document` and a `details.path` pointing at
  the offending field. There is no partial application.

### 3.1 Feature catalogue (P0)

| `op` | fields | meaning |
| --- | --- | --- |
| `box` | `length`, `width`, `height`, `center?` | add an axis-aligned box |
| `cylinder` | `diameter`, `height`, `center?`, `axis?` (`z` default, `x`, `y`) | add a cylinder |
| `hole` | `diameter`, `at` `[x,y]`? (default `[0,0]`), `through`? (default `true`), `depth`? (when not through), `axis`? (`z` default), `face`? (`top` default / `bottom`) | subtract a cylindrical hole |
| `hole_pattern` | `pattern` ∈ `rect_corners` \| `grid` \| `bolt_circle`, `diameter`, … | subtract N holes |
| `fillet` | `radius`, `target` ∈ `vertical_edges` (default) \| `top_edges` \| `bottom_edges` \| `all_edges` | round edges |
| `chamfer` | `distance`, `target` (same vocabulary as fillet) | chamfer edges |
| `cut` | `shape` `{op: box\|cylinder, …}` | boolean subtract an arbitrary primitive |
| `union` | `shape` `{op: box\|cylinder, …}` | boolean add an arbitrary primitive |

`hole_pattern` fields:

* `rect_corners`: `diameter`, `inset` (distance from each edge of `span`),
  `span` `[x,y]` (default: current body bounding box size), `through` (default
  `true`). Places exactly 4 holes at `(±(sx/2-inset), ±(sy/2-inset))`.
* `grid`: `diameter`, `count` `[nx, ny]` (2..10 each), `spacing` `[dx, dy]`,
  `center` `[0,0]`, `through`.
* `bolt_circle`: `diameter`, `count` (3..24), `pitch_diameter`, `center`
  `[0,0]`, `through`.

The catalogue is deliberately declarative: **no expression language, no script
execution, no file import, no network**. An agent cannot make the runtime run
arbitrary Python in P0.

## 4. Lifecycle model

```
model (stable id) ── has 1..N immutable revisions (monotonic integer)
   │                    └── each revision: document snapshot, geometry report,
   │                        artifact files, build status, timings, warnings
   └── currentRevision pointer + owner + timestamps
```

* `modelId` — `m-<10 hex>`; `revisionId` — `r-<4 digit>`.
* A revision is **immutable**. `cad_modify_model` writes revision N+1; nothing
  ever overwrites a file of an earlier revision.
* Writes are **optimistic-concurrency** protected: a mutating call must supply
  `expected_revision` matching the current pointer, otherwise
  `revision_conflict` with the current revision in `details`.
* `request_id` makes a mutating call idempotent: replaying the same
  `request_id` returns the already-created revision instead of creating a
  second one.
* Builds are serialised per model by a queue; `maxConcurrentBuilds` bounds the
  runtime globally (default 1) because one runtime process is stateful.

## 5. Build and validation

A build produces, in one runtime call:

1. **Geometry**: B-rep built from the document by build123d; must be a valid
   solid.
2. **Validation checks** (all reported, each `pass`/`fail`/`warn`):
   * `document_schema` — structural validation (see §3);
   * `single_solid` — exactly one solid in the result;
   * `brep_valid` — `Shape.is_valid`;
   * `positive_volume` — `volume > 0`;
   * `closed_shell` — the triangulated mesh is watertight after vertex welding;
   * `bounding_box` — every dimension ≤ `maxBoundingBoxMm` (default 2000);
   * `feature_effects` — per subtractive feature: the face count and the
     cylindrical faces matching the requested radius changed as expected
     (a Ø20 hole must really exist, not be silently absorbed);
   * `wall_thickness` — no material thinner than 0.2 mm around a hole
     (`hole_edge_to_bbox` ≥ 0.2 mm); a heuristic, reported as `warn` only.
3. **Artifacts**: `step` (always for a successful build), `glb` (always; this is
   what the viewer loads), `stl` (on request), `svg` (on request /
   `cad_render_preview`). Each artifact is written atomically inside the
   revision directory and recorded with byte size and sha256.
4. **Report**: volume, surface area, bbox, centroid, topology counts
   (faces/edges/vertices/solids), per-feature status, timings, warnings.

A document that fails structural validation never reaches the runtime. A build
that fails geometry validation leaves the previous revision as current, persists
the new revision as `failed` (with the report, for diagnosis), and returns
`invalid_geometry` / `build_failed` with the checks that failed.

## 6. Artifact access

Artifacts are addressed by stable reference, never inlined:

```jsonc
{ "artifactId": "m-1a2b3c4d5e:r-0002:glb", "format": "glb",
  "bytes": 31704, "sha256": "…", "url": "/dsh-plugin-cad/assets/models/m-1a2b…/r-0002/model.glb",
  "contentType": "model/gltf-binary" }
```

The viewer fetches `url` (same origin, harness-admitted). Tool results carry the
reference and never the bytes. The model store lives under
`<DSH_HOME>/cad/models/<modelId>/` by default; the plugin never deletes it on
disable/uninstall unless the user explicitly asks (documented in
`docs/SECURITY_MODEL.md`).

## 7. Editing semantics (M3)

`cad_modify_model` accepts:

* `parameters` — merge/replace named parameter values (the usual case: change
  `length`, re-run the same features);
* `add_features` / `remove_features` / `update_features` — structural edits;
* `layout` / `metadata` — free-form document metadata (name, description,
  tags).

Parameter edits are validated **before** the build: an edit that references an
unknown parameter, makes a dimension non-positive, or produces a hole larger
than the part is rejected with `invalid_argument` and a per-field message, and
**no revision is created** — so a viewer can never show a half-broken revision.

## 8. Non-goals for P0 (explicit)

* Assemblies/mates, drawings with dimensions/annotations, DFM rule packs, sheet
  metal, generative/topology optimisation, CAM output, user-supplied Python.
* Multi-user simultaneous editing of one model (single-writer optimistic
  concurrency only).
* Any network call, telemetry, or dependency installation initiated by the
  plugin at runtime.

## 9. Unverified reference behaviour (deliberately not specified)

The brief lists feature categories of the reference project (assemblies,
engineering drawings, DFM, extra formats, incremental optimisation) but does not
define their exact inputs, outputs or acceptance criteria. This spec does not
invent them; they are tracked as **P1/P2 candidates** in
`docs/IMPLEMENTATION_PLAN.md` with the note *requires an independently reviewed
spec before implementation*. No code claims to implement them.
