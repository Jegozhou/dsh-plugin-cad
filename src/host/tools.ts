/**
 * The nine native agent tools.
 *
 * Contract rules implemented here, once, for every tool:
 *   - name/parameters come verbatim from `src/contracts/tools.js` (the only
 *     model-facing schema authority);
 *   - every outcome is the stable envelope `{ok:true, …}` /
 *     `{ok:false, error:{code,message,details?}}` so a model sees a code, not a
 *     transport exception;
 *   - results carry artifact *references*, never bytes and never a whole
 *     document unless the caller asked for it;
 *   - `exec.signal` is forwarded into the service/runtime, and a cancelled call
 *     reports `cancelled` only after the runtime work is quiescent;
 *   - background builds are native harness jobs (`ctx.jobs`), never a private
 *     task system.
 *
 * Descriptions are written for a model: they teach discovery-first usage
 * (`cad_list_models`/`cad_inspect_model` before mutating), the mm unit, and the
 * `"$parameter"` reference style.
 * @module host/tools
 */

import { CadError, isCadError, TOOL_NAMES, TOOL_SCHEMAS } from './contracts.ts'
import { CadJobs, isCadJobId } from './jobs.ts'
import type { CadService, PreparedBuild } from './service.ts'
import { artifactRef } from './service.ts'
import type { CadConfig } from './config.ts'
import type { ArtifactRef } from './types.ts'

/** Canonical output schema: the envelope plus whatever the tool adds. */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false when the call failed; see error.' },
  },
  required: ['ok'],
}

/** Structural view of one tool call's runtime context. */
export interface ToolRunContextLike {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly id?: string
    readonly session?: { readonly header?: { readonly cwd?: string } }
  }
  readonly callId?: string
  readonly rootCallId?: string
}

/** Structural view of a tool definition accepted by `ctx.tools.register`. */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  presentCall?: (args: unknown) => Record<string, unknown>
  timeoutMs?: number
  execute: (args: Record<string, unknown>, exec: ToolRunContextLike) => Promise<unknown>
}

/** Structural view of the `ctx.tools` service. */
export interface ToolsRegistryLike {
  register(definition: ToolDefinitionLike): () => void
}

/** Everything the tools need from the plugin. */
export interface ToolDependencies {
  service: CadService
  jobs: CadJobs
  config: CadConfig
  log?: (message: string, error?: unknown) => void
}

/**
 * Recursively project a value onto lossless JSON: `undefined` keys are dropped,
 * non-finite numbers become null, functions/symbols/bigints become null. The
 * harness snapshots and validates the canonical value, so nothing else may leak.
 * @param value - candidate result value.
 * @returns a lossless-JSON copy.
 */
export function lossless(value: unknown, depth = 0): unknown {
  if (depth > 16) return null
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(entry => lossless(entry, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      result[key] = lossless(entry, depth + 1)
    }
    return result
  }
  return null
}

/** The failure envelope for any thrown error. */
export function errorEnvelope(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  if (signal?.aborted === true) {
    return {
      ok: false,
      error: {
        code: 'cancelled',
        message: 'the call was cancelled by the caller',
        details: { reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled') },
      },
    }
  }
  if (isCadError(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/** Job correlation ids (`toolCall`), only when the harness supplied a call id. */
function toolCallOf(exec: ToolRunContextLike): { callId?: string; rootCallId?: string } | undefined {
  if (exec.callId === undefined) return undefined
  return {
    callId: exec.callId,
    ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }),
  }
}

/** Abort check kept in a function so TypeScript cannot over-narrow the signal. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** Read the session workspace root, when the caller is an agent session. */
function workspaceRootOf(exec: ToolRunContextLike): string | null {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/** Read the owning session id (audit + the registry's access-fence caller). */
function ownerSessionOf(exec: ToolRunContextLike): string | null {
  const id = exec.agent?.id
  return typeof id === 'string' ? id : null
}

/**
 * The caller the harness job registry expects: the session-id STRING.
 * 0.2.1-rc.3 `assertAccess` compares `job.owner.id !== caller` directly, so an
 * Agent object (or `agent.session`) would be rejected as "another session".
 */
function sessionIdOf(exec: ToolRunContextLike): string | undefined {
  return ownerSessionOf(exec) ?? undefined
}

/**
 * Map a job-registry call onto a stable envelope code and never let a registry
 * TypeError escape as an unclassified `internal` without evidence.
 */
function jobCall<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown job|no such job/u.test(message)) {
      throw new CadError('not_found', message)
    }
    if (/belongs to another session|foreign|not authorized/u.test(message)) {
      throw new CadError('permission_denied', message)
    }
    throw new CadError('internal', `the harness job registry failed: ${message}`, {
      registryError: message,
      registryErrorName: error instanceof Error ? error.name : typeof error,
    })
  }
}

/** Optional non-empty string argument. */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Required non-empty string argument. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new CadError('invalid_argument', `"${key}" must be a non-empty string`, { field: key })
  }
  return value
}

/** Required integer argument. */
function requireInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CadError('invalid_argument', `"${key}" must be an integer`, { field: key })
  }
  return value
}

/** One tool registration entry. */
interface ToolEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  title: string
  timeoutMs?: number
  run(args: Record<string, unknown>, exec: ToolRunContextLike): Promise<Record<string, unknown>>
}

/** Model-facing descriptions (discovery-first, explicit about units). */
const DESCRIPTIONS: Record<string, string> = {
  cad_create_model:
    'Create a persistent parametric CAD model and build real B-rep geometry. '
    + 'Pass a declarative document ({schema:"dsh.cad/document@1", units:"mm", parameters:{name:number}, features:[{id,op,...}]}); '
    + 'lengths are millimetres, +Z is up, and numeric fields may reference a parameter as "$name" so the part stays editable. '
    + 'Feature ops: box, cylinder, hole, hole_pattern (rect_corners|grid|bolt_circle), fillet, chamfer, cut, union. '
    + 'Returns a model_id, a revision_id, a geometry report (volume, bbox, topology, checks) and artifact references '
    + '(STEP + GLB by default) — never the bytes. Invalid documents are rejected before any build with details.path. '
    + 'Use cad_list_models / cad_inspect_model first if a model may already exist. Set background:true for heavy parts: '
    + 'the call returns a harness job_id immediately and you can poll it with cad_get_job_status.',
  cad_modify_model:
    'Edit an existing model and create the next immutable revision. The normal edit is `parameters` (merge values into the '
    + 'document parameters) — this re-runs the same features with new dimensions. Also accepts add_features, remove_features, '
    + 'name and description. Requires expected_revision (the current revision you read): a mismatch is rejected with '
    + 'revision_conflict and details.currentRevision, so inspect again rather than guessing. Parameter edits are validated '
    + 'BEFORE the build: an unknown parameter, a non-positive dimension or a hole that does not fit the part returns '
    + 'invalid_argument with details.path and creates no revision. Failed geometry keeps the previous revision current and '
    + 'records the failed revision with its report. background:true returns a job_id.',
  cad_inspect_model:
    'Read one model revision: metadata, parameters/features, the geometry report (volume, bbox, topology, per-check '
    + 'verdicts) and artifact references. Use this before cad_modify_model to get the expected_revision and to learn the '
    + 'parameter names. include:"summary" (default) omits the document, "document" adds parameters/features, "full" adds the '
    + 'revision history. Read-only.',
  cad_validate_model:
    'Run structural document validation plus the full geometry validation suite against a stored revision or a supplied '
    + 'document, WITHOUT creating a revision or touching files. Returns valid, per-check verdicts and the geometry report. '
    + 'Use it to test a risky edit or a hand-written document before committing it with cad_modify_model. Read-only '
    + '(the runtime may need to build in memory).',
  cad_export_model:
    'Export a revision in STEP/GLB/STL. Returns artifact references; with output_path (a WORKSPACE-RELATIVE directory) it '
    + 'also copies the files into the session workspace and reports their paths. Existing files are never overwritten '
    + 'unless overwrite:true, and output_path may not leave the workspace. Formats missing from the revision are rebuilt '
    + 'into a derived cache, not a new revision. Tool results never inline file bytes.',
  cad_render_preview:
    'Render a technical SVG projection (hidden-line removed) of a revision for a quick visual check, choosing view '
    + 'iso|front|top|right and an optional pixel width/height. The SVG is cached as a derived preview and referenced by '
    + 'URL; it never creates a revision. Read-only with respect to model history.',
  cad_list_models:
    'List the CAD models in the store, newest first, with id, name, current/latest revision, build status and artifact '
    + 'references. Use this FIRST to discover existing models before cad_create_model or cad_inspect_model. Read-only; '
    + 'every model in the store is visible regardless of which session created it.',
  cad_get_job_status:
    'Inspect or cancel a background CAD build started with background:true. Give job_id (e.g. "cad-3f2a…") to get its '
    + 'status and progress output, or omit it to list the recent CAD jobs. action:"cancel" requests cancellation through '
    + 'the native harness job registry. Read-only unless action is cancel.',
  cad_runtime_status:
    'Report the Python CAD runtime status (interpreter, protocol version, capabilities, uptime, last error, recent stderr) '
    + 'and whether it is available. action:"repair" restarts the supervised runtime and re-resolves the interpreter; '
    + 'unless config allowRuntimeInstall=true it does not install anything and returns the exact manual setup command '
    + 'instead. Use verbose:true for diagnostics.',
}

/** Build all tool entries (kept separate so tests can introspect them). */
export function buildToolEntries(deps: ToolDependencies): ToolEntry[] {
  const { service, jobs, config } = deps
  const buildTimeout = config.buildTimeoutMs + 30_000

  return [
    {
      name: 'cad_create_model',
      description: DESCRIPTIONS.cad_create_model!,
      parameters: TOOL_SCHEMAS.cad_create_model!,
      title: 'Create CAD model',
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const requestId = optionalString(args, 'request_id')
        const background = args.background === true
        const build = args.build !== false
        requireJobsForBackground(jobs, background && build)
        const prepared = await service.prepareCreate({
          name: args.name,
          description: args.description,
          document: args.document,
          build,
          requestId: requestId ?? null,
          ownerSession: ownerSessionOf(exec),
        })
        if (prepared.duplicate) {
          const payload = await service.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true })
          return payload
        }
        if (background && build) {
          return await startBackgroundBuild(jobs, {
            service,
            prepared,
            label: `CAD create ${prepared.modelId} ${prepared.revisionId}`,
            owner: ownerSessionOf(exec) ?? undefined,
            toolCall: toolCallOf(exec),
            run: (signal, progress) => service.runBuild(prepared, { signal, onProgress: progress }),
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            revision: prepared.number,
          })
        }
        return service.runBuild(prepared, {
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      },
    },
    {
      name: 'cad_modify_model',
      description: DESCRIPTIONS.cad_modify_model!,
      parameters: TOOL_SCHEMAS.cad_modify_model!,
      title: 'Modify CAD model',
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const expectedRevision = requireInteger(args, 'expected_revision')
        const background = args.background === true
        const build = args.build !== false
        requireJobsForBackground(jobs, background && build)
        const prepared = await service.prepareModify({
          modelId: requireString(args, 'model_id'),
          expectedRevision,
          parameters: args.parameters,
          addFeatures: args.add_features,
          removeFeatures: args.remove_features,
          name: args.name,
          description: args.description,
          build,
          requestId: optionalString(args, 'request_id') ?? null,
          ownerSession: ownerSessionOf(exec),
        })
        if (prepared.duplicate) {
          return service.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true })
        }
        if (background && build) {
          return await startBackgroundBuild(jobs, {
            service,
            prepared,
            label: `CAD modify ${prepared.modelId} ${prepared.revisionId}`,
            owner: ownerSessionOf(exec) ?? undefined,
            toolCall: toolCallOf(exec),
            run: (signal, progress) => service.runBuild(prepared, { signal, onProgress: progress }),
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            revision: prepared.number,
          })
        }
        return service.runBuild(prepared, {
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      },
    },
    {
      name: 'cad_inspect_model',
      description: DESCRIPTIONS.cad_inspect_model!,
      parameters: TOOL_SCHEMAS.cad_inspect_model!,
      title: 'Inspect CAD model',
      timeoutMs: 20_000,
      async run(args) {
        const payload = await service.inspectModel({
          modelId: requireString(args, 'model_id'),
          revision: args.revision_id,
          include: args.include,
          historyLimit: args.history_limit,
        })
        // The tool result carries references; the document is opt-in.
        return payload
      },
    },
    {
      name: 'cad_validate_model',
      description: DESCRIPTIONS.cad_validate_model!,
      parameters: TOOL_SCHEMAS.cad_validate_model!,
      title: 'Validate CAD document',
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const modelId = optionalString(args, 'model_id')
        const document = args.document
        if (modelId === undefined && document === undefined) {
          throw new CadError('invalid_argument', 'pass either model_id (+ optional revision_id) or document')
        }
        return service.validateModel({
          modelId,
          revisionId: args.revision_id,
          document,
          checks: args.checks,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
      },
    },
    {
      name: 'cad_export_model',
      description: DESCRIPTIONS.cad_export_model!,
      parameters: TOOL_SCHEMAS.cad_export_model!,
      title: 'Export CAD artifacts',
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const workspaceRoot = workspaceRootOf(exec)
        return service.exportModel({
          modelId: requireString(args, 'model_id'),
          revisionId: args.revision_id,
          formats: args.formats,
          outputPath: optionalString(args, 'output_path'),
          overwrite: args.overwrite === true,
          workspaceRoot,
        })
      },
    },
    {
      name: 'cad_render_preview',
      description: DESCRIPTIONS.cad_render_preview!,
      parameters: TOOL_SCHEMAS.cad_render_preview!,
      title: 'Render CAD preview',
      timeoutMs: buildTimeout,
      async run(args) {
        return service.renderPreview({
          modelId: requireString(args, 'model_id'),
          revisionId: args.revision_id,
          view: args.view,
          width: args.width,
          height: args.height,
        })
      },
    },
    {
      name: 'cad_list_models',
      description: DESCRIPTIONS.cad_list_models!,
      parameters: TOOL_SCHEMAS.cad_list_models!,
      title: 'List CAD models',
      timeoutMs: 15_000,
      async run(args) {
        const models = await service.listModels({
          limit: args.limit,
          includeFailed: args.include_failed,
        })
        return {
          ok: true,
          count: models.length,
          models: models.map(model => {
            const artifacts = Array.isArray(model.artifacts) ? (model.artifacts as ArtifactRef[]) : []
            const glb = artifacts.find(artifact => artifact.format === 'glb') ?? null
            return {
              ...model,
              glbUrl: glb?.url ?? null,
            }
          }),
        }
      },
    },
    {
      name: 'cad_get_job_status',
      description: DESCRIPTIONS.cad_get_job_status!,
      parameters: TOOL_SCHEMAS.cad_get_job_status!,
      title: 'CAD job status',
      timeoutMs: 10_000,
      async run(args, exec) {
        const action = args.action === 'cancel' ? 'cancel' : 'status'
        const limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 20
        const jobId = optionalString(args, 'job_id')
        if (jobId !== undefined) {
          if (!isCadJobId(jobId)) {
            throw new CadError('invalid_argument', 'job_id must look like "cad-…" (see cad_get_job_status without job_id)', { field: 'job_id' })
          }
          if (action === 'cancel') {
            if (!jobs.available()) throw new CadError('internal', 'this composition has no background job service')
            const caller = sessionIdOf(exec)
            const result = jobCall(() => jobs.kill(jobId, caller, 'cancelled by cad_get_job_status'))
            const snapshot = jobCall(() => jobs.get(jobId, caller))
            return {
              ok: true,
              jobId,
              cancelled: result,
              job: CadJobs.describe(snapshot),
              output: '',
              result: null,
            }
          }
          if (!jobs.available()) throw new CadError('internal', 'this composition has no background job service')
          const read = jobCall(() => jobs.read(jobId, sessionIdOf(exec)))
          // A settled job is readable repeatedly: the snapshot is total, while
          // `result` is only delivered by the registry on the first terminal read.
          return {
            ok: true,
            jobId,
            job: CadJobs.describe(read.snapshot),
            output: read.text,
            lossy: read.lossy,
            result: lossless(read.result ?? null),
          }
        }
        const list = jobs.available() ? jobCall(() => jobs.list(sessionIdOf(exec), limit)) : []
        return {
          ok: true,
          jobs: list
            .map(snapshot => CadJobs.describe(snapshot))
            .filter((entry): entry is Record<string, unknown> => entry !== null),
          available: jobs.available(),
        }
      },
    },
    {
      name: 'cad_runtime_status',
      description: DESCRIPTIONS.cad_runtime_status!,
      parameters: TOOL_SCHEMAS.cad_runtime_status!,
      title: 'CAD runtime status',
      timeoutMs: config.runtimeStartTimeoutMs + 10_000,
      async run(args) {
        const action = args.action === 'repair' ? 'repair' : 'status'
        const payload = await service.runtimeStatus(action)
        if (args.verbose === true) {
          return { ...payload, diagnostics: lossless(service.runtimeDiagnostics()) as Record<string, unknown> }
        }
        return payload
      },
    },
  ]
}

/** Refuse a background request before allocating anything when `ctx.jobs` is absent. */
function requireJobsForBackground(jobs: CadJobs, background: boolean): void {
  if (background && !jobs.available()) {
    throw new CadError('invalid_argument', 'background builds are unavailable in this composition; call again without background:true', {
      hint: 'the harness jobs service (ctx.jobs) is not loaded',
    })
  }
}

/** Start a native background build and return the immediate tool payload. */
async function startBackgroundBuild(
  jobs: CadJobs,
  spec: {
    service: CadService
    prepared: PreparedBuild
    label: string
    /** Session id string (0.2.1-rc.3 jobs owner contract); never the Agent. */
    owner: string | undefined
    toolCall: { callId?: string; rootCallId?: string } | undefined
    run: (signal: AbortSignal, progress: (line: string) => void) => Promise<Record<string, unknown>>
    modelId: string
    revisionId: string
    revision: number
  },
): Promise<Record<string, unknown>> {
  if (!jobs.available()) {
    throw new CadError('invalid_argument', 'background builds are unavailable in this composition; call again without background:true', {
      hint: 'the harness jobs service (ctx.jobs) is not loaded',
      modelId: spec.modelId,
      revisionId: spec.revisionId,
      status: 'unbuilt',
    })
  }
  try {
    const started = jobs.startBuild({
      label: spec.label,
      ...(spec.owner === undefined ? {} : { owner: spec.owner }),
      ...(spec.toolCall === undefined ? {} : { toolCall: spec.toolCall }),
      run: spec.run,
    })
    return {
      ok: true,
      background: true,
      jobId: started.jobId,
      modelId: spec.modelId,
      revisionId: spec.revisionId,
      revision: spec.revision,
      status: 'building',
      next: 'poll cad_get_job_status({job_id}) then cad_inspect_model',
    }
  } catch (error) {
    // A rejected start must not leave the model fenced: persist the revision as
    // failed with the start error and release the per-model lock.
    await spec.service.discardPrepared(spec.prepared, error).catch(() => undefined)
    throw error
  }
}

/**
 * Register every tool. Returns the disposers so `index.ts` can wrap them in one
 * `ctx.effect`.
 * @param tools - the `ctx.tools` service.
 * @param deps - service, jobs bridge and config.
 * @returns one disposer per registered tool.
 */
export function registerTools(tools: ToolsRegistryLike, deps: ToolDependencies): Array<() => void> {
  if (typeof tools.register !== 'function') return []
  const entries = buildToolEntries(deps)
  const names = entries.map(entry => entry.name)
  if (names.length !== TOOL_NAMES.length || TOOL_NAMES.some((name, index) => names[index] !== name)) {
    throw new Error(`tool registration order drifted from src/contracts/tools.js: got ${names.join(', ')}`)
  }
  const disposers: Array<() => void> = []
  for (const entry of entries) {
    disposers.push(tools.register({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall: (args: unknown) => ({
        card: 'generic',
        title: entry.title,
        kind: 'other',
        rawInput: args,
      }),
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
      async execute(args: unknown, exec: ToolRunContextLike) {
        const record = args !== null && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {}
        if (isAborted(exec.signal)) return errorEnvelope(new CadError('cancelled', 'the call was cancelled before it started'), exec.signal)
        try {
          const payload = await entry.run(record, exec)
          // A runtime call may settle with a value after the caller aborted;
          // the abort wins so the model never sees a stale success.
          if (isAborted(exec.signal)) return lossless(errorEnvelope(new CadError('cancelled', 'the call was cancelled'), exec.signal))
          return lossless({ ok: true, ...payload })
        } catch (error) {
          return lossless(errorEnvelope(error, exec.signal))
        }
      },
    }))
  }
  return disposers
}

/** Re-export for the API layer's artifact-ref construction. */
export { artifactRef }
