# ADR-0003 — Immutable revisions with optimistic concurrency and idempotent writes

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead, host-eng, client-eng
- **Milestone:** P0 (M0–M5)

## Context

Three requirements collide:

1. The in-Harness viewer must **never** display a half-built or half-edited model.
2. The agent's normal operation is "change `length` to 90", repeated — often
   several times in one turn, sometimes with a background build in flight.
3. Tool calls can be retried by the model, and harness job semantics mean an
   already-published job **outlives** the tool call that started it
   (`docs/research/DSH_PLUGIN_API_NOTES.md` §5). A retried or duplicated write
   must not create two revisions.

## Decision

A model is a **stable id** with an append-only sequence of **immutable
revisions**:

```
model (m-<10 hex>) ── 1..N revisions (r-0001, r-0002, …)
   │                     └── document snapshot + geometry report + artifact
   │                         files + status + timings + warnings
   └── currentRevision pointer, owner, timestamps
```

Rules:

- **A revision is immutable.** Writes create revision N+1; no file of an earlier
  revision is ever overwritten. Artifact files are written atomically inside the
  revision directory and recorded with byte size and sha256
  (`docs/research/SPEC_P0.md` §5, §6).
- **Optimistic concurrency at the tool boundary.** Every mutating call passes
  `expected_revision` (`src/contracts/tools.js`: `cad_modify_model` requires
  `model_id` + `expected_revision`). A mismatch is rejected with
  `revision_conflict` (HTTP 409, `src/contracts/errors.js`) and the current
  revision in `details`; the caller re-reads and retries. There is no lock
  protocol and no multi-user merge — single-writer optimistic concurrency only
  (`SPEC_P0.md` §8).
- **Idempotent replay.** A mutating call may carry `request_id`; replaying the
  same `request_id` returns the revision already created instead of creating a
  second one (`SPEC_P0.md` §4, `tools.js` `requestId`).
- **Validation precedes revision creation.** A parameter edit that references an
  unknown parameter, makes a dimension non-positive, or makes a hole larger than
  the part is rejected **before** a revision exists (`SPEC_P0.md` §7) — so the
  viewer can never observe a broken revision.
- **A failed build does not advance the pointer.** Geometry that fails validation
  is persisted as a revision with status `failed` (with the report, for
  diagnosis) while the previous revision stays current (`SPEC_P0.md` §5). The
  tool returns `invalid_geometry` / `build_failed`, which carries the failed
  check ids.
- **The viewer reads the current pointer**, fetches artifacts by reference
  (ADR-0005), and re-fetches when the pointer changes; it never composes a
  model locally.

## Consequences

**Positive**

- "The viewer shows the new revision" (brief scenario G) is a pointer change,
  not a mutation in place — old and new artifacts can coexist during the
  transition with no tearing.
- Every state the user ever saw is reconstructable from disk (`cad_inspect_model
  include:"full"` exposes history; `history_limit` bounds it).
- Retries are safe, which matters because retries are a model behaviour, not an
  exceptional path.
- The same mechanism makes artifact sha256 a meaningful integrity check.

**Negative / accepted costs**

- **Disk growth.** Every build writes STEP/GLB (and optionally STL/SVG) plus a
  report. Retention is a documented policy, not an automatic deletion:
  `security/` policy in `docs/SECURITY_MODEL.md` says the store persists across
  disable/uninstall unless the user removes it (brief scenario K).
- **No in-place edit / no undo beyond the pointer.** There is no revert tool in
  the P0 tool set (`TOOL_NAMES` in `src/contracts/tools.js` has no `cad_delete`),
  so history is inspectable but not walkable by the agent.
- **Callers must hold the revision number.** The client and the agent both have
  to re-read after a conflict; a conflict is a normal, retryable outcome, not an
  error the user sees.

## Alternatives considered

- **Mutable "current model" file (rejected).** Cannot satisfy "never show a
  half-built model", loses history, and makes concurrent background jobs unsafe.
- **Row-level database transactions (rejected).** The Host has no database
  dependency in P0; the filesystem layout is enough and is inspectable by a
  human, which is worth more here than ACID.
- **Full lock/mutex per model (rejected).** A single agent per session makes
  optimistic concurrency sufficient, and a lock would have to survive plugin
  disable, which is exactly the kind of leftover state ADR-0004 forbids.
- **CRDT / multi-writer merge (rejected).** Explicit non-goal
  (`SPEC_P0.md` §8).

## References

- `docs/research/SPEC_P0.md` §4 (lifecycle), §5 (build/validation), §6
  (artifact refs), §7 (editing semantics), §8 (non-goals)
- `src/contracts/tools.js` — `cad_modify_model` (`expected_revision`,
  `request_id`), `cad_inspect_model` (`history_limit`)
- `src/contracts/errors.js` — `revision_conflict: 409`, `model_locked: 409`
- `docs/research/DSH_PLUGIN_API_NOTES.md` §5 (retry versus job lifetime)
- Related: ADR-0004 (background builds), ADR-0005 (artifact references)
