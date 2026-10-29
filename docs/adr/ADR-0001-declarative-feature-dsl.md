# ADR-0001 — Declarative feature DSL instead of agent-supplied code execution

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead (architecture), host-eng, runtime-eng
- **Milestone:** P0 (M0–M5)
- **Supersedes:** none

## Context

The product slice is a Harness user describing a mechanical part in natural
language, which an agent turns into CAD and the Harness renders. The obvious
implementation family is *code execution*: the agent writes a Python/JS script
using a modelling library, the plugin runs it, and the file is the model. That
family was considered and rejected for this plugin.

Pressures against code execution:

1. **Trust.** Agent-authored source executed on the user's machine, under the
   user's uid, is arbitrary code execution by construction. The Harness tool
   pipeline is where approvals live (`docs/research/DSH_PLUGIN_API_NOTES.md` §3:
   "permissions, approvals, timeouts and cancellation are applied by the
   harness"), but a tool that executes generated code makes every CAD call a
   code-execution event; the harness cannot meaningfully approve "geometry".
2. **Determinism and testability.** A model must be reproducible from a stored
   document. A script can branch on environment, read files, call the network,
   and produce different geometry on replay, which makes revision comparison and
   the artifact sha256 record meaningless.
3. **Validatable input.** A structured document can be validated *before* any
   geometry work (and before a revision exists), so the viewer can never see a
   half-broken revision. Arbitrary code can only be validated by running it.
4. **Error contract.** The agent needs stable, machine-readable failures
   (`invalid_document` with `details.path`) rather than a Python traceback. A
   closed grammar produces those; arbitrary code does not.
5. **Editing model.** The common operation is *change one dimension*, not *rewrite
   the program*. A parameterised document makes that a value edit with
   optimistic concurrency, and keeps feature intent visible to the viewer and to
   the agent's next turn.

## Decision

The model is a **declarative, closed-schema document**
`dsh.cad/document@1`: named scalar `parameters` plus an ordered `features`
array drawn from a fixed catalogue of eight ops (`box`, `cylinder`, `hole`,
`hole_pattern`, `fillet`, `chamfer`, `cut`, `union`). Numeric fields accept a
number or a parameter reference `"$name"`. The runtime interprets the document;
it never `eval`s or `exec`s anything from the agent.

- Grammar, limits and rejection rules: `docs/research/SPEC_P0.md` §3 and §3.1
  (unknown `op`, unknown field, unknown parameter reference, duplicate feature
  id, non-finite values → `invalid_document`, no partial application).
- Model-facing JSON Schema: `src/contracts/tools.js` (`document`, `feature`,
  `TOOL_SCHEMAS`), which is strict (`additionalProperties: false`).
- P0 explicitly has **no expression language, no script execution, no file
  import, no network** (`docs/research/SPEC_P0.md` §3.1, §8).

Adding an op is a spec + schema + runtime change, reviewed as such — it is not
something an agent can do at runtime.

## Consequences

**Positive**

- The trust boundary is data, not code: the runtime's input surface is a
  validated JSON document with a bounded feature count (1..64) and bounded
  numeric fields. There is no interpreter to sandbox.
- Documents are diffable, storable, replayable and hashable; a revision is a
  document snapshot plus a build report, which the viewer and `cad_inspect_model`
  can both read.
- Failures are typed (`src/contracts/errors.js` → `CAD_ERROR_STATUS`), so the
  agent can repair a document instead of parsing a traceback.
- Parameter-only edits (`cad_modify_model` with `parameters`) are the cheap,
  common path.

**Negative / accepted costs**

- **Expressiveness is bounded.** Freeform parts (sweeps, lofts, text, imported
  STEP) are not expressible in P0. This is a deliberate scope cut, listed as a
  non-goal in `docs/ARCHITECTURE.md` and tracked as P1/P2 in
  `docs/IMPLEMENTATION_PLAN.md`.
- Every new capability costs a spec revision, not just a prompt. That is the
  point, but it slows feature growth.
- The host must own document validation and feature-edit merging
  (`add_features` / `remove_features`), because the runtime is not allowed to be
  the first validator.

## Alternatives considered

- **Agent-authored Python (rejected).** Maximum expressiveness, but see
  pressures 1–5; also makes the "same document, new revision" model impossible.
- **Agent-authored TypeScript in the client (rejected).** Same trust problem,
  plus geometry does not belong in the browser.
- **Template gallery / fixed part families (rejected for P0).** Safe but cannot
  answer the acceptance part ("a bracket, then the same bracket with modified
  parameters") without a template that already is the answer.
- **Untyped "JSON blob passed to the runtime" (rejected).** The schema and the
  closed catalogue are what make the other ADRs — revision identity, atomic
  failure, typed errors — implementable.

## References

- `docs/research/SPEC_P0.md` §3, §3.1, §8
- `src/contracts/tools.js` — `TOOL_SCHEMAS`, `document`, `feature`
- `src/contracts/errors.js` — `CAD_ERROR_STATUS`
- `docs/research/DSH_PLUGIN_API_NOTES.md` §3 (harness owns approvals)
- Related: ADR-0002 (runtime boundary), ADR-0003 (revisions), ADR-0006 (clean room)
