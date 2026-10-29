# ADR-0006 — Clean-room posture: functionality-level independence, honestly scoped

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead, all owners
- **Milestone:** P0 (M0–M5)

## Context

The project brief names an upstream reference project
(`earthtojake/text-to-cad`) as a **functional target**: the replacement should
deliver the same class of capability as a native DeepSeek Harness plugin. It is
not a code source.

Three facts shape the decision:

1. The reference is not part of this repository, and no one on the team cloned,
   fetched, read or executed it. There is no local copy to consult, by design.
2. Clean-room design needs a *specification* to build from. Without one, "we
   didn't look" degrades into "we guessed", which produces invented behaviour
   that cannot be reviewed or tested.
3. A claim of clean-room status that cannot be audited is worse than no claim,
   because it implies an assurance the team cannot actually give: nobody here has
   verified the reference's internals to prove non-derivation at the
   implementation level.

## Decision

1. **The reference project is excluded from the process.** No clone, fetch,
   read, unpack, execution or transcript inclusion at any point. If a future
   contributor needs it, that is a scope change requiring a new decision record,
   not a silent action.
2. **`docs/research/SPEC_P0.md` is the stand-in specification.** It is written
   only from the brief's task definition, general CAD knowledge, the public
   build123d/OpenCASCADE APIs and black-box experimentation in this workspace
   (`SPEC_P0.md` header). It is authoritative for P0, and where it could not pin
   down reference behaviour it lists the gap as *unverified* (§9) rather than
   inventing details.
3. **Only these sources were consulted** (recorded in
   `docs/CLEAN_ROOM_PROVENANCE.md`):
   - the installed DeepSeek Harness SDK and type definitions, read from the
     packaged `app.asar` runtime (the authoritative copy on this machine), and
     upstream DeepSeek Harness documentation fetched from
     `github.com/deepseek-ai/deepseek-harness`;
   - two **installed third-party Harness plugins** (`dsh-excalidraw`,
     `dsh-plugin-bidkit`) used purely as *host-API usage references* (how to
     register a tool, a job, a slot, a route), never as CAD design sources;
   - public build123d / OpenCASCADE / three.js documentation and the libraries'
     own installed sources, for the geometry and rendering APIs.
4. **The claim is scoped to functionality.** The honest statement — repeated in
   `docs/CLEAN_ROOM_PROVENANCE.md` and the README — is: this is a
   **functionality-level clean-room replacement**, *not* a verified clean-room
   reimplementation of the reference's internals. The team did not inspect the
   reference, so it cannot certify internal non-similarity.
5. **Unverified reference features stay unimplemented.** Feature families the
   brief names without defining (assemblies, drawings, DFM packs, extra formats,
   incremental optimisation) are tracked as P1/P2 **candidates** in
   `docs/IMPLEMENTATION_PLAN.md` with the note *requires an independently
   reviewed spec before implementation*. No code or doc claims to implement them.

## Consequences

**Positive**

- The repository is auditable: every doc can cite a file, command or recorded
  output inside it, and the provenance record names exactly what was consulted.
- No steering from the reference's decisions: the document schema, op catalogue,
  revision model and tool surface were derived from the brief and from host
  constraints, not copied.
- Unverifiable behaviour is visible instead of hidden — gaps are defects to be
  specified later, not surprises.

**Negative / accepted costs**

- **Unknown-unknowns.** The reference may do things the brief does not mention;
  this project will not have them until someone writes an independent spec.
- **No benchmark parity by construction.** Performance and UX comparisons against
  the reference cannot be made honestly and are not claimed.
- **The provenance record is a maintenance obligation.** New tools, assets or
  dependencies that are third-party must be added to
  `THIRD_PARTY_NOTICES.md` and, if they are design sources, reconsidered here.

## Alternatives considered

- **Clone the reference and rewrite with rename (rejected).** That is a port, not
  a replacement, and it would put derivative code into a differently-licensed
  deliverable.
- **Ignore the reference entirely and "just build something" (rejected).** Without
  a spec there is no acceptance surface; scenario C's dimensions would have no
  definition.
- **Claim full clean-room status (rejected).** Not auditable — see pressure 3.
  Overclaiming is a defect in the deliverable, not a marketing choice.
- **Read only the reference's README for scope (rejected).** Even scope-reading
  is contamination under the stated rule; the brief already provides the scope.

## References

- `docs/research/SPEC_P0.md` (header, §9)
- `docs/CLEAN_ROOM_PROVENANCE.md` — the dated provenance record
- `docs/IMPLEMENTATION_PLAN.md` — P1/P2 candidates with the reviewed-spec gate
- `THIRD_PARTY_NOTICES.md` — third-party licences actually in use
- `docs/research/DSH_PLUGIN_API_NOTES.md` — the host sources that *were* consulted
