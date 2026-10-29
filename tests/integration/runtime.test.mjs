/**
 * Host ↔ REAL Python runtime integration test (acceptance path).
 *
 * Skipped with a clear message when the package venv / runtime entry is absent,
 * so a checkout without `python/setup-runtime.mjs` still has a green suite.
 *
 * Coverage:
 *   - the P0 acceptance bracket builds a real B-rep and exports STEP + GLB;
 *   - the artifacts exist on disk, are served with the right content type and
 *     support ETag/304 through the viewer API;
 *   - a parameter edit creates immutable revision 2 with the new dimensions;
 *   - cancelling an in-flight build settles as `cancelled`, persists no
 *     artifacts, and does not corrupt the next build.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { CadApi } from '../../src/host/api.ts'
import { CadRuntime } from '../../src/host/runtime.ts'
import { CadService } from '../../src/host/service.ts'
import { CadStore } from '../../src/host/store.ts'
import { PLUGIN_ROOT, bracketDocument, removeDir, tempDir, testConfig } from '../unit/helpers.mjs'

/** Absolute interpreter path of the package venv. */
const VENV_PYTHON = join(PLUGIN_ROOT, 'python', '.venv', 'bin', 'python3')

/** Runtime entry module. */
const RUNTIME_ENTRY = join(PLUGIN_ROOT, 'python', 'cad_runtime', '__main__.py')

/** Why the integration test cannot run, or null when it can. */
async function skipReason() {
  try {
    await access(VENV_PYTHON, constants.X_OK)
  } catch {
    return `real Python runtime skipped: ${VENV_PYTHON} does not exist (run "node python/setup-runtime.mjs")`
  }
  try {
    await access(RUNTIME_ENTRY, constants.R_OK)
  } catch {
    return `real Python runtime skipped: ${RUNTIME_ENTRY} does not exist yet`
  }
  return null
}

const SKIP = await skipReason()

/** Avoid `skip: null`: node:test treats the presence of the option as a skip. */
const TEST_OPTIONS = SKIP === null ? { timeout: 300_000 } : TEST_OPTIONS

/** Start the plugin's HTTP API on an ephemeral port. */
async function startApi(service) {
  const api = new CadApi({ service, admit: () => undefined })
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/dsh-plugin-cad/assets')) return void api.handleAsset(req, res)
    if ((req.url ?? '').startsWith('/dsh-plugin-cad/api')) return void api.handleApi(req, res)
    res.statusCode = 404
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Build a service bound to the real runtime and a temp store. */
async function makeRealHarness() {
  const dataDir = await tempDir('cad-integration-')
  const config = testConfig({
    dataDir,
    overrides: { pythonExecutable: VENV_PYTHON },
  })
  const store = new CadStore({ root: dataDir, limits: config.limits })
  await store.ready()
  const runtime = new CadRuntime({ config, pluginRoot: PLUGIN_ROOT })
  const service = new CadService({ config, store, runtime })
  return {
    dataDir,
    config,
    store,
    runtime,
    service,
    async dispose() {
      await runtime.dispose()
      await removeDir(dataDir)
    },
  }
}

test('acceptance bracket builds a real B-rep with STEP + GLB and serves the bytes', TEST_OPTIONS, async () => {
  const harness = await makeRealHarness()
  const api = await startApi(harness.service)
  try {
    const prepared = await harness.service.prepareCreate({
      name: 'Mounting bracket',
      description: '80x60x8 bracket, Ø20 centre hole, 4xØ6 corner holes inset 12',
      document: bracketDocument(),
      ownerSession: 'integration',
    })
    const payload = await harness.service.runBuild(prepared)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'built', JSON.stringify(payload.error ?? {}))
    assert.equal(payload.revision, 1)
    assert.equal(payload.currentRevision, 1)
    const formats = payload.artifacts.map(artifact => artifact.format).sort()
    assert.deepEqual(formats, ['glb', 'step'])
    const glb = payload.artifacts.find(artifact => artifact.format === 'glb')
    const step = payload.artifacts.find(artifact => artifact.format === 'step')
    assert.equal(glb.contentType, 'model/gltf-binary')
    assert.equal(step.contentType, 'application/step')
    assert.ok(glb.bytes > 1000, `GLB looks empty (${glb.bytes} bytes)`)
    assert.ok(step.bytes > 1000, `STEP looks empty (${step.bytes} bytes)`)

    // Report: real geometry, bbox within tolerance of 80x60x8.
    assert.equal(payload.report.valid, true)
    assert.ok(payload.report.volume > 30_000 && payload.report.volume < 40_000, `volume ${payload.report.volume}`)
    const size = payload.report.boundingBox.size
    assert.ok(Math.abs(size[0] - 80) < 0.01, `bbox x ${size[0]}`)
    assert.ok(Math.abs(size[1] - 60) < 0.01, `bbox y ${size[1]}`)
    assert.ok(Math.abs(size[2] - 8) < 0.01, `bbox z ${size[2]}`)
    assert.equal(payload.report.topology.solids, 1)
    assert.ok(Array.isArray(payload.report.checks) && payload.report.checks.length >= 6)
    assert.ok(payload.report.checks.every(check => ['pass', 'warn'].includes(check.status)), JSON.stringify(payload.report.checks.filter(check => check.status === 'fail')))

    // Files on disk are the bytes the store verified.
    const revisionDir = join(harness.dataDir, 'models', payload.modelId, 'revisions', 'r-0001')
    const glbBytes = await readFile(join(revisionDir, 'model.glb'))
    const stepBytes = await readFile(join(revisionDir, 'model.step'))
    assert.equal(glbBytes.length, glb.bytes)
    assert.equal(createHash('sha256').update(glbBytes).digest('hex'), glb.sha256)
    assert.equal(createHash('sha256').update(stepBytes).digest('hex'), step.sha256)
    assert.match(stepBytes.subarray(0, 12).toString('ascii'), /^ISO-10303-21/u)
    assert.match(glbBytes.subarray(0, 4).toString('ascii'), /^glTF$/u)
    const reportOnDisk = JSON.parse(await readFile(join(revisionDir, 'report.json'), 'utf8'))
    assert.equal(reportOnDisk.valid, true)
    assert.equal(reportOnDisk.bbox.size.length, 3)

    // Served through the same read-only API the viewer uses.
    const glbResponse = await fetch(`${api.base}${glb.url}`)
    assert.equal(glbResponse.status, 200)
    assert.equal(glbResponse.headers.get('content-type'), 'model/gltf-binary')
    const served = Buffer.from(await glbResponse.arrayBuffer())
    assert.deepEqual(served, glbBytes)
    const etag = glbResponse.headers.get('etag')
    const cached = await fetch(`${api.base}${glb.url}`, { headers: { 'if-none-match': etag } })
    assert.equal(cached.status, 304)

    const stepResponse = await fetch(`${api.base}${step.url}`)
    assert.equal(stepResponse.status, 200)
    assert.equal(stepResponse.headers.get('content-type'), 'application/step')

    // The health route reports a live runtime.
    const health = await (await fetch(`${api.base}/dsh-plugin-cad/api/health`)).json()
    assert.equal(health.runtime.available, true)
    assert.equal(health.runtime.state, 'ready')
    assert.equal(health.protocolVersion, '1.0')
    assert.equal(health.store.modelCount, 1)
  } finally {
    await api.close()
    await harness.dispose()
  }
})

test('a parameter edit produces immutable revision 2 with the new dimensions', TEST_OPTIONS, async () => {
  const harness = await makeRealHarness()
  try {
    const first = await harness.service.runBuild(await harness.service.prepareCreate({
      name: 'Bracket',
      document: bracketDocument(),
      ownerSession: 'integration',
    }))
    const rev1Document = await readFile(join(harness.dataDir, 'models', first.modelId, 'revisions', 'r-0001', 'document.json'))
    const second = await harness.service.runBuild(await harness.service.prepareModify({
      modelId: first.modelId,
      expectedRevision: 1,
      parameters: { length: 100, width: 70 },
      ownerSession: 'integration',
    }))
    assert.equal(second.revision, 2)
    assert.equal(second.currentRevision, 2)
    assert.equal(second.status, 'built', JSON.stringify(second.error ?? {}))
    const size = second.report.boundingBox.size
    assert.ok(Math.abs(size[0] - 100) < 0.01, `bbox x ${size[0]}`)
    assert.ok(Math.abs(size[1] - 70) < 0.01, `bbox y ${size[1]}`)
    assert.ok(second.report.volume > first.report.volume, 'a larger bracket must have more volume')

    // Revision 1 is byte-identical (immutability) and still served.
    assert.deepEqual(await readFile(join(harness.dataDir, 'models', first.modelId, 'revisions', 'r-0001', 'document.json')), rev1Document)
    const revisions = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(revisions.revisions.length, 2)
    assert.equal(revisions.currentRevision, 2)

    const detail = await harness.service.modelDetail({ modelId: first.modelId })
    assert.equal(detail.viewer.glbUrl.endsWith('/r-0002/model.glb'), true)
  } finally {
    await harness.dispose()
  }
})

test('renders a real SVG preview into the derived cache', TEST_OPTIONS, async () => {
  const harness = await makeRealHarness()
  try {
    const first = await harness.service.runBuild(await harness.service.prepareCreate({
      name: 'Preview bracket',
      document: bracketDocument(),
      ownerSession: 'integration',
    }))
    const preview = await harness.service.renderPreview({ modelId: first.modelId, view: 'iso', width: 800, height: 600 })
    assert.equal(preview.format, 'svg')
    const svgPath = join(harness.dataDir, 'models', first.modelId, 'previews', 'r-0001', 'preview.svg')
    const svg = await readFile(svgPath, 'utf8')
    assert.match(svg, /<svg/u)
    assert.ok((await stat(svgPath)).size > 100)
    const revisions = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(revisions.revisions.length, 1, 'a preview must never create a revision')
  } finally {
    await harness.dispose()
  }
})

test('cancelling an in-flight real build settles cancelled, leaves no artifacts, and the next build works', TEST_OPTIONS, async () => {
  const harness = await makeRealHarness()
  try {
    // Warm the runtime first so the cancellation hits the build, not the import.
    const warm = await harness.service.runBuild(await harness.service.prepareCreate({
      name: 'Warmup',
      document: bracketDocument(),
      ownerSession: 'integration',
    }))
    assert.equal(warm.status, 'built')
    const pidBefore = harness.runtime.pid

    const prepared = await harness.service.prepareCreate({
      name: 'Cancelled bracket',
      document: bracketDocument({ parameters: { length: 120 } }),
      ownerSession: 'integration',
    })
    const controller = new AbortController()
    const pending = harness.service.runBuild(prepared, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('integration cancellation')), 5)
    let thrown = null
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    // The abort may win before or after the runtime call; both are correct as
    // long as the call settles cancelled and nothing half-written remains.
    assert.ok(thrown !== null, 'the cancelled build must reject')
    assert.equal(thrown.code, 'cancelled', `unexpected code ${thrown.code}: ${thrown.message}`)

    const detail = await harness.service.modelDetail({ modelId: prepared.modelId })
    assert.equal(detail.revision.status, 'failed')
    assert.equal(detail.revision.error.code, 'cancelled')
    assert.equal(detail.revision.artifacts.length, 0)
    assert.equal(detail.model.currentRevision, 0)

    // The runtime is either still warm (cooperative) or respawned; either way a
    // fresh build must succeed and be uncorrupted.
    await mkdir(join(harness.dataDir, 'unused'), { recursive: true }).catch(() => undefined)
    const after = await harness.service.runBuild(await harness.service.prepareRebuild({
      modelId: prepared.modelId,
      expectedRevision: 0,
      ownerSession: 'integration',
    }))
    assert.equal(after.status, 'built', JSON.stringify(after.error ?? {}))
    assert.ok(harness.runtime.pid > 0)
    assert.ok(pidBefore > 0)
    const files = await readFile(join(harness.dataDir, 'models', prepared.modelId, 'revisions', 'r-0002', 'model.glb'))
    assert.ok(files.length > 1000)
  } finally {
    await harness.dispose()
  }
})
