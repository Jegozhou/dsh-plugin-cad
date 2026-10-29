/**
 * The CAD service: the single implementation both the agent tools and the
 * viewer API call. Agreement between the two surfaces is structural, not
 * duplicated.
 *
 * Responsibilities:
 *   - map a validated `dsh.cad/document@1` onto the runtime (`model.build`);
 *   - persist every attempt as an immutable revision (failed ones included, for
 *     diagnosis) while only promoting successful builds to `currentRevision`;
 *   - validate parameter edits before the build, so an invalid edit creates no
 *     revision at all (SPEC_P0 §7);
 *   - build the stable artifact references (`{artifactId,format,bytes,sha256,url,contentType}`)
 *     that tools and the viewer both use;
 *   - serialize builds per model and bound them globally.
 * @module host/service
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { CadError, DOCUMENT_SCHEMA, EXPORT_FORMATS, PROTOCOL_VERSION } from './contracts.ts'
import type { CadConfig } from './config.ts'
import { PLUGIN_ID, VERSION } from './config.ts'
import { safePath } from './paths.ts'
import { copyArtifactsIntoWorkspace } from './export.ts'
import { applyEdit, resolveNumber, validateDocument } from './validate.ts'
import type { CadRuntime, ParsedBuildResult } from './runtime.ts'
import type { CadStore, BuildCompletion, RevisionAllocation } from './store.ts'
import { nowIso } from './store.ts'
import type {
  ArtifactMeta,
  ArtifactRef,
  BuildKind,
  CadDocument,
  GeometryReport,
  ModelIndex,
  RevisionError,
  RevisionMeta,
  RevisionSummary,
} from './types.ts'

/** Base path of the viewer API and the asset route (kept in one place). */
export const API_PREFIX = '/dsh-plugin-cad/api'
/** Base path of artifact bytes. */
export const ASSET_PREFIX = '/dsh-plugin-cad/assets'

/** Formats a build produces by default (SPEC_P0 §5.3). */
const DEFAULT_FORMATS = ['step', 'glb']

/** Injectable dependencies. */
export interface CadServiceOptions {
  config: CadConfig
  store: CadStore
  runtime: CadRuntime
  log?: (message: string, error?: unknown) => void
  /** Live background-job count for the health payload (owned by the jobs bridge). */
  jobStats?: () => { active: number }
}

/** A revision that was allocated by a prepare step and may now be built. */
export interface PreparedBuild {
  modelId: string
  modelName: string
  number: number
  revisionId: string
  document: CadDocument
  documentSha256: string
  kind: BuildKind
  requestId: string | null
  duplicate: boolean
  build: boolean
  formats: string[]
  ownerSession: string | null
  /** Index snapshot taken after allocation. */
  index: ModelIndex
}

/** Build/progress options. */
export interface BuildOptions {
  signal?: AbortSignal
  onProgress?: (line: string) => void
  /** Request id recorded with the revision (defaults to a fresh uuid). */
  runtimeRequestId?: string
}

/** Options for exporting artifacts out of the store. */
export interface ExportOptions {
  modelId: string
  revisionId?: unknown
  formats?: unknown
  /** Workspace-relative destination directory. */
  outputPath?: string
  overwrite?: boolean
  /** Session workspace root (absolute); required for `outputPath`. */
  workspaceRoot?: string | null
}

/** Artifact reference exposed to clients (identical in tools and API). */
export function artifactRef(modelId: string, revisionId: string, meta: ArtifactMeta): ArtifactRef {
  return {
    artifactId: `${modelId}:${revisionId}:${meta.format}`,
    format: meta.format,
    fileName: meta.fileName,
    bytes: meta.bytes,
    sha256: meta.sha256,
    contentType: meta.contentType,
    url: `${ASSET_PREFIX}/models/${modelId}/${revisionId}/${meta.fileName}`,
  }
}

/** Artifact reference of one derived preview in the preview cache. */
export function previewRef(modelId: string, revisionId: string, meta: ArtifactMeta): ArtifactRef {
  return {
    artifactId: `${modelId}:${revisionId}:${meta.format}`,
    format: meta.format,
    fileName: meta.fileName,
    bytes: meta.bytes,
    sha256: meta.sha256,
    contentType: meta.contentType,
    url: `${ASSET_PREFIX}/models/${modelId}/previews/${revisionId}/${meta.fileName}`,
  }
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bound a caller-supplied limit. */
function clampLimit(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

/** `latestStatus` of a model index. */
function latestStatusOf(index: ModelIndex): 'built' | 'failed' | 'unbuilt' | 'empty' {
  if (index.latestRevision === 0) return 'empty'
  const summary = index.revisions.find(entry => entry.number === index.latestRevision)
  return summary?.status ?? 'empty'
}

/**
 * The CAD service. Stateless apart from build queues: the store is the source
 * of truth, so a restart of either half loses nothing.
 */
export class CadService {
  readonly config: CadConfig
  private readonly store: CadStore
  private readonly runtime: CadRuntime
  private readonly log: (message: string, error?: unknown) => void
  private readonly jobStats: () => { active: number }
  private readonly modelQueues = new Map<string, Promise<unknown>>()
  private activeBuilds = 0
  private buildWaiters: Array<() => void> = []

  constructor(options: CadServiceOptions) {
    this.config = options.config
    this.store = options.store
    this.runtime = options.runtime
    this.log = options.log ?? (() => undefined)
    this.jobStats = options.jobStats ?? (() => ({ active: 0 }))
  }

  /** Expose the runtime for the tools' status action and the API health route. */
  get runtimeSupervisor(): CadRuntime {
    return this.runtime
  }

  /** Expose the store for artifacts and diagnostics. */
  get modelStore(): CadStore {
    return this.store
  }

  // ------------------------------------------------------------------ health

  /** Health payload for `/api/health` and `cad_runtime_status`. */
  async health(): Promise<Record<string, unknown>> {
    const [status, modelCount] = await Promise.all([
      Promise.resolve(this.runtime.status()),
      this.store.countModels().catch(() => 0),
    ])
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtime: status,
      store: {
        dataDir: this.config.dataDir,
        modelCount,
        writable: this.config.allowModelWrite,
        exportAllowed: this.config.allowExport,
      },
      jobs: this.jobStats(),
      time: nowIso(),
    }
  }

  /** Verbose runtime diagnostics (`cad_runtime_status {verbose:true}`). */
  runtimeDiagnostics(): Record<string, unknown> {
    return this.runtime.diagnostics()
  }

  /**
   * Probe or repair the runtime. `repair` never installs anything unless
   * `allowRuntimeInstall` is enabled explicitly (Lead decision, SPEC_P0 §8).
   * @param action - `status` (probe only) or `repair` (restart + re-resolve).
   */
  async runtimeStatus(action: 'status' | 'repair'): Promise<Record<string, unknown>> {
    if (action === 'status') {
      const health = await this.runtime.health()
      return { ok: true, ...this.healthSnapshot(health) }
    }
    const notes = this.runtime.reResolve()
    let repairError: unknown = null
    try {
      await this.runtime.restart('cad_runtime_status repair')
    } catch (error) {
      repairError = error
    }
    if (repairError === null) {
      const health = await this.runtime.health()
      return { ok: true, repaired: true, notes, ...this.healthSnapshot(health) }
    }
    return {
      ok: false,
      repaired: false,
      notes,
      ...this.healthSnapshot(await this.runtime.health()),
      error: {
        code: 'runtime_unavailable',
        message: repairError instanceof Error ? repairError.message : String(repairError),
        details: {
          installCommand: 'node python/setup-runtime.mjs',
          allowRuntimeInstall: this.config.allowRuntimeInstall,
          notes,
        },
      },
    }
  }

  /** Flatten a runtime health probe into the status payload. */
  private healthSnapshot(health: Record<string, unknown>): Record<string, unknown> {
    const status = this.runtime.status()
    return {
      available: status.available && health.ok !== false,
      runtime: status,
      probe: isRecord(health.health) ? health.health : null,
      error: health.ok === false ? (health.error ?? status.lastError) : null,
    }
  }

  // ------------------------------------------------------------------ models

  /** Summaries for `cad_list_models` and `GET /api/models`. */
  async listModels(input: { limit?: unknown; includeFailed?: unknown } = {}): Promise<Record<string, unknown>[]> {
    const limit = clampLimit(input.limit, 1, this.config.limits.maxModelsListed, 50)
    const includeFailed = input.includeFailed === true
    const indexes = await this.store.listModels()
    const models = indexes
      .filter(index => includeFailed || latestStatusOf(index) !== 'failed')
      .slice(0, limit)
      .map(index => this.modelSummary(index))
    return models
  }

  /** Compact model summary (no document read). */
  private modelSummary(index: ModelIndex): Record<string, unknown> {
    const current = index.revisions.find(entry => entry.number === index.currentRevision)
    const latestStatus = latestStatusOf(index)
    return {
      modelId: index.id,
      name: index.name,
      description: index.description,
      units: 'mm',
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      currentRevision: index.currentRevision,
      currentRevisionId: current?.revisionId ?? null,
      latestRevision: index.latestRevision,
      latestRevisionId: index.revisions.find(entry => entry.number === index.latestRevision)?.revisionId ?? null,
      latestStatus,
      revisionCount: index.revisions.length,
      failing: latestStatus === 'failed',
      report: current?.reportSummary ?? null,
      artifacts: (current?.artifacts ?? []).map(artifact => artifactRef(index.id, current!.revisionId, artifact)),
    }
  }

  /** Resolve a revision id/number against an index. */
  private resolveRevision(index: ModelIndex, revision?: unknown): RevisionSummary {
    if (typeof revision === 'number' && Number.isFinite(revision)) {
      const summary = index.revisions.find(entry => entry.number === revision)
      if (summary === undefined) throw new CadError('not_found', `revision ${String(revision)} does not exist`, { modelId: index.id })
      return summary
    }
    if (typeof revision === 'string' && revision !== '') {
      const summary = index.revisions.find(entry => entry.revisionId === revision)
      if (summary === undefined) throw new CadError('not_found', `revision ${revision} does not exist`, { modelId: index.id })
      return summary
    }
    if (index.currentRevision > 0) {
      const current = index.revisions.find(entry => entry.number === index.currentRevision)
      if (current !== undefined) return current
    }
    const latest = index.revisions.find(entry => entry.number === index.latestRevision)
    if (latest === undefined) throw new CadError('not_found', `model ${index.id} has no revision`, { modelId: index.id })
    return latest
  }

  /** Full revision view for the API and `cad_inspect_model`. */
  async revisionDetail(modelId: string, revision?: unknown): Promise<{
    index: ModelIndex
    summary: RevisionSummary
    meta: RevisionMeta | null
    document: CadDocument | null
    report: GeometryReport | null
    artifacts: ArtifactRef[]
  }> {
    const index = await this.store.readModel(modelId)
    const summary = this.resolveRevision(index, revision)
    let meta: RevisionMeta | null = null
    let document: CadDocument | null = null
    let report: GeometryReport | null = null
    try {
      const read = await this.store.readRevision(modelId, summary.revisionId)
      meta = read.meta
      document = read.document
      report = read.report
    } catch (error) {
      if (!(error instanceof CadError) || (error.code !== 'not_found' && error.code !== 'revision_conflict')) throw error
      // Allocation exists but the build has not settled yet (or build:false):
      // project the index summary instead of failing the viewer poll.
      const documentRead = await this.store.readDocument(modelId, summary.number).catch(() => null)
      document = documentRead?.document ?? null
    }
    const artifacts = (meta?.artifacts ?? summary.artifacts).map(artifact => artifactRef(index.id, summary.revisionId, artifact))
    return { index, summary, meta, document, report: report ?? meta?.report ?? null, artifacts }
  }

  /** `cad_inspect_model` / `GET /api/models/:id`. */
  async inspectModel(input: {
    modelId: string
    revision?: unknown
    include?: unknown
    historyLimit?: unknown
  }): Promise<Record<string, unknown>> {
    const detail = await this.revisionDetail(input.modelId, input.revision)
    const include = input.include === 'document' || input.include === 'full' ? input.include : 'summary'
    const historyLimit = clampLimit(input.historyLimit, 1, this.config.limits.maxHistoryEntries, include === 'full' ? 50 : 10)
    const history = [...detail.index.revisions]
      .reverse()
      .slice(0, historyLimit)
      .map(summary => this.revisionSummaryView(detail.index.id, summary))
    const meta = detail.meta
    const revisionView: Record<string, unknown> = {
      revisionId: detail.summary.revisionId,
      number: detail.summary.number,
      status: detail.summary.status,
      createdAt: detail.summary.createdAt,
      builtAt: detail.summary.builtAt,
      documentSha256: detail.summary.documentSha256,
      buildKind: meta?.buildKind ?? null,
      buildRequestId: meta?.buildRequestId ?? null,
      durationMs: meta?.durationMs ?? null,
      formats: meta?.formats ?? detail.summary.artifacts.map(artifact => artifact.format),
      report: detail.report,
      artifacts: detail.artifacts,
      warnings: meta?.warnings ?? detail.report?.warnings ?? [],
      error: meta?.error ?? null,
    }
    const currentSummary = detail.index.revisions.find(entry => entry.number === detail.index.currentRevision)
    const currentRefs = (currentSummary?.artifacts ?? []).map(artifact => artifactRef(detail.index.id, currentSummary!.revisionId, artifact))
    const glb = currentRefs.find(ref => ref.format === 'glb') ?? null
    const step = currentRefs.find(ref => ref.format === 'step') ?? null
    const payload: Record<string, unknown> = {
      ok: true,
      model: {
        modelId: detail.index.id,
        name: detail.index.name,
        description: detail.index.description,
        schema: DOCUMENT_SCHEMA,
        units: 'mm',
        createdAt: detail.index.createdAt,
        updatedAt: detail.index.updatedAt,
        currentRevision: detail.index.currentRevision,
        currentRevisionId: currentSummary?.revisionId ?? null,
        latestRevision: detail.index.latestRevision,
        latestRevisionId: detail.index.revisions.find(entry => entry.number === detail.index.latestRevision)?.revisionId ?? null,
        latestStatus: latestStatusOf(detail.index),
        failing: latestStatusOf(detail.index) === 'failed',
        revisionCount: detail.index.revisions.length,
        owner: detail.index.owner ?? { sessionId: detail.index.ownerSession ?? null },
        metadata: detail.index.metadata ?? {},
      },
      revision: revisionView,
      viewer: {
        glbUrl: glb?.url ?? null,
        stepUrl: step?.url ?? null,
        svgUrl: null,
        defaultView: 'iso',
        units: 'mm',
        upAxis: 'z',
      },
      history,
    }
    if (include !== 'summary' && detail.document !== null) {
      payload.document = {
        schema: DOCUMENT_SCHEMA,
        units: 'mm',
        parameters: detail.document.parameters ?? {},
        features: detail.document.features,
        featureCount: detail.document.features.length,
        parameterNames: Object.keys(detail.document.parameters ?? {}),
      }
    }
    return payload
  }

  /** Compact revision projection used by `history` and `GET /revisions`. */
  private revisionSummaryView(modelId: string, summary: RevisionSummary): Record<string, unknown> {
    return {
      revisionId: summary.revisionId,
      number: summary.number,
      status: summary.status,
      createdAt: summary.createdAt,
      builtAt: summary.builtAt,
      documentSha256: summary.documentSha256,
      errorCode: summary.errorCode,
      report: summary.reportSummary,
      artifacts: summary.artifacts.map(artifact => artifactRef(modelId, summary.revisionId, artifact)),
    }
  }

  /** `GET /api/models/:id/revisions`. */
  async listRevisions(input: { modelId: string; limit?: unknown }): Promise<Record<string, unknown>> {
    const index = await this.store.readModel(input.modelId)
    const limit = clampLimit(input.limit, 1, this.config.limits.maxHistoryEntries, 50)
    return {
      ok: true,
      modelId: index.id,
      currentRevision: index.currentRevision,
      latestRevision: index.latestRevision,
      revisions: [...index.revisions].reverse().slice(0, limit).map(summary => this.revisionSummaryView(index.id, summary)),
    }
  }

  /** `GET /api/models/:id/artifacts`. */
  async modelArtifacts(input: { modelId: string; revision?: unknown }): Promise<Record<string, unknown>> {
    const detail = await this.revisionDetail(input.modelId, input.revision)
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      artifacts: detail.artifacts,
    }
  }

  // ------------------------------------------------------------------ writes

  /** Throw unless writes are enabled by configuration. */
  private requireWrite(): void {
    if (!this.config.allowModelWrite) {
      throw new CadError('permission_denied', 'this CAD plugin is configured read-only (allowModelWrite=false)')
    }
  }

  /** Normalize the requested build formats, defaulting to step+glb. */
  private normalizeFormats(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_FORMATS]
    const formats: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !EXPORT_FORMATS.includes(entry)) {
        throw new CadError('invalid_argument', `formats must be a subset of ${EXPORT_FORMATS.join(', ')}`, { formats: value })
      }
      if (!formats.includes(entry)) formats.push(entry)
    }
    return formats
  }

  /**
   * Validate a document and allocate the model + its first revision, without
   * building. The caller either builds synchronously (`runBuild`) or wraps the
   * build in a background job.
   * @param input - creation input from the tool.
   * @returns the prepared build.
   */
  async prepareCreate(input: {
    name?: unknown
    description?: unknown
    document: unknown
    build?: unknown
    requestId?: string | null
    ownerSession?: string | null
    formats?: unknown
  }): Promise<PreparedBuild> {
    this.requireWrite()
    const document = validateDocument(input.document, this.config)
    const name = typeof input.name === 'string' && input.name.trim() !== ''
      ? input.name.trim().slice(0, this.config.limits.maxNameLength)
      : (document.name ?? 'Untitled CAD model')
    const description = typeof input.description === 'string'
      ? input.description.slice(0, this.config.limits.maxNameLength)
      : (document.description ?? '')
    const formats = this.normalizeFormats(input.formats)
    const mutation = await this.store.createModel({
      name,
      description,
      document,
      ownerSession: input.ownerSession ?? null,
      requestId: input.requestId ?? null,
      formats,
    })
    return {
      modelId: mutation.index.id,
      modelName: mutation.index.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: 'create',
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: input.build !== false,
      formats,
      ownerSession: input.ownerSession ?? null,
      index: mutation.index,
    }
  }

  /**
   * Apply an edit to the current document and allocate the next revision.
   * Parameter edits are validated here, before any runtime call.
   * @param input - modify-model input.
   * @returns the prepared build.
   */
  async prepareModify(input: {
    modelId: string
    expectedRevision: unknown
    parameters?: unknown
    addFeatures?: unknown
    removeFeatures?: unknown
    name?: unknown
    description?: unknown
    build?: unknown
    requestId?: string | null
    ownerSession?: string | null
    formats?: unknown
  }): Promise<PreparedBuild> {
    this.requireWrite()
    const index = await this.store.readModel(input.modelId)
    const expectedRevision = typeof input.expectedRevision === 'number' && Number.isFinite(input.expectedRevision)
      ? Math.trunc(input.expectedRevision)
      : Number.NaN
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new CadError('invalid_argument', 'expected_revision must be an integer', { field: 'expected_revision' })
    }
    const current = await this.store.readDocument(index.id, index.currentRevision > 0 ? index.currentRevision : index.latestRevision)
    const edit: Parameters<typeof applyEdit>[1] = {}
    if (input.parameters !== undefined) {
      if (!isRecord(input.parameters)) throw new CadError('invalid_argument', 'parameters must be an object', { field: 'parameters' })
      edit.parameters = input.parameters as Record<string, number>
      for (const [key, value] of Object.entries(edit.parameters)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new CadError('invalid_argument', `parameter "${key}" must be a finite number`, { path: `parameters.${key}` })
        }
      }
    }
    if (input.addFeatures !== undefined) {
      if (!Array.isArray(input.addFeatures)) throw new CadError('invalid_argument', 'add_features must be an array', { field: 'add_features' })
      edit.addFeatures = input.addFeatures as CadDocument['features']
    }
    if (input.removeFeatures !== undefined) {
      if (!Array.isArray(input.removeFeatures)) throw new CadError('invalid_argument', 'remove_features must be an array', { field: 'remove_features' })
      edit.removeFeatures = input.removeFeatures as string[]
    }
    if (typeof input.name === 'string') edit.name = input.name.slice(0, this.config.limits.maxNameLength)
    if (typeof input.description === 'string') edit.description = input.description.slice(0, this.config.limits.maxNameLength)
    const nextDocument = applyEdit(current.document, edit, this.config)
    const formats = this.normalizeFormats(input.formats)
    const mutation = await this.store.allocateRevision({
      modelId: index.id,
      document: nextDocument,
      kind: 'modify',
      requestId: input.requestId ?? null,
      expectedRevision,
      formats,
    })
    // Name/description live on the model index; rewrite it when the edit changed them.
    let nextIndex = mutation.index
    if ((edit.name !== undefined && edit.name !== nextIndex.name) || (edit.description !== undefined && edit.description !== nextIndex.description)) {
      nextIndex = await this.store.updateModelIdentity(nextIndex.id, {
        name: edit.name ?? nextIndex.name,
        description: edit.description ?? nextIndex.description,
      })
    }
    return {
      modelId: nextIndex.id,
      modelName: nextIndex.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: 'modify',
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: input.build !== false,
      formats,
      ownerSession: input.ownerSession ?? null,
      index: nextIndex,
    }
  }

  /**
   * Rebuild the current document as a new revision (no document change).
   * @param input - rebuild input.
   * @returns the prepared build.
   */
  async prepareRebuild(input: {
    modelId: string
    expectedRevision: unknown
    requestId?: string | null
    ownerSession?: string | null
    formats?: unknown
  }): Promise<PreparedBuild> {
    this.requireWrite()
    const index = await this.store.readModel(input.modelId)
    const expectedRevision = typeof input.expectedRevision === 'number' && Number.isFinite(input.expectedRevision)
      ? Math.trunc(input.expectedRevision)
      : Number.NaN
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new CadError('invalid_argument', 'expected_revision must be an integer', { field: 'expected_revision' })
    }
    const current = await this.store.readDocument(index.id, expectedRevision > 0 ? expectedRevision : index.latestRevision)
    const formats = this.normalizeFormats(input.formats)
    const mutation = await this.store.allocateRevision({
      modelId: index.id,
      document: current.document,
      kind: 'rebuild',
      requestId: input.requestId ?? null,
      expectedRevision,
      formats,
    })
    return {
      modelId: mutation.index.id,
      modelName: mutation.index.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: 'rebuild',
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: true,
      formats,
      ownerSession: input.ownerSession ?? null,
      index: mutation.index,
    }
  }

  /** Serialize work per model. */
  private async withModelQueue<T>(modelId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.modelQueues.get(modelId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.modelQueues.set(modelId, tail)
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.modelQueues.get(modelId) === tail) this.modelQueues.delete(modelId)
    }
  }

  /** Bound concurrent builds by `maxConcurrentBuilds`; a queued build can be cancelled. */
  private async withBuildSlot<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    if (this.activeBuilds >= this.config.maxConcurrentBuilds) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          cleanup()
          resolve()
        }
        const onAbort = (): void => {
          cleanup()
          reject(new CadError('cancelled', 'the build was cancelled while queued'))
        }
        const cleanup = (): void => {
          const at = this.buildWaiters.indexOf(waiter)
          if (at !== -1) this.buildWaiters.splice(at, 1)
          signal?.removeEventListener('abort', onAbort)
        }
        if (signal?.aborted === true) {
          reject(new CadError('cancelled', 'the build was cancelled while queued'))
          return
        }
        this.buildWaiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    this.activeBuilds += 1
    try {
      return await task()
    } finally {
      this.activeBuilds -= 1
      const next = this.buildWaiters.shift()
      if (next !== undefined) next()
    }
  }

  /**
   * Persist a prepared-but-unsettled build as failed and release its write fence.
   * Idempotent: a revision that already has `revision.json` is left untouched.
   */
  private async failPrepared(prepared: PreparedBuild, error: unknown): Promise<void> {
    const revisionError = this.revisionErrorFrom(error, 'build_failed')
    try {
      const settled = await this.store.readRevision(prepared.modelId, prepared.revisionId).then(() => true).catch(() => false)
      if (!settled) {
        await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => undefined)
        await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion: {
            status: 'failed',
            report: null,
            artifacts: [],
            error: revisionError,
            warnings: [],
            durationMs: null,
            buildId: null,
          },
        })
      }
    } catch (storeError) {
      this.log('service: could not persist the abandoned revision', storeError)
    } finally {
      this.store.releasePending(prepared.modelId, prepared.number)
    }
  }

  /** Public form of `failPrepared` for a background start that was refused. */
  async discardPrepared(prepared: PreparedBuild, error: unknown): Promise<void> {
    await this.failPrepared(prepared, error)
  }

  /**
   * Execute one prepared build: call the runtime, verify artifacts, persist the
   * revision. A geometry failure persists a `failed` revision and keeps the
   * previous current revision; a transport failure persists it as failed too,
   * so nothing silently disappears.
   * @param prepared - allocation produced by a prepare step.
   * @param options - cancellation, progress.
   * @returns the model/revision payload.
   */
  async runBuild(prepared: PreparedBuild, options: BuildOptions = {}): Promise<Record<string, unknown>> {
    if (prepared.duplicate) return this.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true })
    if (!prepared.build) {
      const index = await this.store.markUnbuilt({
        modelId: prepared.modelId,
        revisionId: prepared.revisionId,
        number: prepared.number,
        buildKind: prepared.kind,
        buildRequestId: prepared.requestId,
        documentSha256: prepared.documentSha256,
        formats: prepared.formats,
        ownerSession: prepared.ownerSession,
      })
      prepared.index = index
      const detail = await this.revisionDetail(prepared.modelId, prepared.revisionId)
      return {
        ok: true,
        modelId: prepared.modelId,
        modelName: prepared.modelName,
        revisionId: prepared.revisionId,
        revision: prepared.number,
        status: 'unbuilt',
        duplicate: false,
        currentRevision: detail.index.currentRevision,
        latestRevision: detail.index.latestRevision,
        documentSha256: prepared.documentSha256,
        artifacts: [],
        report: null,
        warnings: [],
        error: null,
      }
    }
    if (options.signal?.aborted === true) {
      const cancelled = new CadError('cancelled', 'the build was cancelled before it started')
      await this.failPrepared(prepared, cancelled)
      throw cancelled
    }
    try {
      return await this.withBuildSlot(options.signal, () => this.withModelQueue(prepared.modelId, async () => {
      const started = Date.now()
      const requestId = options.runtimeRequestId ?? `rq-${randomUUID()}`
      const outputDir = this.store.revisionDirectory(prepared.modelId, prepared.revisionId)
      await mkdir(outputDir, { recursive: true })
      let result: ParsedBuildResult
      try {
        result = await this.runtime.build({
          requestId,
          model: { id: prepared.modelId, revisionId: prepared.revisionId },
          document: prepared.document,
          outputDir,
          formats: prepared.formats,
          checks: this.config.checks.length > 0 ? this.config.checks : null,
          limits: {
            maxBoundingBoxMm: this.config.maxBoundingBoxMm,
            maxArtifactBytes: this.config.maxArtifactBytes,
            maxFeatures: this.config.limits.maxFeatures,
            maxParameters: this.config.limits.maxParameters,
          },
          preview: prepared.formats.includes('svg') ? { view: 'iso', width: 1200, height: 900 } : null,
        }, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
          requestId,
        })
      } catch (error) {
        // Transport failure: persist the failed revision, then surface the error.
        await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => undefined)
        const revisionError = this.revisionErrorFrom(error)
        await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion: {
            status: 'failed',
            report: null,
            artifacts: [],
            error: revisionError,
            warnings: [],
            durationMs: Date.now() - started,
            buildId: null,
          },
        }).catch(storeError => this.log('service: could not persist the failed revision', storeError))
        throw error
      }
      const durationMs = Date.now() - started
      const report = result.report
      const failure = result.status === 'built' ? null : (result.error ?? {
        code: 'build_failed',
        message: 'the CAD build did not produce a valid solid',
        details: { checks: report?.checks ?? [] },
      })
      if (failure !== null) {
        await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => undefined)
        const completion: BuildCompletion = {
          status: 'failed',
          report,
          artifacts: [],
          error: failure,
          warnings: report?.warnings ?? [],
          durationMs,
          buildId: result.buildId,
        }
        await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion,
        })
        const code = failure.code === 'invalid_geometry' || failure.code === 'build_failed' || failure.code === 'export_failed'
          ? failure.code
          : 'build_failed'
        throw new CadError(code, failure.message, failure.details ?? { checks: report?.checks ?? [] })
      }
      let artifacts: ArtifactMeta[]
      try {
        artifacts = await this.store.verifyArtifacts(prepared.modelId, prepared.revisionId, result.artifacts, this.config.maxArtifactBytes)
      } catch (error) {
        await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => undefined)
        const revisionError = this.revisionErrorFrom(error, 'build_failed')
        await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion: {
            status: 'failed',
            report,
            artifacts: [],
            error: revisionError,
            warnings: report?.warnings ?? [],
            durationMs,
            buildId: result.buildId,
          },
        })
        throw error
      }
      const index = await this.store.completeBuild({
        modelId: prepared.modelId,
        revisionId: prepared.revisionId,
        number: prepared.number,
        buildKind: prepared.kind,
        buildRequestId: prepared.requestId,
        documentSha256: prepared.documentSha256,
        formats: prepared.formats,
        ownerSession: prepared.ownerSession,
        completion: {
          status: 'built',
          report,
          artifacts,
          error: null,
          warnings: report?.warnings ?? [],
          durationMs,
          buildId: result.buildId,
        },
      })
      prepared.index = index
      this.log(`service: built ${prepared.modelId}/${prepared.revisionId} (${String(artifacts.length)} artifacts, ${String(durationMs)} ms)`)
      return this.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: false })
      }))
    } catch (error) {
      // Covers a queued build cancelled before it ran, and a slot/queue failure:
      // the revision must never stay unbuilt-and-fenced.
      await this.failPrepared(prepared, error)
      throw error
    } finally {
      // The fence is normally released by completeBuild/markUnbuilt; this keeps
      // a store failure from wedging later writes to the same model.
      this.store.releasePending(prepared.modelId, prepared.number)
    }
  }

  /** Map any thrown error into the revision error recorded on disk. */
  private revisionErrorFrom(error: unknown, fallbackCode = 'build_failed'): RevisionError {
    if (error instanceof CadError) {
      return {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    }
    return {
      code: fallbackCode,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  /**
   * Build the canonical tool/API payload for a revision that already exists.
   * @param modelId - model id.
   * @param revisionId - revision id.
   * @param options - `duplicate` marks a replayed request_id.
   */
  async payloadForRevision(modelId: string, revisionId: string, options: { duplicate?: boolean } = {}): Promise<Record<string, unknown>> {
    const detail = await this.revisionDetail(modelId, revisionId)
    const meta = detail.meta
    return {
      ok: true,
      modelId: detail.index.id,
      modelName: detail.index.name,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      status: detail.summary.status,
      duplicate: options.duplicate === true,
      currentRevision: detail.index.currentRevision,
      latestRevision: detail.index.latestRevision,
      documentSha256: detail.summary.documentSha256,
      artifacts: detail.artifacts,
      report: detail.report,
      warnings: meta?.warnings ?? detail.report?.warnings ?? [],
      error: meta?.error ?? null,
      viewer: this.viewerBlock(detail.artifacts),
    }
  }

  /** Viewer URLs of one artifact set (glb/step/svg). */
  private viewerBlock(artifacts: ArtifactRef[]): Record<string, unknown> {
    const find = (format: string): string | null => artifacts.find(artifact => artifact.format === format)?.url ?? null
    return {
      glbUrl: find('glb'),
      stepUrl: find('step'),
      stlUrl: find('stl'),
      svgUrl: find('svg'),
      defaultView: 'iso',
      units: 'mm',
      upAxis: 'z',
    }
  }

  /** `GET /api/models/:id` payload (viewer contract, documented in api.ts). */
  async modelDetail(input: { modelId: string; revision?: unknown; historyLimit?: unknown; include?: unknown }): Promise<Record<string, unknown>> {
    const include = input.include === 'summary' || input.include === 'full' ? input.include : 'document'
    const payload = await this.inspectModel({
      modelId: input.modelId,
      revision: input.revision,
      include,
      historyLimit: input.historyLimit ?? 20,
    })
    const currentSummary = (payload.model as Record<string, unknown>).currentRevisionId as string | null
    if (currentSummary !== null) {
      const current = await this.revisionDetail(input.modelId, currentSummary)
      payload.viewer = this.viewerBlock(current.artifacts)
    } else {
      payload.viewer = { glbUrl: null, stepUrl: null, stlUrl: null, svgUrl: null, defaultView: 'iso', units: 'mm', upAxis: 'z' }
    }
    return payload
  }

  // ------------------------------------------------------------- validate/export

  /** `cad_validate_model`: structural + runtime geometry checks, no revision. */
  async validateModel(input: {
    modelId?: unknown
    revisionId?: unknown
    document?: unknown
    checks?: unknown
    signal?: AbortSignal
  }): Promise<Record<string, unknown>> {
    let document: CadDocument
    let modelId: string | null = null
    let revisionId: string | null = null
    let number: number | null = null
    if (input.document !== undefined) {
      document = validateDocument(input.document, this.config)
    } else {
      if (typeof input.modelId !== 'string' || input.modelId === '') {
        throw new CadError('invalid_argument', 'cad_validate_model needs either document or (model_id + optional revision_id)')
      }
      const detail = await this.revisionDetail(input.modelId, input.revisionId)
      if (detail.document === null) {
        throw new CadError('not_found', `revision ${detail.summary.revisionId} has no stored document`, { modelId: input.modelId })
      }
      document = detail.document
      modelId = detail.index.id
      revisionId = detail.summary.revisionId
      number = detail.summary.number
    }
    const checks = Array.isArray(input.checks)
      ? input.checks.filter((entry): entry is string => typeof entry === 'string')
      : null
    const result = await this.runtime.validateModel({
      document,
      checks,
    }, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: this.config.buildTimeoutMs,
    })
    return {
      ok: true,
      valid: result.valid,
      modelId,
      revisionId,
      revision: number,
      checks: result.checks,
      report: result.report,
      documentSha256: null,
    }
  }

  /**
   * `cad_export_model`: return artifact references and optionally copy the
   * bytes into the session workspace (workspace-relative, never overwriting
   * unless asked).
   * @param input - export request.
   * @returns exported files and their references.
   */
  async exportModel(input: ExportOptions): Promise<Record<string, unknown>> {
    if (!this.config.allowExport) {
      throw new CadError('permission_denied', 'artifact export is disabled (allowExport=false)')
    }
    const detail = await this.revisionDetail(input.modelId, input.revisionId)
    const formats = this.normalizeFormats(input.formats)
    const present = new Map(detail.artifacts.map(artifact => [artifact.format, artifact]))
    const missing = formats.filter(format => !present.has(format))
    let derived: ArtifactRef[] = []
    if (missing.length > 0) {
      if (detail.document === null) {
        throw new CadError('not_found', 'the selected revision has no stored document to re-export', { modelId: input.modelId })
      }
      derived = await this.buildDerivedArtifacts(detail.index.id, detail.summary.revisionId, detail.document, missing)
    }
    const selected = [...present.values(), ...derived].filter(artifact => formats.includes(artifact.format))
    if (selected.length === 0) {
      throw new CadError('export_failed', 'none of the requested formats could be produced', { formats })
    }
    const sources: Array<{ artifact: ArtifactRef; source: string }> = []
    for (const artifact of selected) {
      sources.push({ artifact, source: await this.artifactSourcePath(detail.index.id, detail.summary.revisionId, artifact) })
    }
    let written: string[] = []
    let outputDirectory: string | null = null
    if (typeof input.outputPath === 'string' && input.outputPath !== '') {
      if (typeof input.workspaceRoot !== 'string' || input.workspaceRoot === '') {
        throw new CadError('permission_denied', 'exporting into the workspace needs an available session workspace')
      }
      const copies = await copyArtifactsIntoWorkspace({
        workspaceRoot: input.workspaceRoot,
        outputPath: input.outputPath,
        files: sources.map(entry => ({ source: entry.source, fileName: entry.artifact.fileName })),
        overwrite: input.overwrite === true,
      })
      written = copies.written
      outputDirectory = relative(input.workspaceRoot, copies.directory)
    }
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      formats,
      exported: sources.map(entry => ({
        format: entry.artifact.format,
        fileName: entry.artifact.fileName,
        bytes: entry.artifact.bytes,
        sha256: entry.artifact.sha256,
        contentType: entry.artifact.contentType,
        path: written.find(candidate => candidate.endsWith(entry.artifact.fileName)) ?? null,
      })),
      outputPath: outputDirectory,
      artifacts: selected,
    }
  }

  /** Rebuild extra formats into a derived cache and return their references. */
  private async buildDerivedArtifacts(modelId: string, revisionId: string, document: CadDocument, formats: string[]): Promise<ArtifactRef[]> {
    const directory = await this.store.ensureStoreDirectory(['models', modelId, 'exports', revisionId])
    const requestId = `rq-${randomUUID()}`
    const result = await this.runtime.build({
      requestId,
      model: { id: modelId, revisionId },
      document,
      outputDir: directory,
      formats,
      checks: null,
      limits: {
        maxBoundingBoxMm: this.config.maxBoundingBoxMm,
        maxArtifactBytes: this.config.maxArtifactBytes,
        maxFeatures: this.config.limits.maxFeatures,
        maxParameters: this.config.limits.maxParameters,
      },
      preview: null,
    }, {
      timeoutMs: this.config.buildTimeoutMs,
      requestId,
    })
    if (result.status !== 'built') {
      const failure = result.error ?? { code: 'export_failed', message: 'the CAD runtime could not produce the requested formats' }
      throw new CadError(failure.code === 'export_failed' ? 'export_failed' : 'build_failed', failure.message, failure.details ?? { formats })
    }
    const verified = await this.store.verifyDeclaredArtifacts(['models', modelId, 'exports', revisionId], result.artifacts, this.config.maxArtifactBytes)
    return verified
      .filter(artifact => formats.includes(artifact.format))
      .map(artifact => ({
        artifactId: `${modelId}:${revisionId}:${artifact.format}`,
        format: artifact.format,
        fileName: artifact.fileName,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        contentType: artifact.contentType,
        url: `${ASSET_PREFIX}/models/${modelId}/${revisionId}/${artifact.fileName}`,
      }))
  }

  /** Absolute source path of one artifact (revision dir or derived cache). */
  private async artifactSourcePath(modelId: string, revisionId: string, artifact: ArtifactRef): Promise<string> {
    const revisionPath = await safePath(this.store.root, ['models', modelId, 'revisions', revisionId, artifact.fileName]).catch(() => null)
    if (revisionPath !== null && (await stat(revisionPath).then(info => info.isFile()).catch(() => false))) return revisionPath
    const derivedPath = await safePath(this.store.root, ['models', modelId, 'exports', revisionId, artifact.fileName]).catch(() => null)
    if (derivedPath !== null && (await stat(derivedPath).then(info => info.isFile()).catch(() => false))) return derivedPath
    throw new CadError('not_found', `artifact ${artifact.fileName} is not on disk`, { modelId, revisionId, fileName: artifact.fileName })
  }

  /**
   * `cad_render_preview`: build only an SVG projection into the derived preview
   * cache. Never creates a revision, so a preview cannot corrupt history.
   */
  async renderPreview(input: {
    modelId: string
    revisionId?: unknown
    view?: unknown
    width?: unknown
    height?: unknown
  }): Promise<Record<string, unknown>> {
    const detail = await this.revisionDetail(input.modelId, input.revisionId)
    if (detail.document === null) {
      throw new CadError('not_found', 'the selected revision has no stored document to render', { modelId: input.modelId })
    }
    const view = typeof input.view === 'string' && ['iso', 'front', 'top', 'right'].includes(input.view) ? input.view : 'iso'
    const width = clampLimit(input.width, 200, 4000, 1200)
    const height = clampLimit(input.height, 200, 4000, 900)
    const directory = await this.store.ensureStoreDirectory(['models', detail.index.id, 'previews', detail.summary.revisionId])
    const requestId = `rq-${randomUUID()}`
    const result = await this.runtime.build({
      requestId,
      model: { id: detail.index.id, revisionId: detail.summary.revisionId },
      document: detail.document,
      outputDir: directory,
      formats: ['svg'],
      checks: null,
      limits: {
        maxBoundingBoxMm: this.config.maxBoundingBoxMm,
        maxArtifactBytes: this.config.maxArtifactBytes,
        maxFeatures: this.config.limits.maxFeatures,
        maxParameters: this.config.limits.maxParameters,
      },
      preview: { view, width, height },
    }, {
      timeoutMs: this.config.buildTimeoutMs,
      requestId,
    })
    if (result.status !== 'built') {
      const failure = result.error ?? { code: 'build_failed', message: 'the CAD runtime could not render the preview' }
      throw new CadError(failure.code === 'export_failed' ? 'export_failed' : 'build_failed', failure.message, failure.details ?? { view })
    }
    const verified = await this.store.verifyDeclaredArtifacts(
      ['models', detail.index.id, 'previews', detail.summary.revisionId],
      result.artifacts,
      this.config.maxArtifactBytes,
    )
    const preview = verified.find(artifact => artifact.format === 'svg')
    if (preview === undefined) {
      throw new CadError('export_failed', 'the CAD runtime did not produce preview.svg', { view })
    }
    const ref = previewRef(detail.index.id, detail.summary.revisionId, preview)
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      view,
      width,
      height,
      format: 'svg',
      artifact: ref,
      tempFile: null,
    }
  }

  /** Resolve the parameter values actually used by a revision (tool convenience). */
  async resolvedParameters(modelId: string, revision?: unknown): Promise<Record<string, number>> {
    const detail = await this.revisionDetail(modelId, revision)
    const parameters = detail.document?.parameters ?? {}
    const resolved: Record<string, number> = {}
    for (const [name, value] of Object.entries(parameters)) {
      const number = resolveNumber(value, parameters)
      if (number !== null) resolved[name] = number
    }
    return resolved
  }

  /** True when at least one model exists (used by the client's empty state). */
  async hasModels(): Promise<boolean> {
    return (await this.store.countModels()) > 0
  }
}

/** realpath that tolerates macOS `/var` → `/private/var` spelling. */
async function realpathOf(path: string): Promise<string> {
  return realpath(path)
}
