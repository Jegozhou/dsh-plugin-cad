import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CadApi } from '../../src/host/api.ts'
import { bracketDocument, makeService } from './helpers.mjs'

/** Start a real HTTP server carrying the plugin's two route prefixes. */
async function startApi(service, options = {}) {
  let admitCalls = 0
  const admitted = options.admit ?? (() => undefined)
  const api = new CadApi({
    service,
    admit: request => {
      admitCalls += 1
      return admitted(request)
    },
  })
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/dsh-plugin-cad/api')) return void api.handleApi(req, res)
    if ((req.url ?? '').startsWith('/dsh-plugin-cad/assets')) return void api.handleAsset(req, res)
    res.statusCode = 404
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  return {
    base,
    api,
    get admitCalls() {
      return admitCalls
    },
    close: () => new Promise(resolve => server.close(resolve)),
    /** Raw request that keeps the exact URL spelling (for traversal probes). */
    raw: (method, path, headers = {}) => new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers,
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }))
      })
      request.on('error', reject)
      request.end()
    }),
  }
}

/** Create a built model through the service. */
async function createBuilt(service, overrides = {}) {
  const prepared = await service.prepareCreate({
    name: overrides.name ?? 'Mounting bracket',
    document: bracketDocument(overrides.document),
    ownerSession: 'session-a',
  })
  return service.runBuild(prepared)
}

test('health is always 200 and reports runtime/store/jobs without starting the runtime', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const response = await fetch(`${api.base}/dsh-plugin-cad/api/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-plugin-cad')
    assert.equal(body.protocolVersion, '1.0')
    assert.equal(body.runtime.available, false)
    assert.equal(body.runtime.state, 'stopped')
    assert.equal(body.store.modelCount, 0)
    assert.equal(body.store.writable, true)
    assert.deepEqual(body.jobs, { active: 0 })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'no invented CORS')
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('the connection fence rejects before any route runs', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service, { admit: () => 403 })
  try {
    const response = await fetch(`${api.base}/dsh-plugin-cad/api/health`)
    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.error.code, 'unauthorized')
    const asset = await fetch(`${api.base}/dsh-plugin-cad/assets/models/m-0000000000/r-0001/model.glb`)
    assert.equal(asset.status, 403)
    assert.ok(api.admitCalls >= 2)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('GET /api/models lists every model with artifact references', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const other = await createBuilt(harness.service, { name: 'Other session model' })
    const listed = await (await fetch(`${api.base}/dsh-plugin-cad/api/models?limit=100`)).json()
    assert.equal(listed.ok, true)
    assert.equal(listed.count, 2)
    const model = listed.models.find(entry => entry.modelId === created.modelId)
    assert.equal(model.name, 'Mounting bracket')
    assert.equal(model.currentRevision, 1)
    assert.equal(model.currentRevisionId, 'r-0001')
    assert.equal(model.latestStatus, 'built')
    assert.equal(model.failing, false)
    assert.equal(model.report.volume > 0, true)
    assert.deepEqual(model.report.boundingBoxSize, [80, 60, 8])
    assert.equal(model.artifacts.length, 2)
    assert.match(model.artifacts[0].url, /^\/dsh-plugin-cad\/assets\/models\//u)
    assert.ok(listed.models.some(entry => entry.modelId === other.modelId), 'models from another session are listed')
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('model detail carries document, geometry report and revision history; include=summary omits the document', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const prepared = await harness.service.prepareModify({
      modelId: created.modelId,
      expectedRevision: 1,
      parameters: { length: 100, width: 70 },
    })
    await harness.service.runBuild(prepared)

    const detailResponse = await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}`)
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json()
    assert.equal(detail.ok, true)
    assert.equal(detail.model.modelId, created.modelId)
    assert.equal(detail.model.currentRevision, 2)
    assert.equal(detail.model.latestRevision, 2)
    assert.equal(detail.model.latestStatus, 'built')
    assert.equal(detail.document.parameters.length, 100)
    assert.equal(detail.document.featureCount, 3)
    assert.deepEqual(detail.document.parameters.width, 70)
    assert.equal(detail.revision.revisionId, 'r-0002')
    assert.equal(detail.revision.status, 'built')
    assert.equal(detail.revision.report.valid, true)
    assert.deepEqual(detail.revision.report.bbox.size, [100, 70, 8])
    assert.deepEqual(detail.revision.report.boundingBox.size, [100, 70, 8])
    assert.ok(Array.isArray(detail.revision.report.checks))
    assert.equal(detail.viewer.glbUrl, `/dsh-plugin-cad/assets/models/${created.modelId}/r-0002/model.glb`)
    assert.equal(detail.viewer.upAxis, 'z')
    assert.equal(detail.history.length, 2)
    assert.equal(detail.history[0].revisionId, 'r-0002')
    assert.equal(detail.history[0].report.checks.pass > 0, true)

    const summary = await (await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}?include=summary`)).json()
    assert.equal(summary.document, undefined)

    const byRevision = await (await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}?revision=r-0001`)).json()
    assert.equal(byRevision.revision.revisionId, 'r-0001')
    assert.deepEqual(byRevision.revision.report.bbox.size, [80, 60, 8])

    const missing = await fetch(`${api.base}/dsh-plugin-cad/api/models/m-0000000000`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'not_found')
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('revision and artifact sub-routes return the documented shapes', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const revisions = await (await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}/revisions`)).json()
    assert.equal(revisions.ok, true)
    assert.equal(revisions.currentRevision, 1)
    assert.equal(revisions.latestRevision, 1)
    assert.equal(revisions.revisions.length, 1)
    assert.equal(revisions.revisions[0].revisionId, 'r-0001')
    assert.equal(revisions.revisions[0].status, 'built')

    const single = await (await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}/revisions/r-0001`)).json()
    assert.equal(single.ok, true)
    assert.equal(single.revision.revisionId, 'r-0001')
    assert.equal(single.revision.report.valid, true)

    const artifacts = await (await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}/artifacts`)).json()
    assert.equal(artifacts.ok, true)
    assert.equal(artifacts.revisionId, 'r-0001')
    assert.equal(artifacts.artifacts.length, 2)
    assert.equal(artifacts.artifacts.find(artifact => artifact.format === 'glb').contentType, 'model/gltf-binary')
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('artifact bytes: content type, bytes, ETag, 304, HEAD and download header', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const glbUrl = `${api.base}${created.artifacts.find(artifact => artifact.format === 'glb').url}`
    const response = await fetch(glbUrl)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'model/gltf-binary')
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    const body = Buffer.from(await response.arrayBuffer())
    const onDisk = await readFile(join(harness.dataDir, 'models', created.modelId, 'revisions', 'r-0001', 'model.glb'))
    assert.deepEqual(body, onDisk)
    const etag = response.headers.get('etag')
    assert.equal(etag, `"${createHash('sha256').update(onDisk).digest('hex')}"`)
    assert.equal(response.headers.get('content-length'), String(onDisk.length))

    const notModified = await fetch(glbUrl, { headers: { 'if-none-match': etag } })
    assert.equal(notModified.status, 304)
    assert.equal((await notModified.arrayBuffer()).byteLength, 0)

    const head = await fetch(glbUrl, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(onDisk.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)

    const step = await fetch(`${api.base}${created.artifacts.find(artifact => artifact.format === 'step').url}`)
    assert.equal(step.headers.get('content-type'), 'application/step')

    const download = await fetch(`${glbUrl}?download=1`)
    assert.match(download.headers.get('content-disposition'), /attachment; filename=/u)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('asset traversal, unknown files and unknown revisions are refused', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const modelId = created.modelId
    const probes = [
      `/dsh-plugin-cad/assets/models/${modelId}/r-0001/..%2F..%2Fmodel.json`,
      `/dsh-plugin-cad/assets/models/${modelId}/r-0001/%2e%2e%2f%2e%2e%2fmodel.json`,
      `/dsh-plugin-cad/assets/models/${modelId}/%2e%2e/model.json`,
      `/dsh-plugin-cad/assets/models/${modelId}/r-0001/..%5C..%5Cmodel.json`,
      '/dsh-plugin-cad/assets/models/..%2F..%2Fetc/passwd',
    ]
    for (const probe of probes) {
      const response = await api.raw('GET', probe)
      assert.ok([400, 403, 404].includes(response.status), `${probe} returned ${response.status}`)
      assert.equal(response.body.includes('root:'), false, 'content leaked')
    }
    const unknownFile = await fetch(`${api.base}/dsh-plugin-cad/assets/models/${modelId}/r-0001/secrets.json`)
    assert.equal(unknownFile.status, 404)
    const unknownRevision = await fetch(`${api.base}/dsh-plugin-cad/assets/models/${modelId}/r-9999/model.glb`)
    assert.equal(unknownRevision.status, 404)
    const noPreview = await fetch(`${api.base}/dsh-plugin-cad/assets/models/${modelId}/previews/r-0001/preview.svg`)
    assert.equal(noPreview.status, 404)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('derived preview.svg is served under the preview cache path', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const preview = await harness.service.renderPreview({ modelId: created.modelId, view: 'front' })
    const response = await fetch(`${api.base}${preview.artifact.url}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/svg+xml')
    assert.match(await response.text(), /<svg/u)
    assert.equal(preview.artifact.url, `/dsh-plugin-cad/assets/models/${created.modelId}/previews/r-0001/preview.svg`)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('the API is read-only: POST/PUT/DELETE get 405 with Allow, unknown routes 404, bad JSON never crashes', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${api.base}/dsh-plugin-cad/api/models`, { method })
      assert.equal(response.status, 405, `${method} must be refused`)
      assert.match(response.headers.get('allow'), /GET/u)
      const body = await response.json()
      assert.equal(body.error.code, 'invalid_argument')
    }
    const unknown = await fetch(`${api.base}/dsh-plugin-cad/api/../../etc/passwd`)
    assert.equal(unknown.status, 404)
    const unknownApi = await fetch(`${api.base}/dsh-plugin-cad/api/nope`)
    assert.equal(unknownApi.status, 404)
    const assetPost = await fetch(`${api.base}/dsh-plugin-cad/assets/models/m-0000000000/r-0001/model.glb`, { method: 'POST' })
    assert.equal(assetPost.status, 405)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('a failed latest revision is still a 200 detail with the last good viewer URL', async () => {
  const harness = await makeService()
  const api = await startApi(harness.service)
  try {
    const created = await createBuilt(harness.service)
    const prepared = await harness.service.prepareModify({
      modelId: created.modelId,
      expectedRevision: 1,
      parameters: { length: 120 },
    })
    // Force a geometry failure by pointing the service's runtime at a failing
    // document is not possible here; instead persist the failure directly the
    // way runBuild would on a runtime geometry verdict.
    await harness.store.completeBuild({
      modelId: created.modelId,
      revisionId: prepared.revisionId,
      number: prepared.number,
      buildKind: 'modify',
      buildRequestId: null,
      documentSha256: prepared.documentSha256,
      formats: ['step', 'glb'],
      ownerSession: 'session-a',
      completion: {
        status: 'failed',
        report: null,
        artifacts: [],
        error: { code: 'invalid_geometry', message: 'B-rep invalid', details: { checks: [] } },
        warnings: [],
        durationMs: 3,
        buildId: null,
      },
    })
    harness.store.releasePending(prepared.modelId, prepared.number)
    const response = await fetch(`${api.base}/dsh-plugin-cad/api/models/${created.modelId}`)
    assert.equal(response.status, 200)
    const detail = await response.json()
    assert.equal(detail.model.failing, true)
    assert.equal(detail.model.currentRevision, 1)
    assert.equal(detail.model.latestStatus, 'failed')
    assert.equal(detail.revision.status, 'built', 'the default revision is the last GOOD one')
    assert.equal(detail.viewer.glbUrl, `/dsh-plugin-cad/assets/models/${created.modelId}/r-0001/model.glb`)
    assert.equal(detail.history[0].status, 'failed')
    assert.equal(detail.history[0].errorCode, 'invalid_geometry')
  } finally {
    await api.close()
    await harness.dispose()
  }
})
