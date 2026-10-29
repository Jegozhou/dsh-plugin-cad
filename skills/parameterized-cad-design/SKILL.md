---
name: parameterized-cad-design
description: |
  Turn a described mechanical part into a parametric CAD document and a real B-rep model using the native dsh-plugin-cad tools: choose parameters, order features, build, validate, and iterate by changing values instead of rewriting geometry. P0 covers single parts only — no assemblies, no drawings, no freeform surfaces. Use when the user asks to create, modify or parameterise a single part (bracket, plate, spacer, flange, housing, mount). Do not use for assemblies, sheet metal, CAM output or engineering drawings.
---

# Parameterised CAD design (single part)

You describe the part as a **declarative document** (named parameters + an ordered
feature list). The plugin's Python runtime builds the geometry; **you never write
or run CAD code, and neither this skill nor you computes geometry**. Your job is
dimensional intent and feature order.

> **Scope: P0 is a single part.** One solid, one model, one bbox. There are no
> assemblies, mates, drawings, sheet metal, sweeps/lofts or imported STEP. If the
> request is multiple parts, use the `assembly-design` skill (decompose into
> separate single-part models) and say plainly that no assembly is modelled.

## Tools you use

| step | tool | why |
| --- | --- | --- |
| create | `cad_create_model` | first revision from a document |
| change a dimension | `cad_modify_model` with `parameters` | the normal edit; reuses the same features |
| structural edit | `cad_modify_model` with `add_features` / `remove_features` | add/remove ops (no auto-rewrite of dependants) |
| read back | `cad_inspect_model` (`include:"document"`) | see parameters/features you or a previous turn wrote |
| check without saving | `cad_validate_model` | structural + geometry checks before committing |
| confirm it exists | `cad_list_models` | find the `model_id` / revision in a later turn |
| heavy build | `cad_create_model` / `cad_modify_model` with `background:true`, then `cad_get_job_status` | long builds must not block the turn |

Revision discipline: every mutation needs `expected_revision` from the last read.
A `revision_conflict` is normal — re-read with `cad_inspect_model` and retry.
Pass `request_id` when a call may be retried, so a replay does not create two
revisions.

## Workflow

1. **Extract dimensions.** Name every dimension the user gave, with units in mm.
   If a dimension is missing, either ask or state the assumption explicitly in
   `description` and in your reply. Never silently invent a critical dimension.
2. **Write the document.** `schema: "dsh.cad/document@1"`, `units: "mm"`,
   `parameters` for every dimension that could plausibly change, then `features`
   in construction order (base material first).
3. **Create** with `cad_create_model` (`build` defaults to true). Success returns
   `model_id`, the revision and an artifact/report summary — not bytes.
4. **Validate / repair.** On `invalid_document`, read `details.path` and fix that
   exact field. On `invalid_geometry` or `build_failed`, read the failed checks in
   `details` and change the feature order or dimensions — do not retry blindly.
5. **Iterate by parameters.** "Make it 10 mm longer" is `cad_modify_model
   {parameters:{length:90}, expected_revision:N}`, not a new model.
6. **Report** what changed, the resulting bbox/volume from the report, and the
   revision id. Never claim a dimension was achieved unless the report shows it.

## Document shape

```jsonc
{
  "schema": "dsh.cad/document@1",
  "units": "mm",
  "parameters": { "length": 80, "width": 60, "thickness": 8 },
  "features": [
    { "id": "base",   "op": "box", "length": "$length", "width": "$width", "height": "$thickness" },
    { "id": "center", "op": "hole", "diameter": 20, "at": [0, 0], "through": true },
    { "id": "corners","op": "hole_pattern", "pattern": "rect_corners",
      "diameter": 6, "inset": 12, "span": ["$length", "$width"], "through": true }
  ]
}
```

Rules that matter: numeric fields are a number or `"$name"`; parameter names
`^[A-Za-z][A-Za-z0-9_]{0,39}$`; 1..64 features with unique ids; unknown op/field
or a dangling `$name` is rejected as a whole document (no partial build).

### Feature catalogue (P0)

| op | key fields | notes |
| --- | --- | --- |
| `box` | `length`, `width`, `height`, `center?` | first material; centred on origin unless `center` |
| `cylinder` | `diameter`, `height`, `center?`, `axis?` (z default) | additive |
| `hole` | `diameter`, `at:[x,y]?`, `through?` (default true), `depth?` when not through, `axis?`, `face?` (top/bottom) | subtractive |
| `hole_pattern` | `pattern`: `rect_corners` \| `grid` \| `bolt_circle`; `diameter`; `inset`+`span` (corners), `count:[nx,ny]`+`spacing` (grid), `count`+`pitch_diameter`+`center` (bolt circle); `through` | subtractive, N holes in one op |
| `fillet` | `radius`, `target` ∈ `vertical_edges` (default) \| `top_edges` \| `bottom_edges` \| `all_edges` | apply late; large radii on thin walls fail |
| `chamfer` | `distance`, same `target` vocabulary | apply late |
| `cut` | `shape` = `{op:"box"\|"cylinder", …}` | boolean subtract one primitive |
| `union` | `shape` = `{op:"box"\|"cylinder", …}` | boolean add one primitive |

Coordinates: millimetres, right-handed, **Z up**; angles in degrees. "Through
hole" means normal to the face and through the whole body.

## Parameter conventions (use them, they keep `cad_modify_model` cheap)

- One parameter per editable dimension, named for the feature: `length`,
  `width`, `thickness`, `hole_d`, `center_hole_d`, `inset`, `fillet_r`.
- Do not put a literal in a feature that the user might change — reference it.
- Keep the list short (≤ 12 for a simple part); parameters that never change are
  literals, not parameters.
- Default the part to a sensible datum: base centred on the origin, thickness in
  +Z, so the viewer and downstream exports agree.

## Heuristics (design guidance, not validation)

These are rules of thumb for proposing values and flagging risk. The plugin
reports what it measured; it does **not** guarantee manufacturability.

- **Hole vs edge:** leave at least `1 × diameter` of material from a hole edge to
  the nearest outer edge (thin walls < 0.2 mm are flagged as a *warn* by the
  `wall_thickness` check).
- **Corner holes:** inset ≥ `0.5 × diameter + 1 mm` is a safe starting point;
  the acceptance bracket uses Ø6 holes inset 12 mm on an 80×60 plate.
- **Fillet:** start at ≤ `min(thickness, 0.2 × min(length, width))`; fillets on
  through-hole rims or coincident edges are a common build failure — apply them
  after all cuts, and if it fails, reduce radius before reordering.
- **Feature order:** additive base → additive bosses → subtractive holes/patterns
  → edge treatments (fillet/chamfer). A cut after a fillet can leave a sliver.
- **Symmetry:** centre patterns on the origin; prefer `rect_corners` with a
  symmetric `span` over four separate `hole` ops.
- **Thin parts:** thickness < 1 mm on a 60+ mm span will be floppy in reality;
  mention it, but still build what was asked.

## Failure playbook

| error code | meaning | do |
| --- | --- | --- |
| `invalid_document` | schema/grammar violation | fix the field at `details.path`; no revision was created |
| `invalid_argument` | edit would be nonsensical (unknown parameter, non-positive dimension, hole larger than part) | fix the parameter; no revision was created |
| `revision_conflict` | `expected_revision` is stale | `cad_inspect_model`, then retry with the current revision |
| `invalid_geometry` / `build_failed` | the kernel built something invalid | read the failed checks (`single_solid`, `brep_valid`, `positive_volume`, `closed_shell`, `feature_effects`), then adjust features |
| `runtime_unavailable` / `runtime_crashed` | Python runtime not ready / died | call `cad_runtime_status`; if it reports the runtime is missing, tell the user the one-time setup command from the README — do not loop |
| `timeout` | build exceeded `buildTimeoutMs` | simplify the part or use `background:true`; report honestly |

Never retry the same failing call more than once without changing an input.

## Do not

- Do not generate Python/build123d code, and do not claim the model is "correct"
  without a report/check that says so.
- Do not create a second model to represent an edit — that breaks revision history.
- Do not describe the model as an assembly, and do not promise drawings or DFM
  sign-off.
- Do not inline artifact bytes in your answer; reference the model/revision and,
  if the user wants files, use `cad_export_model`.
