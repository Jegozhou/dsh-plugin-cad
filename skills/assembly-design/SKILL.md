---
name: assembly-design
description: |
  Handle multi-part mechanical requests with dsh-plugin-cad when the plugin's P0 scope is single parts only: decompose an assembly into individually modelled parts, keep shared interface dimensions consistent, and report mate intent as text rather than fake geometry. Use when the user asks for an assembly, a multi-part product, a fit between parts, or bolt/hole interfaces. P0 does not implement assemblies or mates — this skill prevents pretending otherwise. Not for single-part modelling (use parameterized-cad-design) or for drawings.
---

# Assembly design with a single-part plugin (P0 reality)

**P0 has no assemblies, no mates, no exploded views and no interference checks.**
One model is one solid part. This skill exists so that an assembly request is
handled honestly and usefully:

1. turn the request into a set of **single-part models** with consistent
   interfaces, and
2. state clearly that the *assembly* exists only as a design intent in text —
   not as modelled geometry.

If the user needs true assembly modelling (constraints, motion, interference),
say it is a planned P1 capability that requires a reviewed specification, and is
not available now. Do not fake it.

## Tools you use

| need | tool | note |
| --- | --- | --- |
| create each part | `cad_create_model` | one call per part, own `model_id` |
| adjust a part | `cad_modify_model` with `parameters` | keeps the interface value in one place per part |
| inventory the parts | `cad_list_models` | enumerate what exists before claiming a set is complete |
| check a part | `cad_validate_model`, `cad_inspect_model` | per-part validity |
| export | `cad_export_model` | per part; do not promise an assembly file |

There is no tool that joins two models. Do not imply one exists.

## Workflow

1. **Decompose.** List parts with an id scheme: `part-01-base`, `part-02-bracket`,
   `part-03-pin`. Every part gets its own model; name it with the part number.
2. **Extract the interface contract first.** Before modelling anything, write
   down the shared numbers in the reply: hole pattern (pitch, diameter, count),
   mating faces, thickness at the joint, clearance class. These are the values
   that must be identical across part models.
3. **Record mate intent in text.** Put it in each model's `description` and in
   your answer, e.g. "part-02 bottom face mates part-01 top face; 4 × Ø6.6
   through holes on a 60×40 pattern, ±0.2 mm position". This is the only place
   the assembly exists in P0 — say so.
4. **Model each part** with the `parameterized-cad-design` workflow, one tool call
   each. Reference the interface numbers as parameters (`bolt_pitch`, `bolt_d`,
   `clearance_d`) so a design change is one edit per part.
5. **Verify the set.** `cad_list_models` must show exactly the parts you claim;
   each must have a successful current revision. Report per-part bbox/volume.
6. **Export per part**, then tell the user the parts are separate files and no
   assembly/STEP-AP242 assembly structure is produced.

## Interface heuristics (rules of thumb — verify, don't assume)

Use these to propose numbers; label them as proposals, not measurements.

- **Clearance holes** (metric, medium fit): M3 → Ø3.4, M4 → Ø4.5, M5 → Ø5.5,
  M6 → Ø6.6, M8 → Ø9.0. The acceptance bracket's Ø6 holes are for M5-class
  fasteners only if you size the bolt accordingly — 6.0 mm is a *close* clearance
  for M6, so call it out.
- **Position tolerance:** for pinned interfaces, hole-to-hole position tolerance
  is typically ±0.1 mm for a CNC-machined match; 3D-printed parts need more
  (0.2–0.4 mm) — ask about the process before prescribing.
- **Mating faces:** keep contact faces flat and coplanar; avoid modelling
  fillets on a mating face (they create a gap). Chamfer instead.
- **Bolt pattern:** prefer `hole_pattern` `rect_corners` or `bolt_circle` with a
  `pitch_diameter` so all parts share the same pattern definition.
- **Minimum engagement:** thread engagement ≈ 1 × diameter in aluminium, 1.5 × in
  plastics; this drives plate thickness at the joint.
- **Stack-up:** state assumed thickness tolerance (±0.1 mm machined, ±0.2 mm
  printed); if the user needs a real stack-up analysis, say it is out of scope.

## What to tell the user (template)

> Modelled N separate single-part models: … Each is a valid single solid with the
> dimensions below. The assembly intent (mates, bolt pattern, clearances) is
> recorded in each model's description and in this message. **dsh-plugin-cad P0
> does not model assemblies or mates**, so there is no assembly file, no
> interference check and no exploded view: those are P1/P2 candidates that need a
> reviewed spec before they exist.

Never omit that paragraph when the user asked for an assembly.

## Do not

- Do not claim an assembly was created, checked or exported.
- Do not model one "assembly" solid by fusing parts and call it an assembly.
- Do not invent mate constraints the plugin cannot store; put intent in text.
- Do not silently change one part's interface dimension without updating the
  others and saying so.
