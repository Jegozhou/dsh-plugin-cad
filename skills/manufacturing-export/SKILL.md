---
name: manufacturing-export
description: |
  Export validated dsh-plugin-cad parts as real engineering files: STEP for CAD/CAM downstream, STL for slicing, GLB for viewing, and SVG technical previews — with workspace-confined output paths, no silent overwrites, and honest reporting of what each file is and is not. Use when the user asks to export, download, hand off to a shop/printer, or produce a drawing-like view. P0 exports single parts only; no assemblies, no GD&T drawings, no CAM toolpaths. Not for modelling.
---

# Manufacturing export (single part)

Export is a **copy of already-built artifacts** plus a technical preview. You do
not convert geometry, you do not post-process meshes, and this skill does not
compute anything — it picks formats, paths and verification.

> **Scope: P0 is a single part.** No assembly STEP structure, no 2D drawing with
> dimensions/GD&T, no CAM output, no sheet metal flat pattern. Say this plainly
> when the user asks for them; they are P1/P2 candidates requiring a reviewed
> spec.

## Tools you use

| need | tool | notes |
| --- | --- | --- |
| confirm the revision is good | `cad_inspect_model`, `cad_validate_model` | export the current successful revision; never export a `failed` one |
| export files | `cad_export_model` | `formats` ∈ `step`, `glb`, `stl`; default `["step","glb"]` |
| put files in the workspace | `cad_export_model` with `output_path` | workspace-relative directory; must not escape the workspace |
| overwrite an existing file | `cad_export_model` with `overwrite:true` | only after the user agrees; otherwise the call is refused |
| drawing-like view | `cad_render_preview` | SVG technical projection, `view: iso\|front\|top\|right` |
| verify the set | `cad_list_models`, `cad_inspect_model` | revision + artifact sha256/bytes are the receipt |

## Workflow

1. **Pick the revision.** Read the current revision. If it is `ready`, export it.
   If the latest revision failed, export the previous successful one and say so.
2. **Validate first** (`cad_validate_model`) when the user's goal is manufacture.
   Do not export an unvalidated model as "ready for manufacturing".
3. **Choose formats by destination:**
   - **STEP** — the exchange format for CAD/CAM/other engineers. This is the one
     to hand off. It is an ISO 10303-21 exchange file; the current writer emits
     the **AP214 `AUTOMOTIVE_DESIGN`** schema (verified, `tests/e2e/verify-artifacts.mjs`),
     so you may say "STEP AP214". Do not claim AP242 or any schema the verifier
     has not confirmed.
   - **STL** — for slicing/3D printing. Mesh, not B-rep: no units metadata you can
     rely on, no features; tell the user to check scale in the slicer.
   - **GLB** — for viewing/embedding; it is the viewer's format, not a
     manufacturing format.
4. **Choose the path.** Use a workspace-relative directory, one per model and
   revision when the user needs traceability, e.g.
   `exports/bracket/rev-0002/`. Paths outside the workspace are rejected
   (`path_escape`); this is a security control, not a bug.
5. **Never overwrite silently.** First export without `overwrite`; if the file
   exists, tell the user and ask, then re-export with `overwrite:true`.
6. **Verify and report.** For each artifact, report `format`, `bytes`, `sha256`
   and the written path from the tool result. A file the user cannot trace to a
   revision + hash is not delivered.
7. **Preview on request** with `cad_render_preview` (SVG). Multiple views
   (`front`, `top`, `right`, `iso`) are four calls, not a multi-view drawing. The
   SVG is a projection for humans — not a dimensioned drawing.

## Report template

```markdown
Exported <model_id> revision <r-0002> to `exports/bracket/rev-0002/`:
| file | format | bytes | sha256 (first 12) |
| model.step | STEP (ISO 10303-21) | 41,2xx | 9f3c… |
| model.stl  | STL (mesh)          | 88,1xx | 1a02… |
Verified: single_solid PASS, brep_valid PASS, closed_shell PASS.
Not included (P0): assembly structure, GD&T drawing, CAM toolpaths, material.
```

If the tool refuses (`too_large`, `path_escape`, existing file), report the
error code and the corrective action — do not retry with a different path
silently to defeat the control.

## Export heuristics (judgement, not guarantees)

- **Units:** the document is millimetres; STEP carries mm. STL does not — always
  tell the user to confirm scale before printing.
- **Tessellation vs. quality:** GLB/STL are tessellated; curved faces (holes,
  fillets) are faceted. Do not claim "exact" surfaces from a mesh; STEP is the
  exact B-rep.
- **Minimum features for downstream processes** (ask, don't assume): FDM nozzle
  0.4 mm → features < 0.8 mm will vanish; CNC → internal corners need tool
  radius; sheet metal is out of scope.
- **Hole callouts:** in P0 the user must read hole diameter/position from the
  parameter list or preview; there is no annotated drawing. Offer the SVG views
  plus a written table instead, and say it is not a drawing.
- **Naming:** `model.step` / `model.stl` / `model.glb` inside the revision
  context is traceable; if you rename on copy, keep the revision in the path.
- **Deliver the receipt:** revision id + sha256 is what lets another person prove
  they machined the version you reviewed.

## Do not

- Do not export artifact bytes inline, base64, or as a data URL — you only ever
  get file paths and hashes.
- Do not claim a STEP file was opened/verified by a third-party CAD application
  unless a recorded run says so. The plugin's own verification is structural
  (re-import + ISO-10303-21 checks), not "SolidWorks opened it".
- Do not promise drawings, DFM sign-off, tolerances, surface finish or material
  specification.
- Do not produce an "assembly STEP" by exporting several parts and calling it one.
