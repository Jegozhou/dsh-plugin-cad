---
name: mechanical-design-review
description: |
  Review a CAD part modelled with dsh-plugin-cad and report findings that trace to recorded checks and measured values: validity, single-solid and watertightness, bounding box, feature effects, wall thickness warnings, plus mechanical-design and DFM heuristics you apply as judgement. Use when the user asks to check, review, sanity-check or critique a model, or before exporting. This skill never computes geometry and cannot certify manufacturability. Not for modelling new parts (use parameterized-cad-design) and not for assemblies.
---

# Mechanical design review

You review what the plugin **measured**, add engineering judgement on top, and
say which is which. Every finding must name its source: a validation check id, a
number from the geometry report, or an explicitly labelled heuristic. You do not
compute geometry and cannot certify a part for manufacture.

> **Scope: P0 is a single part.** Review one solid. There are no assemblies,
> drawings, tolerances stack-ups or DFM rule packs (the latter is a P1 candidate
> that requires a reviewed spec). Say so if asked.

## Tools you use

| purpose | tool | what you get |
| --- | --- | --- |
| read the model and report | `cad_inspect_model` | metadata + geometry report; `include:"document"` adds parameters/features; `"full"` adds history |
| re-run checks | `cad_validate_model` | check results without creating a revision; optional `checks` subset |
| re-check a candidate document | `cad_validate_model` with `document` | structural validation of an edit before committing it |
| visual check | `cad_render_preview` (`view: iso\|front\|top\|right`) | SVG technical projection for the user to look at |
| history | `cad_inspect_model` `include:"full"`, `history_limit` | what changed between revisions |

The report is the evidence. If a check is not in the report and not re-runnable
with `cad_validate_model`, you cannot claim it passed.

## Review workflow

1. **Locate the model.** `cad_list_models` if the id is not in context; note
   whether the latest revision is `ready` or `failed`. A failed revision is never
   current — review the current successful revision and say if a newer one failed.
2. **Pull the report** with `cad_inspect_model`. Record: volume, surface area,
   bbox, centroid, topology counts (faces/edges/vertices/solids), per-check
   status, warnings, timings.
3. **Confirm the checks.** The check ids are:
   `document_schema`, `single_solid`, `brep_valid`, `positive_volume`,
   `closed_shell`, `bounding_box`, `feature_effects`, `wall_thickness` (warn
   only). Re-run with `cad_validate_model` if any are missing or stale.
4. **Verify intent separately from validity.** Compare bbox and feature results
   against the user's stated dimensions. A valid solid can still be the wrong
   part. Quantities worth quoting: `bbox size`, `volume`, `hole count` implied by
   `feature_effects`, symmetry of the centroid.
5. **Apply design heuristics** (below) and label them as judgement.
6. **Report** as: *verified by checks*, *observed from the report*,
   *heuristic/opinion*, *not checkable in P0*. Recommend concrete parameter edits
   rather than vague advice.

## What the checks mean (and what they do not)

| check | pass means | does not mean |
| --- | --- | --- |
| `single_solid` | exactly one solid in the result | the shape is what the user wanted |
| `brep_valid` | OCCT considers the B-rep valid | the mesh is watertight |
| `closed_shell` | triangulated mesh is watertight after welding | the part is printable/watertight in every slicer |
| `positive_volume` | `volume > 0` | the volume is in tolerance |
| `feature_effects` | subtractive features actually removed material (face/cylinder counts changed) | the hole is at the right position — check `at`/pattern inputs |
| `bounding_box` | every dimension ≤ `maxBoundingBoxMm` (default 2000 mm) | the part fits the printer/machine |
| `wall_thickness` | *warn*: no material thinner than 0.2 mm around a hole edge | the wall is manufacturable — 0.2 mm is the plugin's floor, not a process floor |

## Heuristics you may apply (label them as judgement)

- **Material at holes:** ≥ 1 × hole diameter from hole edge to the nearest outer
  edge for machined parts; ≥ 0.8 × diameter for printed parts.
- **Minimum wall:** 0.8–1.0 mm printed (FDM), 1.5–2 mm machined aluminium; below
  that, flag it even if `wall_thickness` only warns at 0.2 mm.
- **Fillet radius:** ≤ half the thinner adjacent wall; fillets on mating faces or
  hole rims are usually a defect, not a feature.
- **Hole aspect ratio:** depth/diameter > 5 is hard to drill; > 10 needs a
  specialised process — flag, don't block.
- **Symmetry and datum:** centroid near the origin for symmetric parts; a
  parameter change that shifts the centroid sideways often means an asymmetric
  pattern or a hole placed from the wrong edge.
- **Sharp internal corners:** for machined parts, internal corners need a tool
  radius; a chamfer/fillet `target: vertical_edges` is the usual fix.
- **Thin flanges / blade-like features:** anything under ~0.5 mm on a long span
  is a handling risk; the bbox/volume alone will not reveal it, so say it is a
  judgement based on the document features.

## Output format

```markdown
## Review — <model_id> revision <r-…>
**Verified by checks:** single_solid PASS, brep_valid PASS, closed_shell PASS,
positive_volume PASS (volume 27,4xx mm³), bounding_box PASS (80×60×8).
**Observed:** 4 corner holes + 1 centre hole present (feature_effects); centroid
(0.0, 0.0, 4.0).
**Heuristic:** corner holes Ø6 inset 12 mm leave 9 mm to the edge — safe.
**Not checkable in P0:** surface finish, tolerance stack-up, assembly fit.
**Recommended edit:** none / `cad_modify_model {parameters:{thickness:10}}` …
```

Quote numbers from the report; never invent a measurement. If the user asks
"will this pass my CNC shop's DFM rules?", the answer is: P0 has no DFM rule
packs; here are the checks it did run and here are engineering rules of thumb,
not a sign-off.

## Do not

- Do not certify manufacturability or safety-critical fitness.
- Do not claim a check passed without the report/`cad_validate_model` output.
- Do not review an assembly — P0 has no assembly model; review each part and say
  interface consistency is unverified.
- Do not conflate `wall_thickness` warn (0.2 mm floor) with manufacturing limits.
