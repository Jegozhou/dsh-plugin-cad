/**
 * Background-build bridge onto the harness job registry (`ctx.jobs`).
 *
 * There is deliberately no private task system: a background CAD build is a
 * native Harness job, so it shows up in the harness job list, is cancellable by
 * id, is readable through the standard output cursor, and is cancelled and
 * awaited when its owning agent or the plugin is disposed.
 *
 * ============================================================================
 * 0.2.1-rc.3 CONTRACT DRIFT — the shipped registry differs from the 0.1.1-rc.2
 * `.d.ts` copies under ~/.dsh/profiles. Verified in the installed asar
 * (`@deepseek-ai/dsh-jobs-local/lib/index.js`):
 *
 *   start(spec)        `run(handle)` receives a handle with `append(text,
 *                      options?)` / `updateProgress(line)`; there is NO
 *                      `hooks.readOutput` (output reaches the ring only through
 *                      `handle.append` or `spec.output` pump sources).
 *   JobOutcome         `{status, detail?, result?}` — terminal data is `result`
 *                      (a JSON value), not `output`.
 *   read(id, caller)   `{chunks:[{at,text,…}], lossy, result?, job}` — NOT
 *                      `{text, snapshot}`. `chunks` is the output delta since
 *                      the previous read; `result` is delivered exactly once
 *                      after settlement.
 *   owner/caller       both are the session-id STRING (`agents.get(session)`,
 *                      `assertAccess`: `job.owner.id !== caller`), never an
 *                      Agent object.
 *   get(id, caller)    `view(job)` = `{id,kind,label,owner?,outputLimitBytes?,
 *                      status,progress?,detail?,startedAt,finishedAt?,
 *                      output:{total,earliest,spillPaths?}}`.
 *
 * This module normalizes all of that, so callers only ever see
 * `{text, snapshot, lossy, result}` and a total `describe()` that never throws
 * for a settled, cancelled or already-read job.
 * ============================================================================
 * @module host/jobs
 */

/** Terminal result supplied by a producer through `done`. */
export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  /** Terminal JSON payload the registry stores and hands back once on read. */
  result?: unknown
}

/** Handle the registry passes to `run()` (0.2.1-rc.3). */
export interface JobHandleLike {
  id?: string
  append?(text: string, options?: Record<string, unknown>): void
  updateProgress?(line: string): void
}

/** Hooks through which the runtime controls producer work. */
export interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<JobOutcomeLike>
}

/** Normalized snapshot: the fields of a registry `view()` this plugin uses. */
export interface JobSnapshotLike {
  id: string
  kind: string
  label: string
  owner?: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  progress?: string
  startedAt: number
  finishedAt?: number
  reported?: boolean
  output?: { total?: number; earliest?: number; spillPaths?: string[] }
}

/** Registry read result after normalization. */
export interface JobReadLike {
  /** Output delta since the previous read, already decoupled from chunks. */
  text: string
  snapshot: JobSnapshotLike | null
  lossy: boolean
  /** Terminal JSON payload, delivered at most once by the registry. */
  result: unknown
}

/** Raw read shape returned by the shipped registry. */
interface RawJobRead {
  chunks?: unknown
  lossy?: unknown
  result?: unknown
  job?: unknown
  snapshot?: unknown
  text?: unknown
}

/** Minimal structural view of the `JobRegistry` service. */
export interface JobRegistryLike {
  attachController(name: string): () => void
  start(spec: {
    kind: string
    label: string
    /** Session id string of the owning agent (0.2.1-rc.3 owner contract). */
    owner?: string
    toolCall?: { callId?: string; rootCallId?: string }
    outputLimitBytes?: number
    run(handle: JobHandleLike): JobHooksLike
  }): string
  /** `caller` is the session-id STRING (`assertAccess` compares it directly). */
  get(id: string, caller?: string): JobSnapshotLike
  read(id: string, caller?: string): RawJobRead
  list(caller?: string): JobSnapshotLike[]
  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished'
}

/** Per-job output cap requested from the registry. */
const OUTPUT_LIMIT_BYTES = 16 * 1024

/** One accepted background build. */
export interface StartedBuild {
  jobId: string
  /** Settles when the job's work reaches quiescence. */
  done: Promise<JobOutcomeLike>
}

/** Spec for one background build. */
export interface BackgroundBuildSpec {
  label: string
  /** Session id string of the owning agent (`exec.agent.id`), never the Agent object. */
  owner?: string
  toolCall?: { callId?: string; rootCallId?: string }
  /** The job body; receives its own cancellation signal and a progress sink. */
  run: (signal: AbortSignal, progress: (line: string) => void) => Promise<Record<string, unknown>>
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a job id, tolerating the `<kind>-<random>` shape of the registry. */
export function isCadJobId(value: unknown): value is string {
  return typeof value === 'string' && /^cad-[A-Za-z0-9]+$/u.test(value)
}

/** Coerce an unknown registry `view()` into the fields we rely on, or null. */
export function normalizeJobSnapshot(raw: unknown): JobSnapshotLike | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || typeof raw.status !== 'string') return null
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : null
  if (startedAt === null) return null
  const status = raw.status
  if (!['running', 'stopping', 'completed', 'killed', 'failed'].includes(status)) return null
  const normalizedStatus = status as JobSnapshotLike['status']
  const output = isRecord(raw.output)
    ? {
        ...(typeof raw.output.total === 'number' ? { total: raw.output.total } : {}),
        ...(typeof raw.output.earliest === 'number' ? { earliest: raw.output.earliest } : {}),
        ...(Array.isArray(raw.output.spillPaths)
          ? { spillPaths: raw.output.spillPaths.filter((entry): entry is string => typeof entry === 'string') }
          : {}),
      }
    : undefined
  return {
    id: raw.id,
    kind: typeof raw.kind === 'string' ? raw.kind : 'cad',
    label: typeof raw.label === 'string' ? raw.label : '',
    ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
    status: normalizedStatus,
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    ...(typeof raw.progress === 'string' ? { progress: raw.progress } : {}),
    startedAt,
    ...(typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {}),
    ...(typeof raw.reported === 'boolean' ? { reported: raw.reported } : {}),
    ...(output === undefined ? {} : { output }),
  }
}

/** Join the shipped registry's output chunks into one text delta. */
function chunksToText(chunks: unknown): string {
  if (!Array.isArray(chunks)) return ''
  let text = ''
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      text += chunk
      continue
    }
    if (isRecord(chunk) && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * Normalize either the shipped `{chunks,lossy,result,job}` read shape or the
 * stale typed `{text,snapshot}` one. Total: malformed input yields empty
 * fields, never a throw.
 */
export function normalizeJobRead(raw: unknown): JobReadLike {
  if (!isRecord(raw)) return { text: '', snapshot: null, lossy: false, result: undefined }
  const record = raw as RawJobRead
  const snapshot = normalizeJobSnapshot(record.job ?? record.snapshot)
  let text = typeof record.text === 'string' ? record.text : ''
  if (text === '') text = chunksToText(record.chunks)
  return {
    text,
    snapshot,
    lossy: record.lossy === true,
    result: record.result,
  }
}

/** The jobs bridge. One instance per plugin activation. */
export class CadJobs {
  private readonly getRegistry: () => JobRegistryLike | null
  private readonly log: (message: string, error?: unknown) => void
  private readonly live = new Map<string, { done: Promise<JobOutcomeLike>; cancel: (reason?: string) => void }>()

  constructor(options: {
    /** Lazy lookup: `ctx.jobs` may only resolve after apply() returns. */
    getRegistry?: () => JobRegistryLike | null
    /** Static registry, used by tests. */
    registry?: JobRegistryLike | null
    log?: (message: string, error?: unknown) => void
  }) {
    this.getRegistry = options.getRegistry ?? (() => options.registry ?? null)
    this.log = options.log ?? (() => undefined)
  }

  /** True when the composition provides `ctx.jobs`. */
  available(): boolean {
    return this.getRegistry() !== null
  }

  /** Attach the controller the registry requires before `start`. */
  attach(): () => void {
    const registry = this.getRegistry()
    if (registry === null) return () => undefined
    return registry.attachController('cad')
  }

  /** Number of CAD jobs still running (health payload). */
  activeCount(): number {
    return this.live.size
  }

  /**
   * Start one background build through the native job registry.
   *
   * Output is pushed through the registry's `handle.append`, because the
   * shipped registry has no `readOutput` hook; the terminal `result` carries a
   * small JSON summary the agent can read once the job settles.
   *
   * @param spec - label, owning session id and the job body.
   * @returns the registry-issued id and a settlement promise.
   * @throws {Error} when `ctx.jobs` is not in this composition.
   */
  startBuild(spec: BackgroundBuildSpec): StartedBuild {
    const registry = this.getRegistry()
    if (registry === null) {
      throw new Error('background builds require the harness jobs service (ctx.jobs) in this composition')
    }
    let controller: AbortController | null = null
    let jobCancel: ((reason?: string) => void) | null = null
    let cancelled = false
    let settle: (outcome: JobOutcomeLike) => void = () => undefined
    const done = new Promise<JobOutcomeLike>(resolve => {
      settle = resolve
    })
    const jobId = registry.start({
      kind: 'cad',
      label: spec.label,
      ...(spec.owner === undefined ? {} : { owner: spec.owner }),
      ...(spec.toolCall === undefined ? {} : { toolCall: spec.toolCall }),
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: handle => {
        controller = new AbortController()
        const signal = controller.signal
        const append = (text: string): void => {
          try {
            handle.append?.(text.endsWith('\n') ? text : `${text}\n`)
          } catch (error) {
            this.log('jobs: could not append job output', error)
          }
        }
        const cancel = (reason?: string): void => {
          if (cancelled) return
          cancelled = true
          controller?.abort(new Error(reason ?? 'cancelled'))
        }
        jobCancel = cancel
        void (async () => {
          try {
            const value = await spec.run(signal, append)
            const summary = {
              modelId: typeof value.modelId === 'string' ? value.modelId : null,
              revisionId: typeof value.revisionId === 'string' ? value.revisionId : null,
              revision: typeof value.revision === 'number' ? value.revision : null,
              status: typeof value.status === 'string' ? value.status : null,
            }
            const detail = [summary.modelId, summary.revisionId, summary.status].filter(entry => entry !== null).join(' ')
            append(`done: ${JSON.stringify(summary)}`)
            settle({
              status: cancelled ? 'killed' : 'completed',
              ...(detail === '' ? {} : { detail }),
              result: summary,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            append(`failed: ${message}`)
            settle({
              status: cancelled ? 'killed' : 'failed',
              detail: message,
              result: { status: 'failed', error: message },
            })
          }
        })()
        return { cancel, done }
      },
    })
    this.live.set(jobId, { done, cancel: (reason?: string) => jobCancel?.(reason) })
    void done.finally(() => {
      this.live.delete(jobId)
    })
    this.log(`jobs: started ${jobId} (${spec.label})`)
    return { jobId, done }
  }

  /** Read one job snapshot (throws for unknown/foreign ids). */
  get(jobId: string, caller?: string): JobSnapshotLike {
    const registry = this.getRegistry()
    if (registry === null) throw new Error('the harness jobs service is not available')
    const snapshot = normalizeJobSnapshot(registry.get(jobId, caller))
    if (snapshot === null) throw new Error(`the job registry returned a malformed snapshot for ${jobId}`)
    return snapshot
  }

  /** Read the next output delta for one job (consuming cursor, like the harness). */
  read(jobId: string, caller?: string): JobReadLike {
    const registry = this.getRegistry()
    if (registry === null) throw new Error('the harness jobs service is not available')
    const read = normalizeJobRead(registry.read(jobId, caller))
    if (read.snapshot === null) {
      // A readable record whose projection is malformed is a registry fault; the
      // caller gets a structured error rather than a TypeError.
      throw new Error(`the job registry returned a malformed read for ${jobId}`)
    }
    return read
  }

  /** List visible CAD jobs, newest first. */
  list(caller?: string, limit = 20): JobSnapshotLike[] {
    const registry = this.getRegistry()
    if (registry === null) return []
    const snapshots = registry.list(caller).flatMap(entry => {
      const snapshot = normalizeJobSnapshot(entry)
      return snapshot === null ? [] : [snapshot]
    })
    return snapshots.filter(job => job.kind === 'cad').slice(-limit).reverse()
  }

  /** Cancel one job by id. */
  kill(jobId: string, caller?: string, reason?: string): 'requested' | 'already-finished' {
    const registry = this.getRegistry()
    if (registry === null) throw new Error('the harness jobs service is not available')
    return registry.kill(jobId, caller, reason)
  }

  /**
   * Human-readable one-line status for a tool result. Total: an absent or
   * malformed snapshot yields `null` instead of throwing, so a settled job can
   * always be reported.
   */
  static describe(snapshot: JobSnapshotLike | null | undefined): Record<string, unknown> | null {
    if (snapshot === null || snapshot === undefined) return null
    const output = snapshot.output === undefined
      ? undefined
      : {
          ...(snapshot.output.total === undefined ? {} : { total: snapshot.output.total }),
          ...(snapshot.output.earliest === undefined ? {} : { earliest: snapshot.output.earliest }),
        }
    return {
      jobId: snapshot.id,
      kind: snapshot.kind,
      label: snapshot.label,
      status: snapshot.status,
      cancelled: snapshot.status === 'killed',
      done: snapshot.status !== 'running' && snapshot.status !== 'stopping',
      detail: snapshot.detail ?? null,
      progress: snapshot.progress ?? null,
      startedAt: new Date(snapshot.startedAt).toISOString(),
      finishedAt: snapshot.finishedAt === undefined ? null : new Date(snapshot.finishedAt).toISOString(),
      ...(output === undefined ? {} : { output }),
    }
  }
}
