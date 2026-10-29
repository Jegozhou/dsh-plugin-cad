import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CadError } from '../../src/host/contracts.ts'
import { bracketDocument, makeService, tempDir, removeDir, testConfig, waitFor } from './helpers.mjs'

/** Create a model synchronously (build) and return the payload. */
async function createBuilt(service, overrides = {}) {
  const prepared = await service.prepareCreate({
    name: overrides.name ?? 'Mounting bracket',
    description: 'acceptance part',
    document: bracketDocument(overrides.document),
    build: overrides.build,
    requestId: overrides.requestId ?? null,
    ownerSession: overrides.ownerSession ?? 'session-a',
  })
  return service.runBuild(prepared)
}

test('create → build persists verified STEP + GLB artifacts with reference URLs', async () => {
  const harness = await makeService()
  try {
    const payload = await createBuilt(harness.service)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'built')
    assert.equal(payload.revision, 1)
    assert.equal(payload.currentRevision, 1)
    assert.equal(payload.duplicate, false)
    assert.equal(payload.artifacts.length, 2)
    const glb = payload.artifacts.find(artifact => artifact.format === 'glb')
    const step = payload.artifacts.find(artifact => artifact.format === 'step')
    assert.equal(glb.contentType, 'model/gltf-binary')
    assert.equal(glb.fileName, 'model.glb')
    assert.equal(glb.artifactId, `${payload.modelId}:r-0001:glb`)
    assert.equal(glb.url, `/dsh-plugin-cad/assets/models/${payload.modelId}/r-0001/model.glb`)
    assert.equal(step.contentType, 'application/step')
    assert.equal(payload.report.valid, true)
    assert.deepEqual(payload.report.bbox.size, [80, 60, 8])

    const bytes = await readFile(join(harness.dataDir, 'models', payload.modelId, 'revisions', 'r-0001', 'model.glb'))
    assert.equal(bytes.length, glb.bytes)
    assert.match(bytes.subarray(0, 4).toString('ascii'), /^glTF$/u)

    const detail = await harness.service.modelDetail({ modelId: payload.modelId })
    assert.equal(detail.model.currentRevision, 1)
    assert.equal(detail.viewer.glbUrl, glb.url)
    assert.equal(detail.document.parameters.length, 80)
    assert.equal(detail.revision.artifacts.length, 2)
  } finally {
    await harness.dispose()
  }
})

test('parameter edit creates immutable revision 2 and keeps revision 1 intact', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    const rev1Bytes = await readFile(join(harness.dataDir, 'models', first.modelId, 'revisions', 'r-0001', 'document.json'))
    const prepared = await harness.service.prepareModify({
      modelId: first.modelId,
      expectedRevision: 1,
      parameters: { length: 100, width: 70 },
      requestId: null,
      ownerSession: 'session-a',
    })
    const second = await harness.service.runBuild(prepared)
    assert.equal(second.revision, 2)
    assert.equal(second.currentRevision, 2)
    assert.equal(second.status, 'built')
    assert.deepEqual(second.report.bbox.size, [100, 70, 8])

    const detail = await harness.service.modelDetail({ modelId: first.modelId })
    assert.equal(detail.model.currentRevision, 2)
    assert.equal(detail.history.length, 2)
    assert.equal(detail.document.parameters.length, 100)
    assert.equal(detail.history.length, 2)
    // Revision 1's document is byte-identical after the edit (immutability).
    const rev1After = await readFile(join(harness.dataDir, 'models', first.modelId, 'revisions', 'r-0001', 'document.json'))
    assert.deepEqual(rev1After, rev1Bytes)
  } finally {
    await harness.dispose()
  }
})

test('an invalid parameter edit creates NO revision', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    const before = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(before.revisions.length, 1)
    let thrown = null
    try {
      await harness.service.prepareModify({
        modelId: first.modelId,
        expectedRevision: 1,
        parameters: { center_d: 400 },
        requestId: null,
      })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'invalid_argument')
    const after = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(after.revisions.length, 1, 'no revision may be allocated for an invalid edit')
    assert.equal(after.latestRevision, 1)
  } finally {
    await harness.dispose()
  }
})

test('a wrong expected_revision is revision_conflict with the current revision', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    let thrown = null
    try {
      await harness.service.prepareModify({ modelId: first.modelId, expectedRevision: 0, parameters: { length: 90 } })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'revision_conflict')
    assert.equal(thrown.details.currentRevision, 1)
  } finally {
    await harness.dispose()
  }
})

test('a geometry failure is persisted as a failed revision and keeps the previous current revision', async () => {
  const harness = await makeService({ runtimeMode: 'geometry-fail' })
  try {
    const prepared = await harness.service.prepareCreate({
      name: 'Doomed',
      document: bracketDocument(),
      ownerSession: 'session-a',
    })
    let thrown = null
    try {
      await harness.service.runBuild(prepared)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'invalid_geometry')
    const detail = await harness.service.modelDetail({ modelId: prepared.modelId })
    assert.equal(detail.model.currentRevision, 0)
    assert.equal(detail.model.latestStatus, 'failed')
    assert.equal(detail.model.failing, true)
    assert.equal(detail.revision.status, 'failed')
    assert.equal(detail.revision.error.code, 'invalid_geometry')
    assert.equal(detail.revision.artifacts.length, 0)
    assert.ok(detail.revision.report.checks.some(check => check.status === 'fail'))
    assert.equal(detail.viewer.glbUrl, null)
  } finally {
    await harness.dispose()
  }
})

test('build:false stores an unbuilt revision that rebuild later promotes', async () => {
  const harness = await makeService()
  try {
    const prepared = await harness.service.prepareCreate({
      name: 'Staged',
      document: bracketDocument(),
      build: false,
      ownerSession: 'session-a',
    })
    const stored = await harness.service.runBuild(prepared)
    assert.equal(stored.status, 'unbuilt')
    assert.equal(stored.currentRevision, 0)
    let detail = await harness.service.modelDetail({ modelId: prepared.modelId })
    assert.equal(detail.model.latestStatus, 'unbuilt')

    const rebuild = await harness.service.prepareRebuild({
      modelId: prepared.modelId,
      expectedRevision: 0,
      requestId: null,
      ownerSession: 'session-a',
    })
    const built = await harness.service.runBuild(rebuild)
    assert.equal(built.revision, 2)
    assert.equal(built.status, 'built')
    assert.equal(built.currentRevision, 2)
  } finally {
    await harness.dispose()
  }
})

test('request_id replay returns the same revision instead of building a second one', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service, { requestId: 'create-key-1' })
    const replayPrepared = await harness.service.prepareCreate({
      name: 'Mounting bracket',
      document: bracketDocument(),
      requestId: 'create-key-1',
      ownerSession: 'session-a',
    })
    assert.equal(replayPrepared.duplicate, true)
    const replay = await harness.service.runBuild(replayPrepared)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.revisionId, first.revisionId)
    const models = await harness.service.listModels({})
    assert.equal(models.length, 1)
  } finally {
    await harness.dispose()
  }
})

test('validate works against a stored revision and against a raw document', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    const stored = await harness.service.validateModel({ modelId: first.modelId })
    assert.equal(stored.valid, true)
    assert.equal(stored.modelId, first.modelId)
    const raw = await harness.service.validateModel({ document: bracketDocument() })
    assert.equal(raw.valid, true)
    let thrown = null
    try {
      await harness.service.validateModel({ document: { features: [{ id: 'x', op: 'nope' }] } })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'invalid_document')
    assert.equal(thrown.details.path, 'features[0].op')
  } finally {
    await harness.dispose()
  }
})

test('export returns references, copies into the workspace, and refuses escapes/overwrites', async () => {
  const harness = await makeService()
  const workspace = await tempDir('cad-workspace-')
  try {
    const first = await createBuilt(harness.service)
    const references = await harness.service.exportModel({ modelId: first.modelId })
    assert.equal(references.exported.length, 2)
    assert.equal(references.outputPath, null)

    const copied = await harness.service.exportModel({
      modelId: first.modelId,
      outputPath: 'exports/bracket',
      workspaceRoot: workspace,
    })
    assert.equal(copied.outputPath, join('exports', 'bracket'))
    const step = await stat(join(workspace, 'exports', 'bracket', 'model.step'))
    assert.ok(step.isFile() && step.size > 0)
    const glb = await stat(join(workspace, 'exports', 'bracket', 'model.glb'))
    assert.ok(glb.isFile() && glb.size > 0)

    await assert.rejects(
      () => harness.service.exportModel({ modelId: first.modelId, outputPath: 'exports/bracket', workspaceRoot: workspace }),
      error => error instanceof CadError && error.code === 'invalid_argument',
      'an existing file must not be overwritten without overwrite:true',
    )
    const overwritten = await harness.service.exportModel({
      modelId: first.modelId,
      outputPath: 'exports/bracket',
      workspaceRoot: workspace,
      overwrite: true,
    })
    assert.equal(overwritten.exported.length, 2)

    await assert.rejects(
      () => harness.service.exportModel({ modelId: first.modelId, outputPath: '/etc/cad', workspaceRoot: workspace }),
      error => error instanceof CadError && error.code === 'invalid_argument',
    )
    await assert.rejects(
      () => harness.service.exportModel({ modelId: first.modelId, outputPath: '../outside', workspaceRoot: workspace }),
      error => error instanceof CadError && error.code === 'path_escape',
    )
  } finally {
    await harness.dispose()
    await removeDir(workspace)
  }
})

test('export of a missing format rebuilds it into a derived cache, not a new revision', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    const exported = await harness.service.exportModel({ modelId: first.modelId, formats: ['stl'] })
    assert.equal(exported.formats[0], 'stl')
    const revisions = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(revisions.revisions.length, 1, 'export must not create a revision')
    const derived = await stat(join(harness.dataDir, 'models', first.modelId, 'exports', 'r-0001', 'model.stl'))
    assert.ok(derived.isFile())
  } finally {
    await harness.dispose()
  }
})

test('renderPreview caches preview.svg without creating a revision', async () => {
  const harness = await makeService()
  try {
    const first = await createBuilt(harness.service)
    const preview = await harness.service.renderPreview({ modelId: first.modelId, view: 'top', width: 800, height: 600 })
    assert.equal(preview.format, 'svg')
    assert.equal(preview.view, 'top')
    assert.equal(preview.artifact.contentType, 'image/svg+xml')
    assert.match(preview.artifact.url, /\/assets\/models\/.+\/previews\/r-0001\/preview\.svg$/u)
    const svg = await readFile(join(harness.dataDir, 'models', first.modelId, 'previews', 'r-0001', 'preview.svg'), 'utf8')
    assert.match(svg, /<svg/u)
    const revisions = await harness.service.listRevisions({ modelId: first.modelId })
    assert.equal(revisions.revisions.length, 1)
    // The cached preview is readable through the store with traversal safety.
    const cached = await harness.store.readPreview(first.modelId, 'r-0001', 'preview.svg')
    assert.equal(cached.contentType, 'image/svg+xml')
  } finally {
    await harness.dispose()
  }
})

test('health reports runtime availability and store facts', async () => {
  const harness = await makeService()
  try {
    const cold = await harness.service.health()
    assert.equal(cold.ok, true)
    assert.equal(cold.runtime.state, 'stopped')
    assert.equal(cold.runtime.available, false)
    await createBuilt(harness.service)
    const warm = await harness.service.health()
    assert.equal(warm.runtime.available, true)
    assert.equal(warm.runtime.state, 'ready')
    assert.equal(warm.store.modelCount, 1)
    assert.equal(warm.store.writable, true)
  } finally {
    await harness.dispose()
  }
})

test('allowModelWrite=false refuses mutation with permission_denied', async () => {
  const harness = await makeService({ overrides: { allowModelWrite: false } })
  try {
    await assert.rejects(
      () => harness.service.prepareCreate({ name: 'x', document: bracketDocument() }),
      error => error instanceof CadError && error.code === 'permission_denied',
    )
  } finally {
    await harness.dispose()
  }
})

test('a cancelled build persists a failed revision with error.code cancelled', async () => {
  const harness = await makeService({ runtimeMode: 'slow' })
  try {
    const prepared = await harness.service.prepareCreate({
      name: 'Cancelled',
      document: bracketDocument(),
      ownerSession: 'session-a',
    })
    const controller = new AbortController()
    const pending = harness.service.runBuild(prepared, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('user cancelled')), 150)
    let thrown = null
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError, `expected CadError, got ${String(thrown)}`)
    assert.equal(thrown.code, 'cancelled')
    const detail = await harness.service.modelDetail({ modelId: prepared.modelId })
    assert.equal(detail.revision.status, 'failed')
    assert.equal(detail.revision.error.code, 'cancelled')
    assert.equal(detail.model.currentRevision, 0)
  } finally {
    await harness.dispose()
  }
})

test('runtime status action:status and repair report structured state', async () => {
  const harness = await makeService()
  try {
    const status = await harness.service.runtimeStatus('status')
    assert.equal(status.ok, true)
    assert.equal(status.available, false)
    await createBuilt(harness.service)
    const healthy = await harness.service.runtimeStatus('status')
    assert.equal(healthy.available, true)
    assert.equal(healthy.probe.protocolVersion, '1.0')
    const repaired = await harness.service.runtimeStatus('repair')
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repaired, true)
    assert.equal(repaired.available, true)
  } finally {
    await harness.dispose()
  }
})

test('duplicate request under concurrency cannot double-build into the same model', async () => {
  const harness = await makeService()
  try {
    const prepared = await harness.service.prepareCreate({ name: 'Once', document: bracketDocument(), ownerSession: 'session-a' })
    const results = await Promise.allSettled([
      harness.service.runBuild(prepared),
      harness.service.runBuild(prepared),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length >= 1, true)
    const revisions = await harness.service.listRevisions({ modelId: prepared.modelId })
    assert.equal(revisions.revisions.length, 1)
  } finally {
    await harness.dispose()
  }
})
