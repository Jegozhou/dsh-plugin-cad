/**
 * Host-internal types shared by the store, service, tools and HTTP API.
 *
 * Nothing here is imported by the client half; the client's contract is the
 * JSON shapes documented at the top of `api.ts`.
 * @module host/types
 */

/** Scalar surface of the declarative CAD document (SPEC_P0 §3). */
export type ParameterValue = number

/** A numeric field is a literal or a `"$name"` parameter reference. */
export type NumericField = number | string

/** One ordered modelling feature of the P0 catalogue. */
export interface CadFeature {
  id: string
  op: string
  [field: string]: unknown
}

/** A declarative CAD document (`dsh.cad/document@1`). */
export interface CadDocument {
  schema?: string
  name?: string
  description?: string
  units?: string
  parameters?: Record<string, ParameterValue>
  features: CadFeature[]
  [field: string]: unknown
}

/** `pass` / `fail` / `warn` verdict of one validation check. */
export type CheckStatus = 'pass' | 'fail' | 'warn'

/** One named validation check. */
export interface ReportCheck {
  id: string
  status: CheckStatus
  message: string
}

/** Per-feature outcome reported by the runtime. */
export interface FeatureReport {
  id: string
  op: string
  status: CheckStatus
  detail: string
}

/** Bounding box in millimetres. */
export interface BoundingBox {
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
}

/** Geometry report of one build (persisted in `report.json`). */
export interface GeometryReport {
  /** True only when every non-warning check passed. */
  valid: boolean
  volume: number | null
  surfaceArea: number | null
  /** Canonical spelling; `bbox` is the alias the E2E verifier reads. */
  boundingBox: BoundingBox | null
  bbox: BoundingBox | null
  centroid: [number, number, number] | null
  topology: {
    faces: number
    edges: number
    vertices: number
    solids: number
  } | null
  checks: ReportCheck[]
  featureReports: FeatureReport[]
  warnings: string[]
  timings: Record<string, number>
}

/** One artifact file recorded for a revision. */
export interface ArtifactMeta {
  format: string
  fileName: string
  bytes: number
  sha256: string
  contentType: string
}

/** Artifact metadata plus the stable reference exposed to clients. */
export interface ArtifactRef extends ArtifactMeta {
  artifactId: string
  url: string
}

/** Build status of one revision. */
export type RevisionStatus = 'built' | 'failed' | 'unbuilt'

/** Structured failure recorded with a failed revision. */
export interface RevisionError {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Lightweight projection of a revision stored inside `model.json`. */
export interface RevisionSummary {
  number: number
  revisionId: string
  status: RevisionStatus
  createdAt: string
  builtAt: string | null
  documentSha256: string
  artifacts: ArtifactMeta[]
  errorCode: string | null
  reportSummary: {
    volume: number | null
    boundingBoxSize: [number, number, number] | null
    checks: { pass: number; fail: number; warn: number }
    totalMs: number | null
  } | null
}

/** Persisted per-revision metadata (`revision.json`). */
export interface RevisionMeta {
  schema: string
  modelId: string
  revisionId: string
  number: number
  status: RevisionStatus
  createdAt: string
  builtAt: string | null
  buildRequestId: string | null
  buildKind: BuildKind
  documentSha256: string
  formats: string[]
  durationMs: number | null
  report: GeometryReport | null
  error: RevisionError | null
  warnings: string[]
  artifacts: ArtifactMeta[]
  /** Session that requested the build, for audit only. */
  ownerSession: string | null
  /** Runtime build id, when the runtime reported one. */
  buildId: string | null
}

/** Why a revision was produced. */
export type BuildKind = 'create' | 'modify' | 'rebuild' | 'preview'

/** Idempotency record for one mutating request. */
export interface RequestRecord {
  number: number
  kind: string
  at: string
}

/** Persisted model index (`model.json`). */
export interface ModelIndex {
  schema: string
  id: string
  /** Alias of `id`, for on-disk consumers that read `modelId`. */
  modelId: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  currentRevision: number
  latestRevision: number
  nextRevision: number
  revisions: RevisionSummary[]
  requests: Record<string, RequestRecord>
  metadata: Record<string, unknown>
  /** Session that created the model, for audit only (reads are never fenced). */
  ownerSession: string | null
  /** Audit block (`sessionId` is null for a non-agent caller). */
  owner: { sessionId: string | null }
}

/** A model index plus its decoded document (returned by store reads). */
export interface LoadedModel {
  index: ModelIndex
  document: CadDocument | null
}

/** Runtime artifact declaration (before host verification). */
export interface RuntimeArtifact {
  format: string
  fileName: string
  bytes: number
  sha256: string
  contentType: string
}

/** Result of one runtime `model.build` call. */
export interface RuntimeBuildResult {
  ok: boolean
  buildId: string | null
  status: 'built' | 'failed'
  report: GeometryReport | null
  artifacts: RuntimeArtifact[]
  error: RevisionError | null
}

/** Result of one runtime `model.validate` call. */
export interface RuntimeValidateResult {
  ok: boolean
  valid: boolean
  checks: ReportCheck[]
  report: GeometryReport | null
}

/** A patch produced by `cad_modify_model` before it is persisted. */
export interface DocumentEdit {
  parameters?: Record<string, ParameterValue>
  addFeatures?: CadFeature[]
  removeFeatures?: string[]
  name?: string
  description?: string
}

/** Health/status projection of the supervised Python runtime. */
export interface RuntimeStatus {
  available: boolean
  state: 'stopped' | 'starting' | 'ready' | 'crashed' | 'disabled'
  pid: number | null
  executable: string | null
  executableSource: string | null
  protocolVersion: string | null
  runtime: Record<string, unknown> | null
  restarts: number
  lastError: string | null
  lastStartedAt: string | null
  uptimeMs: number
  stderrTail: string[]
}

/** Progressive output sink used by builds (job readOutput, progress events). */
export type ProgressSink = (line: string) => void

/** One background build request accepted by the jobs bridge. */
export interface BackgroundJobSpec {
  label: string
  owner?: unknown
  run: (signal: AbortSignal, progress: ProgressSink) => Promise<unknown>
}
