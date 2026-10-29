import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TOOL_NAMES, TOOL_SCHEMAS } from '../../src/host/contracts.ts'
import { CadJobs } from '../../src/host/jobs.ts'
import { registerTools } from '../../src/host/tools.ts'
import { bracketDocument, makeService, stubJobsRegistry, stubTools, tempDir, removeDir, waitFor } from './helpers.mjs'

/** Build a full tool harness around a fake-runtime service. */
async function makeToolHarness(options = {}) {
  const harness = await makeService(options)
  const tools = stubTools()
  const jobs = new CadJobs({ registry: options.jobsRegistry === undefined ? stubJobsRegistry() : options.jobsRegistry })
  const unregisterController = jobs.attach()
  const disposers = registerTools(tools, { service: harness.service, jobs, config: harness.config })
  const invoke = (name, args, exec = {}) => {
    const definition = tools.definitions.get(name)
    if (definition === undefined) throw new Error(`tool ${name} is not registered`)
    return definition.execute(args, exec)
  }
  return {
    ...harness,
    tools,
    jobs,
    disposeTools: () => {
      for (const dispose of disposers) dispose()
      unregisterController()
    },
    invoke,
    async dispose() {
      for (const dispose of disposers) dispose()
      unregisterController()
      await harness.dispose()
    },
  }
}

/** A workspace-relative export needs an agent session cwd. */
function agentExec(workspace, extra = {}) {
  return {
    agent: { id: 'session-1', session: { header: { cwd: workspace } } },
    callId: 'call-1',
    rootCallId: 'root-1',
    ...extra,
  }
}

test('registers exactly the nine contract tools, in order, with the contract schemas', async () => {
  const harness = await makeToolHarness()
  try {
    assert.equal(harness.tools.definitions.size, 9)
    assert.deepEqual([...harness.tools.definitions.keys()], [...TOOL_NAMES])
    for (const name of TOOL_NAMES) {
      const definition = harness.tools.definitions.get(name)
      assert.deepEqual(definition.parameters, TOOL_SCHEMAS[name], `${name} parameters drifted from the contract`)
      assert.equal(definition.parameters.type, 'object')
      // The harness enforces this subset on output.schema at registration.
      assert.equal(definition.output.schema.type, 'object')
      assert.deepEqual(definition.output.schema.required, ['ok'])
      assert.equal(definition.output.schema.properties.ok.type, 'boolean')
      assert.equal(definition.presentCall({}).card, 'generic')
      assert.ok(typeof definition.presentCall({}).title === 'string')
      assert.ok(definition.description.length > 80, `${name} needs a model-facing description`)
      assert.ok(Number.isSafeInteger(definition.timeoutMs) && definition.timeoutMs > 0)
    }
    // Descriptions teach discovery-first usage.
    assert.match(harness.tools.definitions.get('cad_list_models').description, /FIRST/u)
    assert.match(harness.tools.definitions.get('cad_inspect_model').description, /expected_revision/u)
  } finally {
    await harness.dispose()
  }
})

test('cad_create_model returns the success envelope and literal artifact references', async () => {
  const harness = await makeToolHarness()
  try {
    const result = await harness.invoke('cad_create_model', { document: bracketDocument(), name: 'Mounting bracket' }, agentExec('/tmp'))
    assert.equal(result.ok, true)
    assert.equal(result.status, 'built')
    assert.equal(result.revision, 1)
    assert.equal(result.artifacts.length, 2)
    assert.match(result.artifacts[0].url, /^\/dsh-plugin-cad\/assets\/models\/m-[0-9a-f]{10}\/r-0001\/model\./u)
    assert.equal(typeof result.report.valid, 'boolean')
    assert.equal(result.document, undefined, 'a tool result never inlines the document')
    // Everything is lossless JSON (no undefined keys, finite numbers).
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  } finally {
    await harness.dispose()
  }
})

test('invalid documents and arguments come back as {ok:false,error:{code,message,details}}', async () => {
  const harness = await makeToolHarness()
  try {
    const invalidDocument = await harness.invoke('cad_create_model', { document: { features: [{ id: 'x', op: 'boom' }] } })
    assert.equal(invalidDocument.ok, false)
    assert.equal(invalidDocument.error.code, 'invalid_document')
    assert.equal(invalidDocument.error.details.path, 'features[0].op')

    const missingModel = await harness.invoke('cad_inspect_model', { model_id: 'm-0000000000' })
    assert.equal(missingModel.ok, false)
    assert.equal(missingModel.error.code, 'not_found')

    const badArgs = await harness.invoke('cad_modify_model', { model_id: 'm-0000000000' })
    assert.equal(badArgs.ok, false)
    assert.equal(badArgs.error.code, 'invalid_argument')
  } finally {
    await harness.dispose()
  }
})

test('discovery tools: list then inspect (summary vs document), and modify by parameter', async () => {
  const harness = await makeToolHarness()
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument(), name: 'Bracket' }, agentExec('/tmp'))
    const list = await harness.invoke('cad_list_models', {})
    assert.equal(list.ok, true)
    assert.equal(list.count, 1)
    assert.equal(list.models[0].modelId, created.modelId)
    assert.equal(list.models[0].currentRevision, 1)
    assert.match(list.models[0].glbUrl, /model\.glb$/u)

    const summary = await harness.invoke('cad_inspect_model', { model_id: created.modelId })
    assert.equal(summary.ok, true)
    assert.equal(summary.document, undefined)
    const withDocument = await harness.invoke('cad_inspect_model', { model_id: created.modelId, include: 'document' })
    assert.equal(withDocument.document.parameters.length, 80)
    assert.equal(withDocument.document.featureCount, 3)
    assert.equal(withDocument.revision.status, 'built')
    assert.equal(withDocument.viewer.glbUrl !== null, true)

    const conflict = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 0,
      parameters: { length: 90 },
    })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'revision_conflict')

    const modified = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 1,
      parameters: { length: 100 },
    }, agentExec('/tmp'))
    assert.equal(modified.ok, true)
    assert.equal(modified.revision, 2)
    assert.deepEqual(modified.report.bbox.size, [100, 60, 8])

    const invalidEdit = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 2,
      parameters: { center_d: 999 },
    })
    assert.equal(invalidEdit.ok, false)
    assert.equal(invalidEdit.error.code, 'invalid_argument')

    const afterInvalid = await harness.invoke('cad_list_models', {})
    assert.equal(afterInvalid.models[0].latestRevision, 2, 'an invalid edit must not allocate a revision')
  } finally {
    await harness.dispose()
  }
})

test('cad_validate_model validates a stored revision and a raw document', async () => {
  const harness = await makeToolHarness()
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec('/tmp'))
    const stored = await harness.invoke('cad_validate_model', { model_id: created.modelId })
    assert.equal(stored.ok, true)
    assert.equal(stored.valid, true)
    const raw = await harness.invoke('cad_validate_model', { document: bracketDocument() })
    assert.equal(raw.ok, true)
    assert.equal(raw.valid, true)
    const broken = await harness.invoke('cad_validate_model', { document: { features: [] } })
    assert.equal(broken.ok, false)
    assert.equal(broken.error.code, 'invalid_document')
  } finally {
    await harness.dispose()
  }
})

test('cad_export_model copies into the session workspace and refuses to escape it', async () => {
  const harness = await makeToolHarness()
  const workspace = await tempDir('cad-tool-workspace-')
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec(workspace))
    const exported = await harness.invoke('cad_export_model', {
      model_id: created.modelId,
      output_path: 'out/bracket',
    }, agentExec(workspace))
    assert.equal(exported.ok, true)
    assert.equal(exported.outputPath, join('out', 'bracket'))
    const bytes = await readFile(join(workspace, 'out', 'bracket', 'model.glb'))
    assert.ok(bytes.length > 0)

    const escape = await harness.invoke('cad_export_model', {
      model_id: created.modelId,
      output_path: '../escape',
    }, agentExec(workspace))
    assert.equal(escape.ok, false)
    assert.equal(escape.error.code, 'path_escape')

    const noWorkspace = await harness.invoke('cad_export_model', {
      model_id: created.modelId,
      output_path: 'out/bracket',
    }, {})
    assert.equal(noWorkspace.ok, false)
    assert.equal(noWorkspace.error.code, 'permission_denied')
  } finally {
    await harness.dispose()
    await removeDir(workspace)
  }
})

test('cad_render_preview caches an SVG reference', async () => {
  const harness = await makeToolHarness()
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec('/tmp'))
    const preview = await harness.invoke('cad_render_preview', { model_id: created.modelId, view: 'iso', width: 640 })
    assert.equal(preview.ok, true)
    assert.equal(preview.format, 'svg')
    assert.equal(preview.artifact.contentType, 'image/svg+xml')
    assert.match(preview.artifact.url, /\/previews\/r-0001\/preview\.svg$/u)
  } finally {
    await harness.dispose()
  }
})

test('cad_get_job_status lists jobs and reports an unknown id instead of throwing', async () => {
  const harness = await makeToolHarness()
  try {
    const empty = await harness.invoke('cad_get_job_status', {})
    assert.equal(empty.ok, true)
    assert.equal(empty.available, true)
    assert.deepEqual(empty.jobs, [])
    const bogus = await harness.invoke('cad_get_job_status', { job_id: 'not-a-job' })
    assert.equal(bogus.ok, false)
    assert.equal(bogus.error.code, 'invalid_argument')
  } finally {
    await harness.dispose()
  }
})

test('background create uses ctx.jobs with the owner session id and completes', async () => {
  const registry = stubJobsRegistry()
  const harness = await makeToolHarness({ jobsRegistry: registry })
  try {
    const started = await harness.invoke('cad_create_model', {
      document: bracketDocument(),
      name: 'Background bracket',
      background: true,
    }, agentExec('/tmp'))
    assert.equal(started.ok, true)
    assert.equal(started.background, true)
    assert.match(started.jobId, /^cad-/u)
    assert.equal(started.status, 'building')

    // The owner must be a session-id string, not an Agent object (0.2.1-rc.3).
    const snapshot = await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === started.jobId)
      return job !== undefined && job.status === 'completed' ? job : null
    }, { label: 'background job completion' })
    assert.equal(snapshot.status, 'completed')

    const status = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(status.ok, true)
    assert.equal(status.job.status, 'completed')
    const model = await harness.invoke('cad_inspect_model', { model_id: started.modelId })
    assert.equal(model.revision.status, 'built')
  } finally {
    await harness.dispose()
  }
})

test('a refused background start releases the model lock so the next edit succeeds', async () => {
  // A registry whose start() always fails, like the 0.2.1-rc.3 owner bug did.
  const failingRegistry = {
    attachController: () => () => {},
    start: () => {
      throw new Error('session "x" has no live agent (background job owner must be live)')
    },
    get: () => { throw new Error('no jobs') },
    read: () => { throw new Error('no jobs') },
    list: () => [],
    kill: () => 'already-finished',
  }
  const harness = await makeToolHarness({ jobsRegistry: failingRegistry })
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec('/tmp'))
    assert.equal(created.ok, true)

    const failedBackground = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 1,
      parameters: { length: 90 },
      background: true,
    }, agentExec('/tmp'))
    assert.equal(failedBackground.ok, false)
    assert.match(failedBackground.error.message, /no live agent/u)

    // The abandoned revision is persisted as failed, not left dangling unbuilt.
    const inspected = await harness.invoke('cad_inspect_model', { model_id: created.modelId })
    assert.equal(inspected.model.latestStatus, 'failed')
    assert.equal(inspected.model.currentRevision, 1)

    // And the per-model write fence is released: the next edit is accepted.
    const next = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 1,
      parameters: { length: 95 },
    }, agentExec('/tmp'))
    assert.equal(next.ok, true, JSON.stringify(next))
    assert.equal(next.revision, 3)
  } finally {
    await harness.dispose()
  }
})

test('cad_get_job_status reads a SETTLED job twice without an internal error (real 0.2.1-rc.3 read shape)', async () => {
  const registry = stubJobsRegistry()
  const harness = await makeToolHarness({ jobsRegistry: registry })
  try {
    const started = await harness.invoke('cad_create_model', {
      document: bracketDocument(),
      name: 'Settled bracket',
      background: true,
    }, agentExec('/tmp'))
    assert.equal(started.ok, true, JSON.stringify(started))
    await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === started.jobId)
      return job !== undefined && job.status === 'completed' ? job : null
    }, { label: 'job settlement' })

    // First read after settlement: the registry hands back {chunks,lossy,result,job}.
    const first = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.error, undefined, 'a settled job must never surface as internal')
    assert.equal(first.job.status, 'completed')
    assert.equal(first.job.done, true)
    assert.notEqual(first.job.finishedAt, null)
    assert.match(first.output, /done: /u, 'progress output reaches the job ring through handle.append')
    assert.deepEqual(first.result, { modelId: started.modelId, revisionId: started.revisionId, revision: 1, status: 'built' })

    // Second read: no re-delivery of the terminal result, same terminal snapshot.
    const second = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.job.status, 'completed')
    assert.equal(second.result, null)
    assert.equal(second.job.jobId, first.job.jobId)
    assert.equal(second.job.startedAt, first.job.startedAt)
    assert.equal(second.job.finishedAt, first.job.finishedAt)
  } finally {
    await harness.dispose()
  }
})

test('cancelling an ALREADY-FINISHED job returns already-finished and its terminal snapshot', async () => {
  const registry = stubJobsRegistry()
  const harness = await makeToolHarness({ jobsRegistry: registry })
  try {
    const started = await harness.invoke('cad_create_model', {
      document: bracketDocument(),
      background: true,
    }, agentExec('/tmp'))
    assert.equal(started.ok, true)
    await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === started.jobId)
      return job !== undefined && job.status === 'completed' ? job : null
    }, { label: 'job settlement before cancel' })

    const cancel = await harness.invoke('cad_get_job_status', { job_id: started.jobId, action: 'cancel' }, agentExec('/tmp'))
    assert.equal(cancel.ok, true, JSON.stringify(cancel))
    assert.equal(cancel.cancelled, 'already-finished')
    assert.equal(cancel.job.status, 'completed')
    assert.equal(cancel.job.cancelled, false)

    const after = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(after.ok, true)
    assert.equal(after.job.status, 'completed')
    assert.equal(after.job.jobId, started.jobId)
  } finally {
    await harness.dispose()
  }
})

test('a settled job whose registry projection is malformed yields structured internal, never a TypeError', async () => {
  const brokenRegistry = {
    attachController: () => () => {},
    start: () => {
      throw new Error('not used in this test')
    },
    get: () => undefined,
    read: () => ({ chunks: [], lossy: false, job: undefined }),
    list: () => [],
    kill: () => 'already-finished',
  }
  const harness = await makeToolHarness({ jobsRegistry: brokenRegistry })
  try {
    const status = await harness.invoke('cad_get_job_status', { job_id: 'cad-0000000000000000' }, agentExec('/tmp'))
    assert.equal(status.ok, false)
    assert.equal(status.error.code, 'internal')
    assert.match(status.error.message, /malformed/u)
    const list = await harness.invoke('cad_get_job_status', {}, agentExec('/tmp'))
    assert.equal(list.ok, true)
    assert.deepEqual(list.jobs, [])
  } finally {
    await harness.dispose()
  }
})

test('cad_get_job_status uses the session-id caller fence of the shipped registry', async () => {
  const registry = stubJobsRegistry()
  const harness = await makeToolHarness({ jobsRegistry: registry, runtimeMode: 'slow' })
  try {
    const model = await harness.invoke('cad_create_model', { document: bracketDocument(), build: false })
    const started = await harness.invoke('cad_modify_model', {
      model_id: model.modelId,
      expected_revision: 0,
      parameters: { length: 91 },
      background: true,
    }, agentExec('/tmp'))
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(registry.list('session-1').length, 1, 'start must record the session-id string as owner')
    assert.equal(registry.list('session-2').length, 0, 'another session must not see this job')

    // The owning session reads its own job (this is what failed in scenario H).
    const own = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(own.ok, true, JSON.stringify(own))
    assert.equal(own.job.jobId, started.jobId)
    assert.equal(['running', 'stopping'].includes(own.job.status), true)

    // A foreign session is refused by the registry fence, not leaked.
    const foreign = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp', {
      agent: { id: 'session-2', session: { header: { cwd: '/tmp' } } },
    }))
    assert.equal(foreign.ok, false)
    assert.equal(foreign.error.code, 'permission_denied')
    assert.match(foreign.error.message, /belongs to another session/u)
    const foreignList = await harness.invoke('cad_get_job_status', {}, agentExec('/tmp', {
      agent: { id: 'session-2', session: { header: { cwd: '/tmp' } } },
    }))
    assert.equal(foreignList.ok, true)
    assert.deepEqual(foreignList.jobs, [])

    // Cancel with the same caller id reaches a terminal killed record.
    const cancelled = await harness.invoke('cad_get_job_status', { job_id: started.jobId, action: 'cancel' }, agentExec('/tmp'))
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    assert.equal(cancelled.cancelled, 'requested')
    const terminal = await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === started.jobId)
      return job !== undefined && job.status === 'killed' ? job : null
    }, { label: 'own cancelled job settlement', timeoutMs: 10_000 })
    assert.equal(terminal.status, 'killed')
    const status = await harness.invoke('cad_get_job_status', { job_id: started.jobId }, agentExec('/tmp'))
    assert.equal(status.job.status, 'killed')
    assert.equal(status.job.cancelled, true)
  } finally {
    await harness.dispose()
  }
})

test('a queued background build can be cancelled and reports a terminal state', async () => {
  const registry = stubJobsRegistry()
  const harness = await makeToolHarness({ jobsRegistry: registry, runtimeMode: 'slow' })
  try {
    const modelA = await harness.invoke('cad_create_model', { document: bracketDocument(), name: 'A', build: false })
    const modelB = await harness.invoke('cad_create_model', { document: bracketDocument(), name: 'B', build: false })
    assert.equal(modelA.ok, true)
    assert.equal(modelB.ok, true)

    const jobA = await harness.invoke('cad_modify_model', {
      model_id: modelA.modelId,
      expected_revision: 0,
      parameters: { length: 81 },
      background: true,
    }, agentExec('/tmp'))
    assert.equal(jobA.ok, true)
    // B is queued behind A (maxConcurrentBuilds: 1).
    const jobB = await harness.invoke('cad_modify_model', {
      model_id: modelB.modelId,
      expected_revision: 0,
      parameters: { length: 82 },
      background: true,
    }, agentExec('/tmp'))
    assert.equal(jobB.ok, true)

    const cancelled = await harness.invoke('cad_get_job_status', { job_id: jobB.jobId, action: 'cancel' }, agentExec('/tmp'))
    assert.equal(cancelled.ok, true)
    assert.equal(cancelled.cancelled, 'requested')
    const snapshot = await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === jobB.jobId)
      return job !== undefined && (job.status === 'killed' || job.status === 'completed') ? job : null
    }, { label: 'cancelled job settlement', timeoutMs: 10_000 })
    assert.equal(snapshot.status, 'killed', 'the queued job must end cancelled/killed')

    const statusB = await harness.invoke('cad_get_job_status', { job_id: jobB.jobId }, agentExec('/tmp'))
    assert.equal(statusB.job.status, 'killed')
    // No artifacts and no dangling lock for B.
    const detailB = await harness.invoke('cad_inspect_model', { model_id: modelB.modelId })
    assert.equal(detailB.revision.status, 'failed')
    assert.equal(detailB.revision.error.code, 'cancelled')
    assert.equal(detailB.revision.artifacts.length, 0)

    // Cancelling the in-flight job (A) must also reach a terminal state, leave
    // no artifacts, and release A's lock.
    const cancelledA = await harness.invoke('cad_get_job_status', { job_id: jobA.jobId, action: 'cancel' }, agentExec('/tmp'))
    assert.equal(cancelledA.ok, true)
    assert.equal(cancelledA.cancelled, 'requested')
    const snapshotA = await waitFor(() => {
      const job = registry.list('session-1').find(entry => entry.id === jobA.jobId)
      return job !== undefined && (job.status === 'killed' || job.status === 'completed') ? job : null
    }, { label: 'in-flight cancelled job settlement', timeoutMs: 10_000 })
    assert.equal(snapshotA.status, 'killed')
    const statusA = await harness.invoke('cad_get_job_status', { job_id: jobA.jobId }, agentExec('/tmp'))
    assert.equal(statusA.job.cancelled, true)
    const detailA = await harness.invoke('cad_inspect_model', { model_id: modelA.modelId })
    assert.equal(detailA.revision.status, 'failed')
    assert.equal(detailA.revision.error.code, 'cancelled')
    assert.equal(detailA.revision.artifacts.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('exec.signal cancellation of a foreground call settles as cancelled and does not corrupt later builds', async () => {
  const harness = await makeToolHarness()
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec('/tmp'))
    const controller = new AbortController()
    controller.abort(new Error('user aborted'))
    const cancelled = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 1,
      parameters: { length: 101 },
    }, agentExec('/tmp', { signal: controller.signal }))
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.error.code, 'cancelled')

    const next = await harness.invoke('cad_modify_model', {
      model_id: created.modelId,
      expected_revision: 1,
      parameters: { length: 102 },
    }, agentExec('/tmp'))
    assert.equal(next.ok, true)
    assert.equal(next.revision, 2)
  } finally {
    await harness.dispose()
  }
})

test('cad_runtime_status reports state and repairs', async () => {
  const harness = await makeToolHarness()
  try {
    const cold = await harness.invoke('cad_runtime_status', {})
    assert.equal(cold.ok, true)
    assert.equal(cold.available, false)
    await harness.invoke('cad_create_model', { document: bracketDocument() }, agentExec('/tmp'))
    const warm = await harness.invoke('cad_runtime_status', { verbose: true })
    assert.equal(warm.ok, true)
    assert.equal(warm.available, true)
    assert.ok(warm.diagnostics.stderrLines.length >= 0)
    const repaired = await harness.invoke('cad_runtime_status', { action: 'repair' })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repaired, true)
  } finally {
    await harness.dispose()
  }
})

test('disabled writes and background-without-jobs fail with structured codes', async () => {
  const harness = await makeToolHarness({ overrides: { allowModelWrite: false } })
  try {
    const created = await harness.invoke('cad_create_model', { document: bracketDocument() })
    assert.equal(created.ok, false)
    assert.equal(created.error.code, 'permission_denied')
    const listed = await harness.invoke('cad_list_models', {})
    assert.equal(listed.ok, true, 'read-only tools still work when writes are disabled')
  } finally {
    await harness.dispose()
  }

  const noJobs = await makeToolHarness({ jobsRegistry: null })
  try {
    const background = await noJobs.invoke('cad_create_model', { document: bracketDocument(), background: true })
    assert.equal(background.ok, false)
    assert.equal(background.error.code, 'invalid_argument')
    const models = await noJobs.invoke('cad_list_models', {})
    assert.equal(models.count, 0, 'a refused background request must not leave a model behind')
  } finally {
    await noJobs.dispose()
  }
})
