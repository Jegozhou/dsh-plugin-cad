# ADR-0004 — Harness jobs (`ctx.jobs`) are the only background mechanism

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** docs-eng (record), lead, host-eng
- **Milestone:** P0 (M0–M5)

## Context

A build can take from a few hundred milliseconds to minutes (real OCCT might be
slow on a large feature count, and the runtime is serialised at
`maxConcurrentBuilds: 1`). The agent must be able to start work and continue, the
user must be able to cancel it, and a plugin must not leak work when disabled.

The Host already provides a governed background-work primitive,
`ctx.jobs` (`@deepseek-ai/dsh-jobs`, documented in
`docs/research/DSH_PLUGIN_API_NOTES.md` §5):

- `attachController(name) => disposer` must be called (effect-scoped) **before**
  `start()`, otherwise the registry refuses the work ("no controller serves the
  owner");
- `start({kind, label, owner, outputLimitBytes, run}) => JobId`, `run()` returns
  `{cancel, done, readOutput?}`;
- `get/list/read/kill/wait/onJobDone/onJobsChanged`, with access fenced by the
  owning agent's session.

Writing a second task system (timers, an internal promise queue, a worker
thread) would duplicate this and break the contract that every background thing
is visible to the harness.

## Decision

**Every background build is a Harness job.** There is no private queue, timer or
worker in the plugin.

- `apply(ctx, config)` registers the `cad` job controller once, inside
  `ctx.effect`, and disposes it on unload.
- A build that the tool chooses to run in the background calls
  `ctx.jobs.start({ kind: 'cad', label, owner: exec.agent, run })` and returns
  `{ok: true, job_id}` to the model (`cad_create_model` / `cad_modify_model`
  with `background: true`; `src/contracts/tools.js`).
- The job's `cancel(reason)` calls the runtime's `job.cancel`
  (`src/contracts/protocol.js`) and only then releases; the runtime acknowledges
  asynchronously and `kill()` settles first-wins, per §5.
- `cad_get_job_status` is the agent-facing read/cancel tool; it maps
  `action: "status" | "cancel"` onto `ctx.jobs.get/list` and
  `ctx.jobs.kill`.
- **Two different cancellations, deliberately separated:**
  - *Tool-call cancellation* — `exec.signal` in `ToolRunContext`. The tool
    observes it and settles only after its owned work reaches quiescence.
  - *Job lifetime* — an already-published job outlives the tool call and is
    cancelled only via `kill`, owner disposal, or plugin disposal.
- Concurrency is bounded at the runtime (`maxConcurrentBuilds: 1` in
  `cordis.patch.yml`), not by spawning multiple job producers.

## Consequences

**Positive**

- Jobs appear in the host's job UI/telemetry for free, with the calling agent as
  `owner`; agent disposal cancels and awaits its jobs.
- Plugin disable is clean by construction: disposing the controller plus the
  runtime supervisor effect stops accepting and kills outstanding work — which
  is exactly what brief scenarios H/J/K test.
- One cancellation mechanism, so `cad_get_job_status` and the harness job list
  cannot disagree.

**Negative / accepted costs**

- **`attachController` ordering is load-bearing.** A job started before the
  controller is attached is refused; the implementation must attach once in
  `apply()` and never per call.
- **Host-version coupling.** The `ctx.jobs` contract is a host API under
  `engines.dsh: "0.2.1-rc.3"`; a host upgrade that changes the registry breaks
  background builds first. That is why the DSH version is pinned.
- **`owner` shape is host-version specific (recorded defect).** On this release
  `start({owner})` needs the **session-id string**; passing the Agent object fails
  with `has no live agent (background job owner must be live)` and, in the
  recorded run, left the model locked (`tests/e2e/RESULTS.md` §H). The tool layer
  now forwards `exec.agent.id` (`ownerSessionOf(exec)` in `src/host/tools.ts`);
  the scenario stays FAIL until a re-run is recorded. Lesson: the agent object is
  for lookup, its id is for ownership.
- **Foreground builds still exist** (`background` defaults off) because small
  parts build fast and a synchronous tool result is a better model experience;
  two code paths share one build pipeline, which must be tested both ways.

## Alternatives considered

- **Synchronous-only builds (rejected).** Simplest, but a heavy model blocks the
  agent and cannot be cancelled without killing the tool call, and the brief
  explicitly requires mid-build cancellation (scenario H).
- **Own promise queue + AbortController (rejected).** Invisible to the harness,
  leaks across plugin disable, and duplicates `ctx.jobs` semantics badly.
- **`child_process` per build with `detached` (rejected).** ADR-0002 measured why
  per-build spawn is not viable; detached children also survive plugin
  disable — the exact failure K tests for.
- **Node worker threads (rejected).** Geometry is in Python, so a worker buys
  nothing; it would only add a third concurrency domain.

## References

- `docs/research/DSH_PLUGIN_API_NOTES.md` §3 (`ToolRunContext`, `exec.signal`),
  §5 (`ctx.jobs` contract), §2 (effects)
- `src/contracts/tools.js` — `buildOptions.background`, `cad_get_job_status`
- `cordis.patch.yml` — `maxConcurrentBuilds`, `buildTimeoutMs`
- `docs/research/SPEC_P0.md` §4 (serialised builds)
- Related: ADR-0002 (runtime supervision), ADR-0003 (revision pointer)
