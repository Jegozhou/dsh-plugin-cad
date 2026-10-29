import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CadError } from '../../src/host/contracts.ts'
import { CadStore, sha256Hex } from '../../src/host/store.ts'
import { bracketDocument, removeDir, tempDir, testConfig } from './helpers.mjs'

/** Build a store bound to a fresh temp directory. */
async function makeStore() {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const store = new CadStore({ root: dataDir, limits: config.limits })
  await store.ready()
  return { dataDir, store, dispose: () => removeDir(dataDir) }
}

/** Allocate a model with one revision (no build). */
async function createAllocated(store, options = {}) {
  const mutation = await store.createModel({
    name: options.name ?? 'Bracket',
    description: 'test model',
    document: bracketDocument(),
    ownerSession: options.ownerSession ?? 'session-a',
    requestId: options.requestId ?? null,
    formats: ['step', 'glb'],
  })
  return mutation
}

/** Write the fixed artifact set into a revision directory with truthful hashes. */
async function writeArtifacts(store, modelId, revisionId, overrides = {}) {
  const dir = store.revisionDirectory(modelId, revisionId)
  await mkdir(dir, { recursive: true })
  const files = {
    'model.step': 'ISO-10303-21;\nFAKE\n',
    'model.glb': 'glTF-fake-bytes',
    ...overrides,
  }
  const declared = []
  for (const [fileName, content] of Object.entries(files)) {
    const bytes = Buffer.from(content)
    await writeFile(join(dir, fileName), bytes)
    declared.push({
      format: fileName === 'model.step' ? 'step' : 'glb',
      fileName,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      contentType: fileName === 'model.step' ? 'application/step' : 'model/gltf-binary',
    })
  }
  return declared
}

/** Complete a revision as built with the given artifacts. */
async function completeBuilt(store, mutation, declared) {
  return store.completeBuild({
    modelId: mutation.index.id,
    revisionId: mutation.allocation.revisionId,
    number: mutation.allocation.number,
    buildKind: 'create',
    buildRequestId: mutation.allocation.documentSha256,
    documentSha256: mutation.allocation.documentSha256,
    formats: mutation.allocation.formats,
    ownerSession: 'session-a',
    completion: {
      status: 'built',
      report: {
        valid: true,
        volume: 1234.5,
        surfaceArea: 600,
        boundingBox: { min: [-40, -30, -4], max: [40, 30, 4], size: [80, 60, 8] },
        bbox: { min: [-40, -30, -4], max: [40, 30, 4], size: [80, 60, 8] },
        centroid: [0, 0, 0],
        topology: { faces: 9, edges: 21, vertices: 14, solids: 1 },
        checks: [{ id: 'brep_valid', status: 'pass', message: 'ok' }],
        featureReports: [],
        warnings: [],
        timings: { totalMs: 12 },
      },
      artifacts: declared,
      error: null,
      warnings: [],
      durationMs: 12,
      buildId: 'b-1',
    },
  })
}

test('createModel persists model.json with modelId/owner and an unbuilt revision', async () => {
  const { dataDir, store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    const modelId = mutation.index.id
    const index = JSON.parse(await readFile(join(dataDir, 'models', modelId, 'model.json'), 'utf8'))
    assert.equal(index.modelId, modelId)
    assert.equal(index.name, 'Bracket')
    assert.equal(index.currentRevision, 0)
    assert.equal(index.latestRevision, 1)
    assert.deepEqual(index.owner, { sessionId: 'session-a' })
    assert.equal(mutation.allocation.revisionId, 'r-0001')
    const document = JSON.parse(await readFile(join(dataDir, 'models', modelId, 'revisions', 'r-0001', 'document.json'), 'utf8'))
    assert.equal(document.schema, 'dsh.cad/document@1')
    assert.equal(sha256Hex(await readFile(join(dataDir, 'models', modelId, 'revisions', 'r-0001', 'document.json'))), mutation.allocation.documentSha256)
  } finally {
    await dispose()
  }
})

test('completeBuild promotes the current pointer and writes revision.json/report.json', async () => {
  const { dataDir, store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    const declared = await writeArtifacts(store, mutation.index.id, mutation.allocation.revisionId)
    const verified = await store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, declared, 1024 * 1024)
    assert.equal(verified.length, 2)
    const index = await completeBuilt(store, mutation, verified)
    assert.equal(index.currentRevision, 1)
    const revision = JSON.parse(await readFile(join(dataDir, 'models', mutation.index.id, 'revisions', 'r-0001', 'revision.json'), 'utf8'))
    assert.equal(revision.status, 'built')
    assert.equal(revision.artifacts.length, 2)
    const report = JSON.parse(await readFile(join(dataDir, 'models', mutation.index.id, 'revisions', 'r-0001', 'report.json'), 'utf8'))
    assert.equal(report.valid, true)
    assert.deepEqual(report.bbox.size, [80, 60, 8])
    assert.equal(report.volume, 1234.5)
  } finally {
    await dispose()
  }
})

test('optimistic concurrency: a stale expected_revision is revision_conflict', async () => {
  const { store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    const declared = await writeArtifacts(store, mutation.index.id, mutation.allocation.revisionId)
    await completeBuilt(store, mutation, await store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, declared, 1e6))
    let thrown = null
    try {
      await store.allocateRevision({
        modelId: mutation.index.id,
        document: bracketDocument({ parameters: { length: 90 } }),
        kind: 'modify',
        requestId: null,
        expectedRevision: 0,
        formats: ['step', 'glb'],
      })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'revision_conflict')
    assert.equal(thrown.details.currentRevision, 1)
    assert.equal(thrown.details.expectedRevision, 0)
  } finally {
    await dispose()
  }
})

test('request_id is idempotent for create and for modify', async () => {
  const { store, dispose } = await makeStore()
  try {
    const first = await createAllocated(store, { requestId: 'create-once' })
    const replay = await createAllocated(store, { requestId: 'create-once' })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.index.id, first.index.id)
    assert.equal((await store.listModels()).length, 1)

    const declared = await writeArtifacts(store, first.index.id, first.allocation.revisionId)
    await completeBuilt(store, first, await store.verifyArtifacts(first.index.id, first.allocation.revisionId, declared, 1e6))
    const edit = await store.allocateRevision({
      modelId: first.index.id,
      document: bracketDocument({ parameters: { length: 95 } }),
      kind: 'modify',
      requestId: 'modify-once',
      expectedRevision: 1,
      formats: ['step', 'glb'],
    })
    assert.equal(edit.duplicate, false)
    assert.equal(edit.allocation.number, 2)
    const editReplay = await store.allocateRevision({
      modelId: first.index.id,
      document: bracketDocument({ parameters: { length: 999 } }),
      kind: 'modify',
      requestId: 'modify-once',
      expectedRevision: 1,
      formats: ['step', 'glb'],
    })
    assert.equal(editReplay.duplicate, true)
    assert.equal(editReplay.allocation.number, 2)
    const index = await store.readModel(first.index.id)
    assert.equal(index.latestRevision, 2, 'replay must not allocate a third revision')
  } finally {
    await dispose()
  }
})

test('a failed build keeps the previous current revision and persists the failure', async () => {
  const { store, dispose } = await makeStore()
  try {
    const first = await createAllocated(store)
    const declared = await writeArtifacts(store, first.index.id, first.allocation.revisionId)
    await completeBuilt(store, first, await store.verifyArtifacts(first.index.id, first.allocation.revisionId, declared, 1e6))
    const second = await store.allocateRevision({
      modelId: first.index.id,
      document: bracketDocument({ parameters: { thickness: 1 } }),
      kind: 'modify',
      requestId: null,
      expectedRevision: 1,
      formats: ['step', 'glb'],
    })
    const index = await store.completeBuild({
      modelId: first.index.id,
      revisionId: second.allocation.revisionId,
      number: second.allocation.number,
      buildKind: 'modify',
      buildRequestId: null,
      documentSha256: second.allocation.documentSha256,
      formats: ['step', 'glb'],
      ownerSession: 'session-a',
      completion: {
        status: 'failed',
        report: null,
        artifacts: [],
        error: { code: 'invalid_geometry', message: 'B-rep invalid', details: { checks: [] } },
        warnings: [],
        durationMs: 5,
        buildId: null,
      },
    })
    assert.equal(index.currentRevision, 1)
    assert.equal(index.latestRevision, 2)
    const revision = await store.readRevision(first.index.id, 'r-0002')
    assert.equal(revision.meta.status, 'failed')
    assert.equal(revision.meta.error.code, 'invalid_geometry')
    // A retry against the still-current revision is allowed and gets revision 3.
    const retry = await store.allocateRevision({
      modelId: first.index.id,
      document: bracketDocument({ parameters: { thickness: 6 } }),
      kind: 'modify',
      requestId: null,
      expectedRevision: 1,
      formats: ['step', 'glb'],
    })
    assert.equal(retry.allocation.number, 3)
  } finally {
    await dispose()
  }
})

test('artifacts are verified against real bytes; a lying runtime is rejected', async () => {
  const { store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    const declared = await writeArtifacts(store, mutation.index.id, mutation.allocation.revisionId)
    const lying = declared.map(entry => ({ ...entry, sha256: 'f'.repeat(64) }))
    await assert.rejects(
      () => store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, lying, 1e6),
      error => error instanceof CadError && error.code === 'build_failed',
    )
    const missing = [...declared, { format: 'stl', fileName: 'model.stl', bytes: 4, sha256: 'a'.repeat(64), contentType: 'model/stl' }]
    await assert.rejects(
      () => store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, missing, 1e6),
      error => error instanceof CadError && error.code === 'build_failed',
    )
    const wrongName = [{ ...declared[0], fileName: 'model.glb' }]
    await assert.rejects(
      () => store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, wrongName, 1e6),
      error => error instanceof CadError && error.code === 'build_failed',
    )
    const tooBig = [{ ...declared[0], bytes: 10 * 1024 * 1024 }]
    await assert.rejects(
      () => store.verifyArtifacts(mutation.index.id, mutation.allocation.revisionId, tooBig, 1024),
      error => error instanceof CadError && error.code === 'too_large',
    )
  } finally {
    await dispose()
  }
})

test('traversal, separators and symlink escapes are refused', async () => {
  const { dataDir, store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    const modelId = mutation.index.id
    await assert.rejects(() => store.readArtifact(modelId, 'r-0001', '../model.json'), error => error instanceof CadError && (error.code === 'path_escape' || error.code === 'invalid_argument' || error.code === 'not_found'))
    await assert.rejects(() => store.readArtifact(modelId, 'r-0001', '/etc/passwd'), error => error instanceof CadError && error.code !== undefined)
    await assert.rejects(() => store.readStoreFile(['models', '..', 'model.json']), error => error instanceof CadError && error.code === 'path_escape')

    // A symlink inside a revision directory must not be followed.
    const revisionDir = join(dataDir, 'models', modelId, 'revisions', 'r-0001')
    await mkdir(revisionDir, { recursive: true })
    await symlink('/etc/hosts', join(revisionDir, 'model.stl'))
    await assert.rejects(
      () => store.readArtifact(modelId, 'r-0001', 'model.stl'),
      error => error instanceof CadError && error.code === 'path_escape',
    )
  } finally {
    await dispose()
  }
})

test('listModels returns every model regardless of the creating session', async () => {
  const { store, dispose } = await makeStore()
  try {
    await createAllocated(store, { name: 'A', ownerSession: 'session-a' })
    await createAllocated(store, { name: 'B', ownerSession: 'session-b' })
    const models = await store.listModels()
    assert.equal(models.length, 2)
    assert.deepEqual(models.map(model => model.name).sort(), ['A', 'B'])
    assert.deepEqual(new Set(models.map(model => (model.owner ?? {}).sessionId)), new Set(['session-a', 'session-b']))
  } finally {
    await dispose()
  }
})

test('allocations are serialized per model: concurrent writers cannot both win', async () => {
  const { store, dispose } = await makeStore()
  try {
    const first = await createAllocated(store)
    const declared = await writeArtifacts(store, first.index.id, first.allocation.revisionId)
    await completeBuilt(store, first, await store.verifyArtifacts(first.index.id, first.allocation.revisionId, declared, 1e6))
    const results = await Promise.allSettled([
      store.allocateRevision({ modelId: first.index.id, document: bracketDocument({ parameters: { length: 81 } }), kind: 'modify', requestId: null, expectedRevision: 1, formats: ['glb'] }),
      store.allocateRevision({ modelId: first.index.id, document: bracketDocument({ parameters: { length: 82 } }), kind: 'modify', requestId: null, expectedRevision: 1, formats: ['glb'] }),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one concurrent edit may allocate')
    assert.equal(rejected.length, 1)
    assert.ok(['revision_conflict', 'model_locked'].includes(rejected[0].reason.code), `unexpected code ${rejected[0].reason.code}`)
    const index = await store.readModel(first.index.id)
    assert.equal(index.latestRevision, 2)
  } finally {
    await dispose()
  }
})

test('markUnbuilt persists a readable revision without moving the pointer', async () => {
  const { store, dispose } = await makeStore()
  try {
    const mutation = await createAllocated(store)
    await store.markUnbuilt({
      modelId: mutation.index.id,
      revisionId: mutation.allocation.revisionId,
      number: mutation.allocation.number,
      buildKind: 'create',
      buildRequestId: null,
      documentSha256: mutation.allocation.documentSha256,
      formats: ['step', 'glb'],
      ownerSession: 'session-a',
    })
    const revision = await store.readRevision(mutation.index.id, 'r-0001')
    assert.equal(revision.meta.status, 'unbuilt')
    const index = await store.readModel(mutation.index.id)
    assert.equal(index.currentRevision, 0)
  } finally {
    await dispose()
  }
})
