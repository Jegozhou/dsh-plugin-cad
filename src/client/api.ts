/**
 * Browser-side API client for the dsh-plugin-cad Host half.
 *
 * Every call goes to the plugin's own same-origin route with the page cookie.
 * The Host admits each request through the Harness connection service, so this
 * module never invents a second authentication scheme and never talks to any
 * other origin.
 *
 * The response shapes are the Host *viewer API contract v1*
 * (`src/host/api.ts`, mirrored in `docs/research/STATUS_host.md`):
 * `GET /api/health`, `GET /api/models`, `GET /api/models/:id`,
 * `GET /api/models/:id/revisions`, plus the documented mutating routes the
 * browser E2E uses (`POST /api/models`, `POST /api/models/:id/rebuild`).
 *
 * Defensive reading: a field that the Host omits renders as "not available" in
 * the page; a malformed JSON body or a non-JSON response becomes a typed
 * `ApiError` and never throws into the Harness shell.
 *
 * @module client/api
 */

/** JSON API prefix; must match the Host's `API_PREFIX`. */
export const API_BASE = '/dsh-plugin-cad/api'

/** Artifact asset prefix; must match the Host's asset route. */
export const ASSET_BASE = '/dsh-plugin-cad/assets'

/** One point/vector triple in millimetres (glTF axes after the Host's Z-up→Y-up conversion). */
export type Vec3 = [number, number, number]

/** Axis-aligned bounding box in millimetres. */
export interface BoundingBox {
  min: Vec3
  max: Vec3
  size: Vec3
}

/** Status vocabulary for validation checks. */
export type CheckStatus = 'pass' | 'fail' | 'warn'

/** One validation check (`document_schema`, `brep_valid`, …). */
export interface CheckEntry {
  id: string
  status: CheckStatus | string
  message?: string | null
}

/** Per-feature build report. */
export interface FeatureReport {
  id: string
  op: string
  status: CheckStatus | string
  detail?: string | null
}

/** Topology counts of the B-rep. */
export interface Topology {
  faces?: number | null
  edges?: number | null
  vertices?: number | null
  solids?: number | null
}

/** Condensed report projection the Host uses in listings/history rows. */
export interface ReportSummary {
  volume?: number | null
  boundingBoxSize?: Vec3 | null
  checks?: { pass?: number | null; fail?: number | null; warn?: number | null } | null
  totalMs?: number | null
}

/** Full geometry report carried by one revision. */
export interface GeometryReport {
  volume?: number | null
  surfaceArea?: number | null
  bbox?: BoundingBox | null
  centroid?: Vec3 | null
  topology?: Topology | null
  checks?: CheckEntry[] | null
  warnings?: string[] | null
  featureReports?: FeatureReport[] | null
  timings?: { totalMs?: number | null } | null
}

/** One exportable artifact reference (bytes live behind `url`, never inline). */
export interface ArtifactRef {
  artifactId?: string
  format: string
  bytes?: number | null
  sha256?: string | null
  url: string
  contentType?: string | null
  fileName?: string | null
}

/** Summary row of the model listing. */
export interface ModelSummary {
  /** Normalized model id (the wire field is `modelId`). */
  id: string
  name: string
  description?: string | null
  units?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  /** Last revision that successfully BUILT; `null` when the model never built. */
  currentRevision?: number | null
  currentRevisionId?: string | null
  /** Highest revision created, which may have failed. */
  latestRevision?: number | null
  latestRevisionId?: string | null
  latestStatus?: 'built' | 'failed' | 'unbuilt' | 'empty' | string
  revisionCount?: number | null
  /** True when `latestRevision` failed to build. */
  failing?: boolean
  parameters?: Record<string, number> | null
  featureCount?: number | null
  report?: ReportSummary | null
  artifacts?: ArtifactRef[] | null
}

/** Structured build error attached to a failed revision. */
export interface RevisionError {
  code: string
  message: string
  details?: unknown
}

/** One immutable revision. */
export interface Revision {
  revisionId: string
  number: number
  status: 'built' | 'failed' | 'unbuilt' | string
  createdAt?: string | null
  builtAt?: string | null
  documentSha256?: string | null
  buildRequestId?: string | null
  report?: GeometryReport | null
  artifacts?: ArtifactRef[] | null
  warnings?: string[] | null
  error?: RevisionError | null
}

/** Condensed revision row used by the history list. */
export interface RevisionSummary {
  revisionId: string
  number: number
  status: 'built' | 'failed' | 'unbuilt' | string
  createdAt?: string | null
  artifacts?: ArtifactRef[] | null
  errorCode?: string | null
  reportSummary?: ReportSummary | null
}

/** Artifact URLs the viewer needs for one revision. */
export interface ViewerRefs {
  glbUrl?: string | null
  stepUrl?: string | null
  svgUrl?: string | null
  defaultView?: string | null
  units?: string | null
  upAxis?: string | null
}

/** Model header inside the detail payload. */
export interface ModelHeader {
  id: string
  name: string
  description?: string | null
  schema?: string | null
  units?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  currentRevision?: number | null
  currentRevisionId?: string | null
  latestRevision?: number | null
  latestRevisionId?: string | null
  latestStatus?: 'built' | 'failed' | 'unbuilt' | 'empty' | string | null
  failing?: boolean
  revisionCount?: number | null
  metadata?: Record<string, unknown> | null
  parameters?: Record<string, number> | null
  features?: unknown[] | null
}

/** Document projection of the detail payload (only sent with `include=document`). */
export interface DocumentSummary {
  schema?: string | null
  units?: string | null
  parameters: Record<string, number>
  features: unknown[] | null
  featureCount?: number | null
  parameterNames?: string[] | null
}

/** Full detail payload of one model + one selected revision. */
export interface ModelDetail {
  model: ModelHeader
  revision: Revision
  viewer: ViewerRefs
  history: RevisionSummary[]
  /** Present only when the Host was asked for `include=document/full`. */
  document?: DocumentSummary | null
}

/** Runtime state reported by the Host. */
export interface RuntimeInfo {
  available: boolean
  state: 'stopped' | 'starting' | 'ready' | 'crashed' | 'disabled' | string
  pid?: number | null
  executable?: string | null
  protocolVersion?: string | null
  restarts?: number | null
  lastError?: string | null
  lastStartedAt?: string | null
  uptimeMs?: number | null
}

/** Health payload; always 200, even while the Python runtime is down. */
export interface HealthInfo {
  ok: boolean
  plugin: string
  version: string
  protocolVersion?: string | null
  runtime: RuntimeInfo
  store?: { dataDir?: string | null; modelCount?: number | null } | null
  jobs?: { active?: number | null } | null
  time?: string | null
}

/** Options for reading a model detail. */
export interface ReadDetailOptions {
  /** Revision number or `r-0002` id; defaults to the Host's current revision. */
  revision?: number | string
  /** How many history rows the Host should include (default 10). */
  historyLimit?: number
  /** Ask for the document projection when the Host route forwards `include`. */
  include?: 'summary' | 'document' | 'full'
  signal?: AbortSignal
}

/** One failed request carrying the Host's stable error code. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Whether a value is a non-null object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite number, tolerating numeric strings; otherwise `null`. */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Read a string, tolerating numbers; otherwise `null`. */
function readString(value: unknown, max = 400): string | null {
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Read a triple of finite numbers. */
export function readVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const [x, y, z] = [finiteNumber(value[0]), finiteNumber(value[1]), finiteNumber(value[2])]
  if (x === null || y === null || z === null) return null
  return [x, y, z]
}

/** Read a bounding box object. */
function readBoundingBox(value: unknown): BoundingBox | null {
  if (!isObject(value)) return null
  const min = readVec3(value.min)
  const max = readVec3(value.max)
  const size = readVec3(value.size) ?? (min !== null && max !== null
    ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    : null)
  if (min === null || max === null || size === null) return null
  return { min, max, size }
}

/** Read the validation checks array, skipping entries without an id. */
function readChecks(value: unknown): CheckEntry[] {
  if (!Array.isArray(value)) return []
  const checks: CheckEntry[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const id = readString(entry.id, 120)
    if (id === null) continue
    checks.push({
      id,
      status: (readString(entry.status, 24) ?? 'warn') as CheckEntry['status'],
      message: readString(entry.message, 400),
    })
  }
  return checks
}

/** Read feature build reports. */
function readFeatureReports(value: unknown): FeatureReport[] {
  if (!Array.isArray(value)) return []
  const reports: FeatureReport[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const id = readString(entry.id, 120)
    if (id === null) continue
    reports.push({
      id,
      op: readString(entry.op, 40) ?? 'unknown',
      status: (readString(entry.status, 24) ?? 'warn') as FeatureReport['status'],
      detail: readString(entry.detail, 400),
    })
  }
  return reports
}

/** Read the geometry report. */
export function readReport(value: unknown): GeometryReport | null {
  if (!isObject(value)) return null
  const topology = isObject(value.topology)
    ? {
      faces: finiteNumber(value.topology.faces),
      edges: finiteNumber(value.topology.edges),
      vertices: finiteNumber(value.topology.vertices),
      solids: finiteNumber(value.topology.solids),
    }
    : null
  return {
    volume: finiteNumber(value.volume),
    surfaceArea: finiteNumber(value.surfaceArea),
    bbox: readBoundingBox(value.bbox) ?? readBoundingBox(value.boundingBox),
    centroid: readVec3(value.centroid),
    topology,
    checks: readChecks(value.checks),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map(entry => readString(entry, 400)).filter((entry): entry is string => entry !== null)
      : [],
    featureReports: readFeatureReports(value.featureReports),
    timings: isObject(value.timings)
      ? { totalMs: finiteNumber(value.timings.totalMs) ?? finiteNumber(value.timings.total) }
      : null,
  }
}

/** Read the condensed report projection used by listings and history rows. */
function readReportSummary(value: unknown): ReportSummary | null {
  if (!isObject(value)) return null
  const checks = isObject(value.checks) ? value.checks : null
  // A full report may also arrive here (older Host revisions): degrade to the
  // same condensed shape instead of throwing the whole row away.
  const pass = checks !== null ? finiteNumber(checks.pass) : Array.isArray(value.checks) ? null : null
  return {
    volume: finiteNumber(value.volume),
    boundingBoxSize: readVec3(value.boundingBoxSize) ?? readBoundingBox(value.bbox)?.size ?? null,
    checks: checks === null
      ? null
      : { pass: finiteNumber(checks.pass), fail: finiteNumber(checks.fail), warn: finiteNumber(checks.warn) },
    totalMs: finiteNumber(value.totalMs) ?? (isObject(value.timings) ? finiteNumber(value.timings.totalMs) : null),
  }
  void pass
}

/** Read one artifact reference; entries without a URL are dropped. */
function readArtifacts(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return []
  const artifacts: ArtifactRef[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const format = readString(entry.format, 16)
    const url = readString(entry.url, 2048)
    if (format === null || url === null) continue
    artifacts.push({
      artifactId: readString(entry.artifactId, 200) ?? undefined,
      format,
      bytes: finiteNumber(entry.bytes),
      sha256: readString(entry.sha256, 128),
      url,
      contentType: readString(entry.contentType, 120),
      fileName: readString(entry.fileName, 120),
    })
  }
  return artifacts
}

/** Read a revision error object. */
function readRevisionError(value: unknown): RevisionError | null {
  if (!isObject(value)) return null
  const code = readString(value.code, 80)
  if (code === null) return null
  return {
    code,
    message: readString(value.message, 800) ?? code,
    details: value.details,
  }
}

/** Read a full revision object. */
function readRevision(value: unknown): Revision | null {
  if (!isObject(value)) return null
  const revisionId = readString(value.revisionId, 80) ?? readString(value.id, 80)
  if (revisionId === null) return null
  const number = finiteNumber(value.number) ?? parseRevisionNumber(revisionId)
  if (number === null) return null
  return {
    revisionId,
    number,
    status: (readString(value.status, 24) ?? 'unbuilt') as Revision['status'],
    createdAt: readString(value.createdAt, 64),
    builtAt: readString(value.builtAt, 64),
    documentSha256: readString(value.documentSha256, 128),
    buildRequestId: readString(value.buildRequestId, 200),
    report: readReport(value.report),
    artifacts: readArtifacts(value.artifacts),
    warnings: Array.isArray(value.warnings)
      ? value.warnings.map(entry => readString(entry, 400)).filter((entry): entry is string => entry !== null)
      : [],
    error: readRevisionError(value.error),
  }
}

/** Read a condensed revision row. */
function readRevisionSummary(value: unknown): RevisionSummary | null {
  if (!isObject(value)) return null
  const revisionId = readString(value.revisionId, 80) ?? readString(value.id, 80)
  if (revisionId === null) return null
  const number = finiteNumber(value.number) ?? parseRevisionNumber(revisionId)
  if (number === null) return null
  const summary = value.report ?? value.reportSummary
  return {
    revisionId,
    number,
    status: (readString(value.status, 24) ?? 'unbuilt') as RevisionSummary['status'],
    createdAt: readString(value.createdAt, 64),
    artifacts: readArtifacts(value.artifacts),
    errorCode: readString(value.errorCode, 80),
    reportSummary: readReportSummary(summary),
  }
}

/** Extract the number from `r-0002`, or `null`. */
export function parseRevisionNumber(revisionId: string): number | null {
  const match = /^r-(\d{1,9})$/u.exec(revisionId)
  return match === null ? null : Number(match[1])
}

/** Read one model summary row. */
function readModelSummary(value: unknown): ModelSummary | null {
  if (!isObject(value)) return null
  const id = readString(value.modelId, 80) ?? readString(value.id, 80)
  if (id === null) return null
  const currentRevisionId = readString(value.currentRevisionId, 80)
  return {
    id,
    name: readString(value.name, 200) ?? id,
    description: readString(value.description, 800),
    units: readString(value.units, 16),
    createdAt: readString(value.createdAt, 64),
    updatedAt: readString(value.updatedAt, 64),
    currentRevision: finiteNumber(value.currentRevision),
    currentRevisionId,
    latestRevision: finiteNumber(value.latestRevision),
    latestRevisionId: readString(value.latestRevisionId, 80),
    latestStatus: (readString(value.latestStatus, 24) ?? 'unbuilt') as ModelSummary['latestStatus'],
    revisionCount: finiteNumber(value.revisionCount),
    failing: value.failing === true,
    parameters: isObject(value.parameters)
      ? Object.fromEntries(
        Object.entries(value.parameters)
          .map(([key, entry]) => [key, finiteNumber(entry)] as const)
          .filter((entry): entry is readonly [string, number] => entry[1] !== null),
      )
      : null,
    featureCount: finiteNumber(value.featureCount),
    report: readReportSummary(value.report),
    artifacts: readArtifacts(value.artifacts),
  }
}

/** Get one artifact URL for a format from a list. */
export function artifactUrl(artifacts: readonly ArtifactRef[] | null | undefined, format: string): string | null {
  if (!artifacts) return null
  const match = artifacts.find(artifact => artifact.format.toLowerCase() === format.toLowerCase())
  return match === undefined ? null : match.url
}

/** Build the documented asset URL for a revision artifact. */
export function artifactPath(modelId: string, revisionId: string, fileName: string): string {
  return `${ASSET_BASE}/models/${encodeURIComponent(modelId)}/${encodeURIComponent(revisionId)}/${fileName}`
}

/** Low-level JSON request with the Host's stable error envelope. */
async function request<T>(path: string, options: {
  method?: string
  body?: unknown
  signal?: AbortSignal
} = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('network', error instanceof Error ? error.message : 'network request failed', 0)
  }
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObject(parsed)) payload = parsed
      else throw new Error('not an object')
    } catch {
      throw new ApiError(
        'bad-response',
        `the Host answered with non-JSON (${response.status})`,
        response.status,
      )
    }
  }
  if (!response.ok) {
    const failure = isObject(payload.error) ? payload.error : {}
    throw new ApiError(
      readString(failure.code, 80) ?? `http_${response.status}`,
      readString(failure.message, 800) ?? `request failed (${response.status})`,
      response.status,
      failure.details,
    )
  }
  return payload as T
}

/** Read plugin + runtime health. */
export async function health(signal?: AbortSignal): Promise<HealthInfo> {
  const payload = await request<Record<string, unknown>>('/health', { signal })
  const runtime = isObject(payload.runtime) ? payload.runtime : {}
  return {
    ok: payload.ok !== false,
    plugin: readString(payload.plugin, 80) ?? 'dsh-plugin-cad',
    version: readString(payload.version, 40) ?? '',
    protocolVersion: readString(payload.protocolVersion, 40),
    runtime: {
      available: runtime.available === true,
      state: readString(runtime.state, 24) ?? 'stopped',
      pid: finiteNumber(runtime.pid),
      executable: readString(runtime.executable, 1024),
      protocolVersion: readString(runtime.protocolVersion, 40),
      restarts: finiteNumber(runtime.restarts),
      lastError: readString(runtime.lastError, 800),
      lastStartedAt: readString(runtime.lastStartedAt, 64),
      uptimeMs: finiteNumber(runtime.uptimeMs),
    },
    store: isObject(payload.store)
      ? { dataDir: readString(payload.store.dataDir, 1024), modelCount: finiteNumber(payload.store.modelCount) }
      : null,
    jobs: isObject(payload.jobs) ? { active: finiteNumber(payload.jobs.active) } : null,
    time: readString(payload.time, 64),
  }
}

/** List models, newest first. */
export async function listModels(signal?: AbortSignal): Promise<ModelSummary[]> {
  const payload = await request<Record<string, unknown>>(
    '/models?limit=100&include_failed=true',
    { signal },
  )
  if (!Array.isArray(payload.models)) {
    throw new ApiError('bad-response', 'the model listing has no `models` array', 200)
  }
  const models: ModelSummary[] = []
  for (const entry of payload.models) {
    const summary = readModelSummary(entry)
    if (summary !== null) models.push(summary)
  }
  return models
}

/** Read one model + revision. */
export async function readModel(modelId: string, options: ReadDetailOptions = {}): Promise<ModelDetail> {
  const query = new URLSearchParams()
  if (options.revision !== undefined) query.set('revision', String(options.revision))
  if (options.historyLimit !== undefined) query.set('history_limit', String(options.historyLimit))
  if (options.include !== undefined) query.set('include', options.include)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  const payload = await request<Record<string, unknown>>(
    `/models/${encodeURIComponent(modelId)}${suffix}`,
    { signal: options.signal },
  )
  const modelNode = isObject(payload.model) ? payload.model : {}
  const revision = readRevision(payload.revision)
  if (revision === null) {
    throw new ApiError('bad-response', 'the model detail has no readable revision', 200)
  }
  const viewer = isObject(payload.viewer) ? payload.viewer : {}
  const history: RevisionSummary[] = []
  if (Array.isArray(payload.history)) {
    for (const entry of payload.history) {
      const summary = readRevisionSummary(entry)
      if (summary !== null) history.push(summary)
    }
  }
  const documentNode = isObject(payload.document) ? payload.document : null
  const documentParameters = documentNode !== null && isObject(documentNode.parameters)
    ? Object.fromEntries(
      Object.entries(documentNode.parameters)
        .map(([key, entry]) => [key, finiteNumber(entry)] as const)
        .filter((entry): entry is readonly [string, number] => entry[1] !== null),
    )
    : null
  const document: DocumentSummary | null = documentNode === null ? null : {
    schema: readString(documentNode.schema, 80),
    units: readString(documentNode.units, 16),
    parameters: documentParameters ?? {},
    features: Array.isArray(documentNode.features) ? documentNode.features : null,
    featureCount: finiteNumber(documentNode.featureCount),
    parameterNames: Array.isArray(documentNode.parameterNames)
      ? documentNode.parameterNames.filter((entry): entry is string => typeof entry === 'string')
      : null,
  }
  const id = readString(modelNode.modelId, 80) ?? readString(modelNode.id, 80) ?? modelId
  return {
    model: {
      id,
      name: readString(modelNode.name, 200) ?? id,
      description: readString(modelNode.description, 800),
      schema: readString(modelNode.schema, 80),
      units: readString(modelNode.units, 16),
      createdAt: readString(modelNode.createdAt, 64),
      updatedAt: readString(modelNode.updatedAt, 64),
      currentRevision: finiteNumber(modelNode.currentRevision),
      currentRevisionId: readString(modelNode.currentRevisionId, 80),
      latestRevision: finiteNumber(modelNode.latestRevision),
      latestRevisionId: readString(modelNode.latestRevisionId, 80),
      latestStatus: (readString(modelNode.latestStatus, 24) ?? null) as ModelHeader['latestStatus'],
      failing: modelNode.failing === true,
      revisionCount: finiteNumber(modelNode.revisionCount),
      metadata: isObject(modelNode.metadata) ? modelNode.metadata : null,
      parameters: documentParameters ?? (isObject(modelNode.parameters)
        ? Object.fromEntries(
          Object.entries(modelNode.parameters)
            .map(([key, entry]) => [key, finiteNumber(entry)] as const)
            .filter((entry): entry is readonly [string, number] => entry[1] !== null),
        )
        : null),
      features: document?.features ?? (Array.isArray(modelNode.features) ? modelNode.features : null),
    },
    revision,
    viewer: {
      glbUrl: readString(viewer.glbUrl, 2048) ?? artifactUrl(revision.artifacts, 'glb'),
      stepUrl: readString(viewer.stepUrl, 2048),
      svgUrl: readString(viewer.svgUrl, 2048),
      defaultView: readString(viewer.defaultView, 16),
      units: readString(viewer.units, 16),
      upAxis: readString(viewer.upAxis, 8),
    },
    history,
    document,
  }
}

/** Revision history of one model, newest first. */
export async function listRevisions(modelId: string, signal?: AbortSignal): Promise<RevisionSummary[]> {
  const payload = await request<Record<string, unknown>>(
    `/models/${encodeURIComponent(modelId)}/revisions`,
    { signal },
  )
  if (!Array.isArray(payload.revisions)) {
    throw new ApiError('bad-response', 'the revision listing has no `revisions` array', 200)
  }
  const revisions: RevisionSummary[] = []
  for (const entry of payload.revisions) {
    const summary = readRevisionSummary(entry)
    if (summary !== null) revisions.push(summary)
  }
  return revisions
}

/** A GLB that could not be fetched or is not a glTF-binary container. */
export class GlbError extends Error {
  readonly code: 'http' | 'not-found' | 'unavailable' | 'malformed' | 'network' | 'empty'
  readonly status: number

  constructor(code: GlbError['code'], message: string, status = 0) {
    super(message)
    this.name = 'GlbError'
    this.code = code
    this.status = status
  }
}

/** Fetch GLB bytes and verify the container magic before handing them to three. */
export async function fetchGlb(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'default', signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new GlbError('network', error instanceof Error ? error.message : 'network request failed')
  }
  if (response.status === 404) {
    throw new GlbError('not-found', 'the model artifact is missing (404)', 404)
  }
  if (response.status === 503) {
    throw new GlbError('unavailable', 'the runtime is unavailable (503)', 503)
  }
  if (!response.ok) {
    throw new GlbError('http', `the Host answered ${response.status}`, response.status)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength < 12) {
    throw new GlbError('empty', 'the artifact is empty', response.status)
  }
  const magic = new DataView(buffer).getUint32(0, true)
  // "glTF" little-endian magic, glTF 2.0 binary container.
  if (magic !== 0x46546c67) {
    throw new GlbError('malformed', 'the artifact is not a valid GLB file', response.status)
  }
  return buffer
}
