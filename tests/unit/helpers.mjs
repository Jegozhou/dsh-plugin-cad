/**
 * Shared helpers for the host unit tests.
 *
 * Every test spawns the scripted fake runtime as a REAL child process
 * (`tests/fixtures/fake-runtime.mjs`), so the supervisor's framing, timeouts,
 * cancellation, crash recovery and teardown are exercised for real — only the
 * geometry is fake.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../../src/host/config.ts'
import { CadStore } from '../../src/host/store.ts'
import { CadRuntime } from '../../src/host/runtime.ts'
import { CadService } from '../../src/host/service.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))

/** Fixture directory (inside the unit-test scope so it never mixes with E2E output). */
export const FIXTURES_DIR = join(THIS_DIR, 'fixtures')

/** Absolute path of the fake runtime entry. */
export const FAKE_RUNTIME = join(FIXTURES_DIR, 'fake-runtime.mjs')

/** Package root (three levels up from tests/unit/helpers.mjs). */
export const PLUGIN_ROOT = join(THIS_DIR, '..', '..')

/** Create a throwaway data directory. */
export async function tempDir(prefix = 'cad-host-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Remove a throwaway directory. */
export async function removeDir(path) {
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Normalized test configuration with short timeouts.
 * @param {{ dataDir?: string, env?: Record<string,string>, overrides?: Record<string, unknown> }} [options]
 */
export function testConfig(options = {}) {
  const { dataDir, env = {}, overrides = {} } = options
  return normalizeConfig({
    dataDir,
    buildTimeoutMs: 20_000,
    runtimeStartTimeoutMs: 15_000,
    ...overrides,
  }, {
    env: { ...process.env, ...env },
    pluginRoot: PLUGIN_ROOT,
    home: process.env.HOME,
  })
}

/**
 * A supervisor bound to the fake runtime child process.
 * @param {ReturnType<typeof testConfig>} config
 * @param {{ mode?: string, delayMs?: number, env?: Record<string,string> }} [options]
 */
export function fakeRuntime(config, options = {}) {
  const { mode = 'ok', delayMs = 0, env = {} } = options
  return new CadRuntime({
    config,
    pluginRoot: PLUGIN_ROOT,
    command: {
      executable: process.execPath,
      args: [FAKE_RUNTIME],
      cwd: FIXTURES_DIR,
      env: {
        ...process.env,
        FAKE_RUNTIME_MODE: mode,
        FAKE_RUNTIME_DELAY_MS: String(delayMs),
        ...env,
      },
      source: 'config',
    },
  })
}

/**
 * A service with its own store, fake runtime and temp data directory.
 * Always call `dispose()` in a `finally`.
 * @param {{ runtimeMode?: string, delayMs?: number, overrides?: Record<string, unknown>, env?: Record<string,string> }} [options]
 */
export async function makeService(options = {}) {
  const { runtimeMode = 'ok', delayMs = 0, overrides = {}, env = {} } = options
  const dataDir = await tempDir()
  const config = testConfig({ dataDir, overrides, env })
  const store = new CadStore({ root: dataDir, limits: config.limits })
  await store.ready()
  const runtime = fakeRuntime(config, { mode: runtimeMode, delayMs, env })
  const service = new CadService({ config, store, runtime })
  return {
    dataDir,
    config,
    store,
    runtime,
    service,
    dispose: async () => {
      await runtime.dispose()
      await removeDir(dataDir)
    },
  }
}

/** The P0 acceptance part: 80×60×8 bracket, Ø20 centre hole, 4×Ø6 corner holes. */
export function bracketDocument(overrides = {}) {
  return {
    schema: 'dsh.cad/document@1',
    units: 'mm',
    parameters: {
      length: 80,
      width: 60,
      thickness: 8,
      center_d: 20,
      hole_d: 6,
      inset: 12,
      ...(overrides.parameters ?? {}),
    },
    features: overrides.features ?? [
      { id: 'base', op: 'box', length: '$length', width: '$width', height: '$thickness' },
      { id: 'center_hole', op: 'hole', diameter: '$center_d', at: [0, 0], through: true },
      { id: 'corner_holes', op: 'hole_pattern', pattern: 'rect_corners', diameter: '$hole_d', inset: '$inset', span: ['$length', '$width'], through: true },
    ],
    ...(overrides.name === undefined ? {} : { name: overrides.name }),
  }
}

/** A stubbed `ctx.tools` registry that records definitions. */
export function stubTools() {
  const definitions = new Map()
  return {
    definitions,
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  }
}

/**
 * In-memory stand-in for `ctx.jobs` that mirrors the SHIPPED 0.2.1-rc.3
 * registry — including every drift from the stale 0.1.1-rc.2 typings that
 * caused real defects:
 *   - `start({owner})` requires the owner to be the session-id STRING;
 *   - `get/read/kill/list(caller)` compare that string with the job owner
 *     (`assertAccess`: `job.owner.id !== caller`), so a foreign caller is
 *     rejected with "belongs to another session";
 *   - `run(handle)` receives `{append, updateProgress}`; there is no
 *     `readOutput` hook and output only reaches the ring through `append`;
 *   - `read()` returns `{chunks,lossy,result?,job}` (not `{text,snapshot}`) and
 *     a terminal `result` is delivered exactly once;
 *   - `view()` is `{id,kind,label,owner?,status,detail?,progress?,startedAt,
 *     finishedAt?,output:{total,earliest}}` — a settled job keeps its record
 *     and stays readable.
 */
export function stubJobsRegistry() {
  let counter = 0
  let attached = 0
  const jobs = new Map()
  const controllers = new Set()

  /** The real registry's access fence. */
  function assertAccess(record, caller) {
    if (record.owner !== undefined && record.owner !== caller) {
      throw new Error(`job ${record.id} belongs to another session`)
    }
  }

  /** Shipped `view(job)` projection. */
  function view(record) {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      ...(record.owner === undefined ? {} : { owner: record.owner }),
      status: record.status,
      ...(record.progress === undefined ? {} : { progress: record.progress }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      output: { total: record.total, earliest: 0 },
    }
  }

  function expect(id, caller) {
    const record = jobs.get(id)
    if (record === undefined) throw new Error(`unknown job ${id}`)
    assertAccess(record, caller)
    return record
  }

  function isTerminal(status) {
    return status === 'completed' || status === 'killed' || status === 'failed'
  }

  const registry = {
    attachController(name) {
      attached += 1
      const token = Symbol(name)
      controllers.add(token)
      return () => controllers.delete(token)
    },
    get attachedCount() {
      return attached
    },
    start(spec) {
      if (controllers.size === 0) throw new Error('background jobs unavailable: no job controller serves this agent')
      if (spec.owner !== undefined && typeof spec.owner !== 'string') {
        // This exact mistake ("[object Object]") was a real production defect.
        throw new Error(`background job owner must be a session id string, got ${typeof spec.owner}`)
      }
      if (spec.toolCall !== undefined && typeof spec.toolCall.callId !== 'string') {
        throw new Error('background job toolCall.callId must be a string')
      }
      counter += 1
      const id = `cad-${String(counter).padStart(4, '0')}deadbeef`
      const record = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        toolCall: spec.toolCall,
        status: 'running',
        detail: undefined,
        progress: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        chunks: [],
        total: 0,
        modelCursor: 0,
        result: undefined,
        resultDelivered: false,
        hooks: null,
      }
      const handle = {
        id,
        append(text) {
          if (typeof text !== 'string' || text === '') return
          record.chunks.push({ at: record.total, text })
          record.total += Buffer.byteLength(text)
        },
        updateProgress(line) {
          record.progress = String(line)
        },
      }
      const hooks = spec.run(handle)
      record.hooks = hooks
      jobs.set(id, record)
      void hooks.done.then(outcome => {
        record.status = outcome.status
        record.detail = outcome.detail
        record.result = outcome.result
        record.progress = undefined
        record.finishedAt = Date.now()
      })
      return id
    },
    get(id, caller) {
      return view(expect(id, caller))
    },
    read(id, caller) {
      const record = expect(id, caller)
      const chunks = record.chunks
        .filter(chunk => chunk.at + Buffer.byteLength(chunk.text) > record.modelCursor)
        .map(chunk => ({ ...chunk }))
      record.modelCursor = record.total
      const deliver = isTerminal(record.status) && !record.resultDelivered && record.result !== undefined
      if (deliver) record.resultDelivered = true
      return {
        chunks,
        lossy: false,
        ...(deliver ? { result: record.result } : {}),
        job: view(record),
      }
    },
    list(caller) {
      return [...jobs.values()]
        .filter(record => record.owner === undefined || record.owner === caller)
        .map(view)
    },
    kill(id, caller, reason) {
      const record = expect(id, caller)
      if (isTerminal(record.status)) return 'already-finished'
      record.status = 'stopping'
      record.hooks.cancel(reason)
      return 'requested'
    },
    async waitFor(id, caller, timeoutMs = 5000) {
      const record = expect(id, caller)
      await Promise.race([
        record.hooks.done,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ])
      return view(record)
    },
  }
  return registry
}

/** Wait for a condition with a bounded poll (tests only; never in plugin code). */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
