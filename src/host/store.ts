/**
 * Durable, revisioned model store.
 *
 * Layout under `<dataDir>/`:
 *
 * ```
 * models/<modelId>/model.json                 model index (pointer + revision summaries)
 * models/<modelId>/revisions/r-0001/document.json    immutable document snapshot
 * models/<modelId>/revisions/r-0001/revision.json    immutable revision metadata
 * models/<modelId>/revisions/r-0001/report.json      geometry report
 * models/<modelId>/revisions/r-0001/artifacts?       (files live directly in r-0001/)
 * models/<modelId>/previews/<revisionId>/preview.svg derived cache (never authoritative)
 * requests.json                               request_id → revision idempotency index
 * ```
 *
 * Invariants enforced here, not in callers:
 *   - a revision directory is written once; `completeBuild` only writes
 *     `revision.json`/`report.json` *inside* the already-allocated revision;
 *   - every file is written with tmp-file + fsync + rename, so a crash leaves
 *     either the old bytes or the new bytes, never a torn file;
 *   - revision numbers are monotonic and never reused;
 *   - `expected_revision` is checked against the current pointer under a
 *     per-model in-memory lock, and `request_id` replay returns the existing
 *     revision instead of creating another;
 *   - every read/write path goes through `safePath`, so neither `..` nor a
 *     symlink can leave the store root;
 *   - nothing is deleted on dispose/uninstall: failed revisions are persisted
 *     for diagnosis and user data is never removed.
 * @module host/store
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CadError, DOCUMENT_SCHEMA } from './contracts.ts'
import type { CadConfig } from './config.ts'
import {
  ARTIFACT_FILE_NAMES,
  ARTIFACT_FORMAT_FILES,
  assertModelId,
  assertRevisionId,
  assertSegment,
  contentTypeForFileName,
  isInside,
  revisionIdOf,
  safePath,
} from './paths.ts'
import type {
  ArtifactMeta,
  BuildKind,
  CadDocument,
  GeometryReport,
  LoadedModel,
  ModelIndex,
  RevisionError,
  RevisionMeta,
  RevisionStatus,
  RevisionSummary,
  RuntimeArtifact,
  ReportCheck,
} from './types.ts'

/** Schema id of the persisted model index. */
const MODEL_SCHEMA = 'dsh.cad/model@1'

/** Schema id of the persisted revision record. */
const REVISION_SCHEMA = 'dsh.cad/revision@1'

/** Version of the root-level request index. */
const REQUESTS_VERSION = 1

/** Cap on remembered request ids (oldest dropped first). */
const MAX_REQUEST_RECORDS = 1000

/** Contracts the store needs from its caller. */
export interface CadStoreOptions {
  root: string
  limits: CadConfig['limits']
  log?: (message: string, error?: unknown) => void
}

/** One allocated but not-yet-built revision. */
export interface RevisionAllocation {
  number: number
  revisionId: string
  document: CadDocument
  documentSha256: string
  formats: string[]
  duplicate: boolean
}

/** Result of a create/modify store transaction. */
export interface StoreMutation {
  index: ModelIndex
  allocation: RevisionAllocation
  /** True when `request_id` replay returned an existing revision. */
  duplicate: boolean
}

/** Build result handed back to the store for persistence. */
export interface BuildCompletion {
  status: Exclude<RevisionStatus, 'unbuilt'>
  report: GeometryReport | null
  artifacts: ArtifactMeta[]
  error: RevisionError | null
  warnings: string[]
  durationMs: number | null
  buildId: string | null
}

/** Root-level request index file. */
interface RequestIndexFile {
  version: number
  entries: Record<string, { modelId: string; number: number; kind: string; at: string }>
}

/** sha256 hex of a buffer or string. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Timestamp helper: ISO-8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** A model id: `m-` plus 10 lowercase hex characters. */
export function newModelId(): string {
  return `m-${randomBytes(5).toString('hex')}`
}

/** Serialize JSON deterministically enough for hashing (stable key order). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      const ordered: Record<string, unknown> = {}
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        ordered[key] = (inner as Record<string, unknown>)[key]
      }
      return ordered
    }
    return inner
  }, 2)
}

/** Validate and normalize a runtime-declared artifact. */
function normalizeRuntimeArtifact(raw: unknown, limits: CadConfig['limits']): { format: string; fileName: string; bytes: number; sha256: string } | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const format = record.format
  if (typeof format !== 'string' || !Object.hasOwn(ARTIFACT_FORMAT_FILES, format)) return null
  const fileName = typeof record.fileName === 'string' && record.fileName !== ''
    ? record.fileName
    : ARTIFACT_FORMAT_FILES[format]
  if (fileName.length > limits.maxArtifactNameLength) return null
  if (ARTIFACT_FILE_NAMES[fileName] !== format) return null
  const bytes = record.bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 134_217_728) return null
  const sha256 = record.sha256
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) return null
  return { format, fileName, bytes, sha256 }
}

/** Count check verdicts for a revision summary. */
function summarizeChecks(checks: ReportCheck[]): { pass: number; fail: number; warn: number } {
  const counts = { pass: 0, fail: 0, warn: 0 }
  for (const check of checks) counts[check.status] += 1
  return counts
}

/** Project a full report into the compact summary kept in the model index. */
function summarizeReport(report: GeometryReport | null): RevisionSummary['reportSummary'] {
  if (report === null) return null
  const totalMs = typeof report.timings.totalMs === 'number' && Number.isFinite(report.timings.totalMs) ? report.timings.totalMs : null
  return {
    volume: report.volume,
    boundingBoxSize: report.boundingBox === null ? null : report.boundingBox.size,
    checks: summarizeChecks(report.checks),
    totalMs,
  }
}

/** Coerce unknown JSON into a finite number or null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Coerce an unknown triple into a finite numeric tuple or null. */
function tupleOrNull(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const numbers = value.map(entry => finiteOrNull(entry))
  if (numbers.some(entry => entry === null)) return null
  return numbers as [number, number, number]
}

/**
 * Normalize a runtime geometry report: keep only known keys, finite numbers and
 * known check statuses, so a buggy runtime cannot poison the store or a tool
 * result with non-JSON values.
 * @param raw - runtime-reported report object.
 * @returns a sanitized report, or null when the runtime sent nothing usable.
 */
export function sanitizeReport(raw: unknown, valid = true): GeometryReport | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const bboxRaw = record.boundingBox
  const bbox = bboxRaw !== null && typeof bboxRaw === 'object'
    ? (() => {
        const box = bboxRaw as Record<string, unknown>
        const min = tupleOrNull(box.min)
        const max = tupleOrNull(box.max)
        const size = tupleOrNull(box.size)
        if (min === null || max === null || size === null) return null
        return { min, max, size }
      })()
    : null
  const topologyRaw = record.topology !== null && typeof record.topology === 'object'
    ? (record.topology as Record<string, unknown>)
    : null
  const topology = topologyRaw === null
    ? null
    : {
        faces: finiteOrNull(topologyRaw.faces) ?? 0,
        edges: finiteOrNull(topologyRaw.edges) ?? 0,
        vertices: finiteOrNull(topologyRaw.vertices) ?? 0,
        solids: finiteOrNull(topologyRaw.solids) ?? 0,
      }
  const checks: ReportCheck[] = Array.isArray(record.checks)
    ? record.checks.flatMap(entry => {
        if (entry === null || typeof entry !== 'object') return []
        const check = entry as Record<string, unknown>
        const status = check.status
        if (status !== 'pass' && status !== 'fail' && status !== 'warn') return []
        return [{
          id: typeof check.id === 'string' ? check.id : 'unknown',
          status,
          message: typeof check.message === 'string' ? check.message : '',
        }]
      })
    : []
  const featureReportsRaw = Array.isArray(record.featureReports) ? record.featureReports : []
  const featureReports: import('./types.ts').FeatureReport[] = featureReportsRaw.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return []
    const feature = entry as Record<string, unknown>
    const status = feature.status
    if (status !== 'pass' && status !== 'fail' && status !== 'warn') return []
    return [{
      id: typeof feature.id === 'string' ? feature.id : 'unknown',
      op: typeof feature.op === 'string' ? feature.op : 'unknown',
      status,
      detail: typeof feature.detail === 'string' ? feature.detail : '',
    }]
  })
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((entry): entry is string => typeof entry === 'string').slice(0, 64)
    : []
  const timings: Record<string, number> = {}
  if (record.timings !== null && typeof record.timings === 'object') {
    for (const [key, value] of Object.entries(record.timings as Record<string, unknown>)) {
      const number = finiteOrNull(value)
      if (number !== null) timings[key] = number
    }
  }
  return {
    valid,
    volume: finiteOrNull(record.volume),
    surfaceArea: finiteOrNull(record.surfaceArea),
    boundingBox: bbox,
    bbox,
    centroid: tupleOrNull(record.centroid),
    topology,
    checks,
    featureReports,
    warnings,
    timings,
  }
}

/** Normalize a runtime-declared revision error. */
export function sanitizeRevisionError(raw: unknown): RevisionError | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null
  const details = record.details !== null && typeof record.details === 'object' && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined
  return { code: record.code, message: record.message, ...(details === undefined ? {} : { details }) }
}

/**
 * The model store. One instance per plugin activation; all state is on disk
 * except the per-model serialization locks and the request-id cache.
 */
export class CadStore {
  /** Absolute store root (`<dataDir>`). */
  readonly root: string
  private readonly limits: CadConfig['limits']
  private readonly log: (message: string, error?: unknown) => void
  private readonly locks = new Map<string, Promise<unknown>>()
  /** `${modelId}:${number}` of revisions allocated but not yet settled on disk. */
  private readonly pendingAllocations = new Set<string>()
  private readonly requestCache = new Map<string, { modelId: string; number: number; kind: string; at: string }>()
  private readyPromise: Promise<void> | null = null

  constructor(options: CadStoreOptions) {
    this.root = options.root
    this.limits = options.limits
    this.log = options.log ?? (() => undefined)
  }

  /** Create the store root once; every public method awaits this. */
  async ready(): Promise<void> {
    this.readyPromise ??= mkdir(this.root, { recursive: true }).then(() => undefined)
    await this.readyPromise
  }

  /** Absolute path of the models root. */
  modelsRoot(): string {
    return join(this.root, 'models')
  }

  /** Absolute path of one model directory (validated id only). */
  modelDirectory(modelId: string): string {
    return join(this.root, 'models', assertModelId(modelId))
  }

  /** Absolute path of one revision directory. */
  revisionDirectory(modelId: string, revisionId: string): string {
    return join(this.modelDirectory(modelId), 'revisions', assertRevisionId(revisionId))
  }

  /** Absolute path of the preview cache directory of one revision. */
  previewDirectory(modelId: string, revisionId: string): string {
    return join(this.modelDirectory(modelId), 'previews', assertRevisionId(revisionId))
  }

  /**
   * Serialize work per key (one model, or the global request index).
   * @param key - lock key.
   * @param task - work to run exclusively.
   * @returns the task result.
   */
  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.locks.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  /** Write bytes atomically: tmp file → fsync → rename. */
  async writeAtomic(target: string, data: Buffer | string): Promise<void> {
    const directory = dirname(target)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.tmp-${randomUUID()}`)
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  /** Read and parse a JSON file, mapping ENOENT to null. */
  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  // ---------------------------------------------------------------- requests

  /** Read the root-level request index (bounded; caps prune oldest). */
  private async readRequestIndex(): Promise<RequestIndexFile> {
    const file = await this.readJson<RequestIndexFile>(join(this.root, 'requests.json'))
    if (file === null || file.version !== REQUESTS_VERSION || file.entries === null || typeof file.entries !== 'object') {
      return { version: REQUESTS_VERSION, entries: {} }
    }
    return file
  }

  /** Resolve a request id to the model+revision it created, or null. */
  async lookupRequest(requestId: string): Promise<{ modelId: string; number: number; kind: string; at: string } | null> {
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) return cached
    await this.ready()
    const index = await this.readRequestIndex()
    const entry = index.entries[requestId]
    if (entry === undefined) return null
    this.requestCache.set(requestId, entry)
    return entry
  }

  /** Record one request id atomically (called inside the model lock). */
  private async recordRequest(requestId: string, entry: { modelId: string; number: number; kind: string; at: string }): Promise<void> {
    this.requestCache.set(requestId, entry)
    await this.withLock('requests', async () => {
      const index = await this.readRequestIndex()
      index.entries[requestId] = entry
      const keys = Object.keys(index.entries)
      if (keys.length > MAX_REQUEST_RECORDS) {
        keys.sort((left, right) => (index.entries[left]!.at < index.entries[right]!.at ? -1 : 1))
        for (const key of keys.slice(0, keys.length - MAX_REQUEST_RECORDS)) {
          delete index.entries[key]
          this.requestCache.delete(key)
        }
      }
      await this.writeAtomic(join(this.root, 'requests.json'), JSON.stringify(index))
    })
  }

  // ------------------------------------------------------------------ models

  /** Read one model index, or throw `not_found`. */
  async readModel(modelId: string): Promise<ModelIndex> {
    await this.ready()
    const id = assertModelId(modelId)
    const target = await safePath(this.root, ['models', id, 'model.json'])
    const index = await this.readJson<ModelIndex>(target)
    if (index === null) {
      throw new CadError('not_found', `model ${id} does not exist`, { modelId: id })
    }
    return index
  }

  /** Read one model index and its document for `revisionNumber` (default current). */
  async readDocument(modelId: string, revisionNumber?: number): Promise<{ document: CadDocument; number: number; revisionId: string }> {
    const index = await this.readModel(modelId)
    const number = revisionNumber ?? (index.currentRevision > 0 ? index.currentRevision : index.latestRevision)
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new CadError('not_found', `model ${modelId} has no revision`, { modelId })
    }
    const revisionId = revisionIdOf(number)
    const target = await safePath(this.root, ['models', index.id, 'revisions', revisionId, 'document.json'])
    const document = await this.readJson<CadDocument>(target)
    if (document === null) {
      throw new CadError('not_found', `revision ${revisionId} of model ${modelId} has no document`, { modelId, revisionId })
    }
    return { document, number, revisionId }
  }

  /** Read revision metadata (`revision.json`) and report. */
  async readRevision(modelId: string, revisionId: string): Promise<{ meta: RevisionMeta; document: CadDocument; report: GeometryReport | null }> {
    const index = await this.readModel(modelId)
    const id = assertRevisionId(revisionId)
    const base = ['models', index.id, 'revisions', id]
    const meta = await this.readJson<RevisionMeta>(await safePath(this.root, [...base, 'revision.json']))
    if (meta === null) {
      const exists = index.revisions.some(revision => revision.revisionId === id)
      throw new CadError('not_found', exists ? `revision ${id} is not complete yet` : `revision ${id} does not exist`, { modelId, revisionId: id })
    }
    const document = await this.readJson<CadDocument>(await safePath(this.root, [...base, 'document.json']))
    const report = await this.readJson<GeometryReport>(await safePath(this.root, [...base, 'report.json']))
    if (document === null) {
      throw new CadError('not_found', `revision ${id} of model ${modelId} has no document`, { modelId, revisionId: id })
    }
    return { meta, document, report }
  }

  /** Every model index in the store (no ownership fence: single-user desktop). */
  async listModels(): Promise<ModelIndex[]> {
    await this.ready()
    const root = this.modelsRoot()
    await mkdir(root, { recursive: true })
    const entries = await readdir(root, { withFileTypes: true })
    const models: ModelIndex[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        if (!/^m-[0-9a-f]{10}$/u.test(entry.name)) continue
        models.push(await this.readModel(entry.name))
      } catch (error) {
        this.log(`store: skipping unreadable model ${entry.name}`, error)
      }
    }
    models.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0))
    return models
  }

  /** Write the model index atomically. */
  private async writeModel(index: ModelIndex): Promise<void> {
    const target = await safePath(this.root, ['models', index.id], { createParent: true, kind: 'dir' })
    const path = join(target, 'model.json')
    await this.writeAtomic(path, `${stableJson(index)}\n`)
  }

  /** Build the initial (empty) model index. */
  private emptyIndex(modelId: string, input: { name: string; description: string; ownerSession: string | null }): ModelIndex {
    const at = nowIso()
    return {
      schema: MODEL_SCHEMA,
      id: modelId,
      modelId,
      name: input.name,
      description: input.description,
      createdAt: at,
      updatedAt: at,
      currentRevision: 0,
      latestRevision: 0,
      nextRevision: 1,
      revisions: [],
      requests: {},
      metadata: {},
      ownerSession: input.ownerSession,
      owner: { sessionId: input.ownerSession },
    }
  }

  /**
   * Create a model and allocate its first (unbuilt) revision in one transaction.
   * @param input - model identity, document snapshot and idempotency key.
   * @returns the index plus the revision allocation.
   */
  async createModel(input: {
    name: string
    description: string
    document: CadDocument
    ownerSession: string | null
    requestId: string | null
    formats: string[]
  }): Promise<StoreMutation> {
    await this.ready()
    return this.withLock('create', async () => {
      if (input.requestId !== null) {
        const existing = await this.lookupRequest(input.requestId)
        if (existing !== null) {
          const index = await this.readModel(existing.modelId)
          const revision = index.revisions.find(entry => entry.number === existing.number)
          const documentRead = await this.readDocument(existing.modelId, existing.number).catch(() => null)
          if (revision !== undefined && documentRead !== null) {
            return {
              index,
              duplicate: true,
              allocation: {
                number: revision.number,
                revisionId: revision.revisionId,
                document: documentRead.document,
                documentSha256: revision.documentSha256,
                formats: revision.artifacts.map(artifact => artifact.format),
                duplicate: true,
              },
            }
          }
        }
      }
      await mkdir(this.modelsRoot(), { recursive: true })
      let modelId = newModelId()
      let created = false
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await mkdir(join(this.modelsRoot(), modelId), { recursive: false })
          created = true
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          modelId = newModelId()
        }
      }
      if (!created) throw new CadError('internal', 'could not allocate a model id')
      const index = this.emptyIndex(modelId, input)
      const allocation = await this.allocateLocked(index, {
        document: input.document,
        kind: 'create',
        requestId: input.requestId,
        expectedRevision: 0,
        formats: input.formats,
      })
      return { index: allocation.index, allocation: allocation.allocation, duplicate: false }
    })
  }

  /**
   * Allocate the next revision of an existing model and persist its document.
   * @param input - edit outcome and concurrency/idempotency keys.
   * @returns the updated index plus the allocation.
   */
  async allocateRevision(input: {
    modelId: string
    document: CadDocument
    kind: BuildKind
    requestId: string | null
    expectedRevision: number
    formats: string[]
  }): Promise<StoreMutation> {
    const modelId = assertModelId(input.modelId)
    return this.withLock(`model:${modelId}`, async () => {
      if (input.requestId !== null) {
        const existing = await this.lookupRequest(input.requestId)
        if (existing !== null) {
          const index = await this.readModel(modelId)
          const revision = index.revisions.find(entry => entry.number === existing.number)
          const documentRead = await this.readDocument(modelId, existing.number).catch(() => null)
          if (revision !== undefined && documentRead !== null) {
            return {
              index,
              duplicate: true,
              allocation: {
                number: revision.number,
                revisionId: revision.revisionId,
                document: documentRead.document,
                documentSha256: revision.documentSha256,
                formats: revision.artifacts.map(artifact => artifact.format),
                duplicate: true,
              },
            }
          }
          throw new CadError('not_found', `request ${input.requestId} references a revision that no longer exists`, { modelId, revisionId: existing.number })
        }
      }
      const index = await this.readModel(modelId)
      // The edit is based on the current (last successful) revision. A retry
      // after a failed build may also base itself on that failed revision; a
      // *pending* (unbuilt) revision is a write in flight, so a second writer
      // from an older base is refused instead of silently losing an update.
      const inFlight = [...this.pendingAllocations].find(key => key.startsWith(`${modelId}:`))
      if (inFlight !== undefined) {
        throw new CadError('model_locked', `another write is still in flight for model ${modelId}; inspect and retry`, {
          modelId,
          pendingRevisionId: revisionIdOf(Number(inFlight.slice(modelId.length + 1))),
          currentRevision: index.currentRevision,
          latestRevision: index.latestRevision,
        })
      }
      const latest = index.revisions.find(entry => entry.number === index.latestRevision)
      const allowed = new Set<number>([index.currentRevision])
      if (latest !== undefined && latest.status === 'failed') allowed.add(latest.number)
      if (latest !== undefined && latest.status === 'unbuilt' && latest.number === input.expectedRevision) allowed.add(latest.number)
      if (!allowed.has(input.expectedRevision)) {
        const pending = latest !== undefined && latest.status === 'unbuilt'
        throw new CadError(
          pending ? 'model_locked' : 'revision_conflict',
          pending
            ? `another write is still in flight for model ${modelId} (revision ${latest.revisionId}); inspect and retry`
            : `expected revision ${String(input.expectedRevision)} but the model is at ${String(index.currentRevision)}`,
          {
            modelId,
            expectedRevision: input.expectedRevision,
            currentRevision: index.currentRevision,
            latestRevision: index.latestRevision,
            ...(pending ? { pendingRevisionId: latest.revisionId } : {}),
          },
        )
      }
      return this.allocateLocked(index, input)
    })
  }

  /** Allocate a revision inside an already-held model lock. */
  private async allocateLocked(
    index: ModelIndex,
    input: { document: CadDocument; kind: BuildKind; requestId: string | null; expectedRevision: number; formats: string[] },
  ): Promise<{ index: ModelIndex; allocation: RevisionAllocation; duplicate: boolean }> {
    const number = index.nextRevision
    const revisionId = revisionIdOf(number)
    const documentBytes = Buffer.from(`${stableJson({ ...input.document, schema: DOCUMENT_SCHEMA })}\n`, 'utf8')
    const documentSha256 = sha256Hex(documentBytes)
    const base = ['models', index.id, 'revisions', revisionId]
    const revisionDir = await safePath(this.root, base, { createParent: true, kind: 'dir' })
    await this.writeAtomic(join(revisionDir, 'document.json'), documentBytes)
    const at = nowIso()
    const summary: RevisionSummary = {
      number,
      revisionId,
      status: 'unbuilt',
      createdAt: at,
      builtAt: null,
      documentSha256,
      artifacts: [],
      errorCode: null,
      reportSummary: null,
    }
    const next: ModelIndex = {
      ...index,
      updatedAt: at,
      latestRevision: number,
      nextRevision: number + 1,
      revisions: [...index.revisions, summary],
      requests: input.requestId === null
        ? index.requests
        : { ...index.requests, [input.requestId]: { number, kind: input.kind, at } },
    }
    await this.writeModel(next)
    this.pendingAllocations.add(`${index.id}:${number}`)
    if (input.requestId !== null) {
      await this.recordRequest(input.requestId, { modelId: index.id, number, kind: input.kind, at })
    }
    return {
      index: next,
      duplicate: false,
      allocation: {
        number,
        revisionId,
        document: { ...input.document, schema: DOCUMENT_SCHEMA },
        documentSha256,
        formats: input.formats,
        duplicate: false,
      },
    }
  }

  /**
   * Verify runtime-declared artifacts against the bytes actually written.
   *
   * A hostile or buggy runtime cannot poison the store: each declaration must
   * name one of the fixed artifact files of its format, live directly in the
   * revision directory as a regular non-symlink file, and match both its byte
   * size and sha256.
   * @param modelId - model id.
   * @param revisionId - revision id (already allocated, directory exists).
   * @param declared - runtime artifact declarations.
   * @returns verified artifact metadata, in the runtime's order.
   * @throws {CadError} `build_failed` when a declaration does not match its file.
   */
  async verifyArtifacts(modelId: string, revisionId: string, declared: unknown, maxArtifactBytes: number): Promise<ArtifactMeta[]> {
    return this.verifyDeclaredArtifacts(['models', modelId, 'revisions', revisionId], declared, maxArtifactBytes)
  }

  /**
   * Generic artifact verifier for any directory inside the store (revision
   * artifacts, derived export caches, preview caches).
   * @param baseSegments - directory segments under the store root.
   * @param declared - runtime artifact declarations.
   * @param maxArtifactBytes - per-file byte cap.
   * @returns verified artifact metadata in declaration order.
   */
  async verifyDeclaredArtifacts(baseSegments: string[], declared: unknown, maxArtifactBytes: number): Promise<ArtifactMeta[]> {
    if (!Array.isArray(declared)) return []
    const verified: ArtifactMeta[] = []
    const seen = new Set<string>()
    for (const entry of declared) {
      const artifact = normalizeRuntimeArtifact(entry, this.limits)
      if (artifact === null) {
        throw new CadError('build_failed', 'the runtime declared an artifact with an invalid shape', {
          artifact: entry,
        })
      }
      if (seen.has(artifact.fileName)) {
        throw new CadError('build_failed', `the runtime declared artifact ${artifact.fileName} twice`)
      }
      seen.add(artifact.fileName)
      if (artifact.bytes > maxArtifactBytes) {
        throw new CadError('too_large', `artifact ${artifact.fileName} exceeds maxArtifactBytes (${String(maxArtifactBytes)})`, {
          fileName: artifact.fileName,
          bytes: artifact.bytes,
          maxArtifactBytes,
        })
      }
      const target = await safePath(this.root, [...baseSegments, artifact.fileName])
      const info = await stat(target).catch(() => null)
      if (info === null || !info.isFile()) {
        throw new CadError('build_failed', `the runtime declared ${artifact.fileName} but did not write a regular file there`, {
          fileName: artifact.fileName,
        })
      }
      if (info.size !== artifact.bytes) {
        throw new CadError('build_failed', `artifact ${artifact.fileName} is ${String(info.size)} bytes but the runtime declared ${String(artifact.bytes)}`, {
          fileName: artifact.fileName,
          bytes: info.size,
          declaredBytes: artifact.bytes,
        })
      }
      const bytes = await readFile(target)
      const actual = sha256Hex(bytes)
      if (actual !== artifact.sha256) {
        throw new CadError('build_failed', `artifact ${artifact.fileName} does not match its declared sha256`, {
          fileName: artifact.fileName,
          sha256: actual,
          declaredSha256: artifact.sha256,
        })
      }
      const contentType = contentTypeForFileName(artifact.fileName) ?? 'application/octet-stream'
      verified.push({ format: artifact.format, fileName: artifact.fileName, bytes: info.size, sha256: actual, contentType })
    }
    return verified
  }

  /**
   * Persist the outcome of one build into its already-allocated revision and
   * move the current pointer when it succeeded.
   * @param input - revision identity plus the build outcome.
   * @returns the updated model index.
   */
  async completeBuild(input: {
    modelId: string
    revisionId: string
    number: number
    buildKind: BuildKind
    buildRequestId: string | null
    documentSha256: string
    formats: string[]
    ownerSession: string | null
    completion: BuildCompletion
  }): Promise<ModelIndex> {
    const modelId = assertModelId(input.modelId)
    return this.withLock(`model:${modelId}`, async () => {
      const index = await this.readModel(modelId)
      const summary = index.revisions.find(entry => entry.number === input.number)
      if (summary === undefined) {
        throw new CadError('internal', `revision ${input.revisionId} was never allocated`, { modelId, revisionId: input.revisionId })
      }
      const completion = input.completion
      const meta: RevisionMeta = {
        schema: REVISION_SCHEMA,
        modelId,
        revisionId: input.revisionId,
        number: input.number,
        status: completion.status,
        createdAt: summary.createdAt,
        builtAt: nowIso(),
        buildRequestId: input.buildRequestId,
        buildKind: input.buildKind,
        documentSha256: input.documentSha256,
        formats: input.formats,
        durationMs: completion.durationMs,
        report: completion.report,
        error: completion.error,
        warnings: completion.warnings,
        artifacts: completion.artifacts,
        ownerSession: input.ownerSession,
        buildId: completion.buildId,
      }
      const base = ['models', modelId, 'revisions', input.revisionId]
      await this.writeAtomic(join(await safePath(this.root, base), 'revision.json'), `${stableJson(meta)}\n`)
      if (completion.report !== null) {
        await this.writeAtomic(join(await safePath(this.root, base), 'report.json'), `${stableJson(completion.report)}\n`)
      }
      const nextSummary: RevisionSummary = {
        number: input.number,
        revisionId: input.revisionId,
        status: completion.status,
        createdAt: summary.createdAt,
        builtAt: meta.builtAt,
        documentSha256: input.documentSha256,
        artifacts: completion.artifacts,
        errorCode: completion.error === null ? null : completion.error.code,
        reportSummary: summarizeReport(completion.report),
      }
      const revisions = index.revisions.map(entry => (entry.number === input.number ? nextSummary : entry))
      const currentRevision = completion.status === 'built' ? input.number : index.currentRevision
      const next: ModelIndex = {
        ...index,
        updatedAt: nowIso(),
        currentRevision,
        revisions,
      }
      await this.writeModel(next)
      this.pendingAllocations.delete(`${modelId}:${input.number}`)
      return next
    })
  }

  /**
   * Persist an allocated revision without building it (`build:false`), so the
   * revision is readable and later rebuildable but never appears as current.
   * @param input - revision identity and document digest.
   * @returns the unchanged model index.
   */
  async markUnbuilt(input: {
    modelId: string
    revisionId: string
    number: number
    buildKind: BuildKind
    buildRequestId: string | null
    documentSha256: string
    formats: string[]
    ownerSession: string | null
  }): Promise<ModelIndex> {
    const modelId = assertModelId(input.modelId)
    return this.withLock(`model:${modelId}`, async () => {
      const index = await this.readModel(modelId)
      const summary = index.revisions.find(entry => entry.number === input.number)
      if (summary === undefined) {
        throw new CadError('internal', `revision ${input.revisionId} was never allocated`, { modelId, revisionId: input.revisionId })
      }
      const meta: RevisionMeta = {
        schema: REVISION_SCHEMA,
        modelId,
        revisionId: input.revisionId,
        number: input.number,
        status: 'unbuilt',
        createdAt: summary.createdAt,
        builtAt: null,
        buildRequestId: input.buildRequestId,
        buildKind: input.buildKind,
        documentSha256: input.documentSha256,
        formats: input.formats,
        durationMs: null,
        report: null,
        error: null,
        warnings: [],
        artifacts: [],
        ownerSession: input.ownerSession,
        buildId: null,
      }
      const base = ['models', modelId, 'revisions', input.revisionId]
      await this.writeAtomic(join(await safePath(this.root, base), 'revision.json'), `${stableJson(meta)}\n`)
      this.pendingAllocations.delete(`${modelId}:${input.number}`)
      return index
    })
  }

  /** Release the in-flight write fence of one allocation (crash-safe cleanup). */
  releasePending(modelId: string, number: number): void {
    this.pendingAllocations.delete(`${modelId}:${number}`)
  }

  /** Remove every file the runtime wrote in a revision directory except the document. */
  async clearRevisionArtifacts(modelId: string, revisionId: string, formats: string[]): Promise<void> {
    for (const format of formats) {
      const fileName = ARTIFACT_FORMAT_FILES[format]
      if (fileName === undefined) continue
      const target = await safePath(this.root, ['models', assertModelId(modelId), 'revisions', assertRevisionId(revisionId), fileName]).catch(() => null)
      if (target !== null) await unlink(target).catch(() => undefined)
    }
  }

  /** Write one derived preview into the non-authoritative preview cache. */
  async writePreview(modelId: string, revisionId: string, fileName: string, bytes: Buffer): Promise<string> {
    assertSegment(fileName, 'preview file name')
    if (fileName !== 'preview.svg') {
      throw new CadError('invalid_argument', 'only preview.svg is produced by cad_render_preview', { fileName })
    }
    const directory = await safePath(this.root, ['models', assertModelId(modelId), 'previews', assertRevisionId(revisionId)], { createParent: true, kind: 'dir' })
    const target = join(directory, fileName)
    await this.writeAtomic(target, bytes)
    return target
  }

  /** Read verified artifact bytes for the API asset route. */
  async readArtifact(modelId: string, revisionId: string, fileName: string): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
    const contentType = contentTypeForFileName(fileName)
    if (contentType === null) {
      throw new CadError('not_found', `unsupported artifact ${JSON.stringify(fileName)}`, { fileName })
    }
    const target = await safePath(this.root, ['models', assertModelId(modelId), 'revisions', assertRevisionId(revisionId), fileName])
    const bytes = await readFile(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CadError('not_found', `artifact ${fileName} does not exist for revision ${revisionId}`, { modelId, revisionId, fileName })
      }
      throw error
    })
    const info = await stat(target).catch(() => null)
    if (info === null || !info.isFile()) {
      throw new CadError('not_found', `artifact ${fileName} is not a regular file`, { fileName })
    }
    return { bytes, contentType, sha256: sha256Hex(bytes) }
  }

  /** Read a derived preview file (same traversal protection as artifacts). */
  async readPreview(modelId: string, revisionId: string, fileName: string): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
    if (fileName !== 'preview.svg') {
      throw new CadError('not_found', `unsupported preview ${JSON.stringify(fileName)}`, { fileName })
    }
    const target = await safePath(this.root, ['models', assertModelId(modelId), 'previews', assertRevisionId(revisionId), fileName])
    const bytes = await readFile(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CadError('not_found', `no cached preview for revision ${revisionId}`, { modelId, revisionId })
      }
      throw error
    })
    return { bytes, contentType: 'image/svg+xml', sha256: sha256Hex(bytes) }
  }

  /**
   * Ensure a directory inside the store exists, with symlink-escape protection.
   * @param segments - validated segments under the store root.
   * @returns the absolute directory path.
   */
  async ensureStoreDirectory(segments: string[]): Promise<string> {
    await this.ready()
    return safePath(this.root, segments, { createParent: true, kind: 'dir' })
  }

  /** Read a file inside the store, mapping ENOENT to `not_found`. */
  async readStoreFile(segments: string[]): Promise<Buffer> {
    const target = await safePath(this.root, segments)
    return readFile(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CadError('not_found', 'file does not exist in the CAD store', { segments })
      }
      throw error
    })
  }

  /**
   * Update the mutable identity fields of a model (name/description).
   * @param modelId - model id.
   * @param identity - replacement name and description.
   * @returns the updated index.
   */
  async updateModelIdentity(modelId: string, identity: { name: string; description: string }): Promise<ModelIndex> {
    const id = assertModelId(modelId)
    return this.withLock(`model:${id}`, async () => {
      const index = await this.readModel(id)
      const next: ModelIndex = {
        ...index,
        name: identity.name,
        description: identity.description,
        updatedAt: nowIso(),
      }
      await this.writeModel(next)
      return next
    })
  }

  /** Number of models currently stored (health/diagnostics). */
  async countModels(): Promise<number> {
    await this.ready()
    const entries = await readdir(this.modelsRoot(), { withFileTypes: true }).catch(() => [])
    return entries.filter(entry => entry.isDirectory() && /^m-[0-9a-f]{10}$/u.test(entry.name)).length
  }

  /** Absolute path inside the store, for diagnostics only. */
  debugPath(...segments: string[]): string {
    const target = join(this.root, ...segments)
    return isInside(this.root, target) ? target : this.root
  }
}
