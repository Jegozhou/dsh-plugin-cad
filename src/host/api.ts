/**
 * HTTP API for the browser half, served through the Harness web carrier.
 *
 * ============================================================================
 * VIEWER API CONTRACT v1 (read-only) — this block is the client's ground truth
 * ============================================================================
 * Prefixes:  API_BASE   = `/dsh-plugin-cad/api`
 *            ASSET_BASE = `/dsh-plugin-cad/assets`
 *
 * Every request is first admitted by the Harness `connection` service
 * (`requestRejection`), so there is no second auth scheme and no CORS. All
 * responses are same-origin. JSON responses: `application/json; charset=utf-8`,
 * `cache-control: no-store`, `x-content-type-options: nosniff`. Errors (non-2xx)
 * use `{"error":{"code":"<stable code>","message":"…","details":{…}?}}` with the
 * status from `src/contracts/errors.js`.
 *
 * There are NO mutating routes: the viewer is read-only in P0. Revision
 * refresh is verified by an agent creating revision 2 in another session; the
 * open viewer panel polls the model detail endpoint and sees it.
 *
 * ARTIFACT REF (identical everywhere):
 *   {"artifactId":"m-1a2b3c4d5e:r-0002:glb","format":"glb","fileName":"model.glb",
 *    "bytes":31704,"sha256":"<64 hex>","contentType":"model/gltf-binary",
 *    "url":"/dsh-plugin-cad/assets/models/m-1a2b3c4d5e/r-0002/model.glb"}
 *   contentTypes: glb=model/gltf-binary, step=application/step, stl=model/stl,
 *                 svg=image/svg+xml
 *
 * 1) GET /api/health → 200 always (a down Python runtime is data, not an error)
 *   {"ok":true,"plugin":"dsh-plugin-cad","version":"0.1.0",
 *    "protocolVersion":"1.0",
 *    "runtime":{"available":false,"state":"stopped|starting|ready|crashed|disabled",
 *               "pid":null,"executable":"/abs/python3","executableSource":"plugin-venv",
 *               "protocolVersion":null,"runtime":null,"restarts":0,"lastError":null,
 *               "lastStartedAt":null,"uptimeMs":0,"stderrTail":[]},
 *    "store":{"dataDir":"…/.dsh/cad","modelCount":3,"writable":true,"exportAllowed":true},
 *    "jobs":{"active":0},"time":"2026-10-30T…Z"}
 *   `runtime.available` gates the viewer's "runtime offline" banner. Health never
 *   starts the runtime.
 *
 * 2) GET /api/models?limit=50&include_failed=true
 *   {"ok":true,"models":[MODEL_SUMMARY]}
 *   MODEL_SUMMARY = {"modelId","name","description","units":"mm","createdAt","updatedAt",
 *     "currentRevision":1,"currentRevisionId":"r-0001",
 *     "latestRevision":2,"latestRevisionId":"r-0002",
 *     "latestStatus":"built|failed|unbuilt|empty","revisionCount":2,"failing":false,
 *     "report":{"volume":12345.6,"boundingBoxSize":[80,60,8],
 *               "checks":{"pass":6,"fail":0,"warn":1},"totalMs":1834}|null,
 *     "artifacts":[ARTIFACT_REF…]}         // artifacts of currentRevision
 *   Every model in the store is visible regardless of the creating session
 *   (single-user desktop; ownership is audit only, not a read fence).
 *
 * 3) GET /api/models/:modelId?revision=<number|"r-0002">&history_limit=20
 *   {"ok":true,
 *    "model":{"modelId","name","description","schema":"dsh.cad/document@1","units":"mm",
 *             "createdAt","updatedAt","currentRevision","currentRevisionId",
 *             "latestRevision","latestRevisionId","latestStatus","failing",
 *             "revisionCount","owner":{"sessionId":null},"metadata":{},
 *             "schema":"dsh.cad/document@1"},
 *    "document":{"schema":"dsh.cad/document@1","units":"mm","parameters":{…},
 *                "features":[…],"featureCount":3,"parameterNames":["length",…]},
 *    "revision":REVISION,                    // selected revision (default current)
 *    "viewer":{"glbUrl":"…|null","stepUrl":null,"stlUrl":null,"svgUrl":null,
 *              "defaultView":"iso","units":"mm","upAxis":"z"},   // of current revision
 *    "history":[REVISION_SUMMARY…]}          // newest first
 *   REVISION = {"revisionId","number","status":"built|failed|unbuilt","createdAt",
 *     "builtAt":null,"documentSha256","buildKind","buildRequestId","durationMs",
 *     "formats":["step","glb"],
 *     "report":{…full geometry report: valid, volume, surfaceArea,
 *               boundingBox{min,max,size}, bbox{min,max,size}, centroid,
 *               topology{faces,edges,vertices,solids}, checks[{id,status,message}],
 *               featureReports[{id,op,status,detail}],warnings[],timings{}}|null,
 *     "artifacts":[ARTIFACT_REF…],"warnings":[],"error":null}
 *   REVISION_SUMMARY = {"revisionId","number","status","createdAt","builtAt",
 *     "documentSha256","errorCode":null|"invalid_geometry",
 *     "report":{volume,boundingBoxSize,checks{pass,fail,warn},totalMs}|null,
 *     "artifacts":[ARTIFACT_REF…]}
 *   A failed build is a 200 with revision.status="failed", revision.error set and
 *   an empty artifact list; model.currentRevision stays at the last GOOD revision
 *   and model.failing=true. runtime_unavailable/timeout/cancelled only appear as
 *   revision.error.code or a tool envelope error, never as a GET detail error.
 *
 * 4) GET /api/models/:modelId/revisions?limit=50
 *   {"ok":true,"modelId","currentRevision","latestRevision","revisions":[REVISION_SUMMARY…]}
 *   GET /api/models/:modelId/revisions/:revisionId → {"ok":true,"modelId","revision":REVISION}
 *   GET /api/models/:modelId/artifacts?revision=<…>
 *   {"ok":true,"modelId","revisionId","artifacts":[ARTIFACT_REF…]}
 *
 * 5) GET|HEAD /assets/models/<modelId>/<revisionId>/<fileName>
 *   fileName ∈ model.glb | model.step | model.stl | preview.svg
 *   ETag = `"<sha256>"`, `cache-control: public, max-age=31536000, immutable`
 *   (revisions are immutable), If-None-Match → 304, `?download=1` adds
 *   content-disposition. Traversal / symlink escape / unknown names → 403/404.
 *   GET|HEAD /assets/models/<modelId>/previews/<revisionId>/preview.svg
 *   serves the derived preview cache (regenerable; never authoritative).
 *
 * Polling: 2 s on the detail endpoint is the expected cadence; JSON is
 * no-store and small. Artifacts support 304, so the GLB is fetched once.
 * ============================================================================
 * @module host/api
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CadError, isCadError } from './contracts.ts'
import { API_PREFIX, ASSET_PREFIX } from './service.ts'
import type { CadService } from './service.ts'
import type { ArtifactRef } from './types.ts'

/** Query parameters accepted by the model detail route. */
const DETAIL_QUERY_KEYS = new Set(['revision', 'history_limit', 'include'])

/** Admission callback: the harness connection fence. */
export type AdmitRequest = (req: IncomingMessage) => number | undefined

/** API server dependencies. */
export interface CadApiOptions {
  service: CadService
  admit: AdmitRequest
  log?: (message: string, error?: unknown) => void
}

/** True for a GET/HEAD request. */
function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(payload))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

/** Send a 405 with an explicit Allow header. */
function sendMethodNotAllowed(res: ServerResponse): void {
  if (res.headersSent) return
  res.setHeader('allow', 'GET, HEAD')
  sendJson(res, 405, { error: { code: 'invalid_argument', message: 'this API is read-only (GET/HEAD only)' } })
}

/** Map any thrown error to the documented envelope and status. */
function sendError(res: ServerResponse, error: unknown): void {
  if (isCadError(error)) {
    sendJson(res, error.status ?? 500, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    })
    return
  }
  sendJson(res, 500, {
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

/** Decode one path segment, rejecting malformed escapes. */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new CadError('not_found', 'malformed URL path')
  }
}

/** Normalize an ETag value for comparison. */
function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//u, '').replace(/^"|"$/gu, '')
}

/** The read-only API + artifact server. */
export class CadApi {
  private readonly service: CadService
  private readonly admit: AdmitRequest
  private readonly log: (message: string, error?: unknown) => void

  constructor(options: CadApiOptions) {
    this.service = options.service
    this.admit = options.admit
    this.log = options.log ?? (() => undefined)
  }

  /** Handle one `/api` request; owns the full response lifecycle. */
  async handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const rejection = this.admit(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: { code: 'unauthorized', message: 'this page is not authenticated for the Harness API' } })
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      if (!isReadMethod(method)) {
        sendMethodNotAllowed(res)
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh-plugin-cad.invalid')
      let path = url.pathname.slice(API_PREFIX.length)
      if (path === '') path = '/'
      const segments = path.split('/').filter(segment => segment !== '').map(decodeSegment)
      const query = Object.fromEntries(url.searchParams.entries())
      const payload = await this.routeApi(segments, query)
      sendJson(res, 200, payload)
    } catch (error) {
      if (res.statusCode >= 500) this.log(`api: ${String(req.method)} ${String(req.url)} failed`, error)
      sendError(res, error)
    }
  }

  /** Route one API path. */
  private async routeApi(segments: string[], query: Record<string, string>): Promise<Record<string, unknown>> {
    if (segments.length === 1 && segments[0] === 'health') {
      return this.service.health()
    }
    if (segments[0] !== 'models') {
      throw new CadError('not_found', `no route for /${segments.join('/')}`)
    }
    if (segments.length === 1) {
      const models = await this.service.listModels({
        limit: query.limit,
        includeFailed: query.include_failed === 'true' || query.include_failed === '1',
      })
      return { ok: true, count: models.length, models }
    }
    const modelId = segments[1] ?? ''
    if (segments.length === 2) {
      return this.service.modelDetail({
        modelId,
        revision: query.revision,
        historyLimit: query.history_limit,
        include: query.include,
      })
    }
    const resource = segments[2] ?? ''
    if (resource === 'revisions') {
      if (segments.length === 3) {
        return this.service.listRevisions({ modelId, limit: query.limit })
      }
      if (segments.length === 4) {
        const detail = await this.service.revisionDetail(modelId, segments[3])
        const revisions = await this.service.listRevisions({ modelId, limit: 100 })
        const summary = (revisions.revisions as Array<Record<string, unknown>>).find(entry => entry.revisionId === detail.summary.revisionId)
        const payload = await this.service.inspectModel({ modelId, revision: segments[3], include: 'summary' })
        return {
          ok: true,
          modelId: detail.index.id,
          revision: payload.revision,
          summary: summary ?? null,
        }
      }
      throw new CadError('not_found', 'no such revisions route')
    }
    if (resource === 'artifacts' && segments.length === 3) {
      return this.service.modelArtifacts({ modelId, revision: query.revision })
    }
    throw new CadError('not_found', `no route for /${segments.join('/')}`)
  }

  /**
   * Handle one asset request: fixed artifact names inside a revision directory,
   * or the derived preview cache. Every path segment is validated and the store
   * proves the resolved file stays inside its root (no `..`, no symlink escape).
   */
  async handleAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const rejection = this.admit(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: { code: 'unauthorized', message: 'this page is not authenticated for the Harness API' } })
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      if (!isReadMethod(method)) {
        sendMethodNotAllowed(res)
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh-plugin-cad.invalid')
      let path = url.pathname.slice(ASSET_PREFIX.length)
      if (path.startsWith('/')) path = path.slice(1)
      const rawSegments = path.split('/')
      if (rawSegments.some(segment => segment === '')) {
        throw new CadError('not_found', 'asset not found')
      }
      const segments = rawSegments.map(decodeSegment)
      if (segments[0] !== 'models' || (segments.length !== 4 && segments.length !== 5)) {
        throw new CadError('not_found', 'asset not found')
      }
      const modelId = segments[1] ?? ''
      let file: { bytes: Buffer; contentType: string; sha256: string }
      let fileName: string
      if (segments.length === 4) {
        const revisionId = segments[2] ?? ''
        fileName = segments[3] ?? ''
        file = await this.service.modelStore.readArtifact(modelId, revisionId, fileName)
      } else {
        if (segments[2] !== 'previews') throw new CadError('not_found', 'asset not found')
        const revisionId = segments[3] ?? ''
        fileName = segments[4] ?? ''
        file = await this.service.modelStore.readPreview(modelId, revisionId, fileName)
      }
      const etag = `"${file.sha256}"`
      const inm = req.headers['if-none-match']
      if (typeof inm === 'string' && inm.split(',').some(candidate => normalizeEtag(candidate) === file.sha256)) {
        res.statusCode = 304
        res.setHeader('etag', etag)
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', file.contentType)
      res.setHeader('content-length', String(file.bytes.length))
      res.setHeader('etag', etag)
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
      res.setHeader('x-content-type-options', 'nosniff')
      if (url.searchParams.get('download') === '1') {
        res.setHeader('content-disposition', `attachment; filename="${modelId}-${fileName}"`)
      }
      if (method === 'HEAD') {
        res.end()
        return
      }
      res.end(file.bytes)
    } catch (error) {
      if (isCadError(error) && error.code === 'not_found') {
        sendJson(res, 404, { error: { code: 'not_found', message: error.message } })
        return
      }
      if (isCadError(error) && error.code === 'path_escape') {
        sendJson(res, 403, { error: { code: 'path_escape', message: error.message } })
        return
      }
      this.log(`api: asset ${String(req.url)} failed`, error)
      sendError(res, error)
    }
  }
}

/** Stable artifact-ref helper re-exported for tests. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Re-export the ref type for the client contract tests. */
export type { ArtifactRef }

/** Query keys the detail route understands (kept for tests/documentation). */
export const DETAIL_QUERY = [...DETAIL_QUERY_KEYS]
