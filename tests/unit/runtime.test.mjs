import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { CadError } from '../../src/host/contracts.ts'
import { delay } from './runtime-helpers.mjs'
import { FAKE_RUNTIME, FIXTURES_DIR, PLUGIN_ROOT, fakeRuntime, removeDir, tempDir, testConfig, waitFor } from './helpers.mjs'
import { CadRuntime } from '../../src/host/runtime.ts'

/** True while a pid exists. */
function isAlive(pid) {
  if (pid === null || pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A build request for the fake runtime. */
function buildParams(outputDir, overrides = {}) {
  return {
    requestId: `rq-test-${Math.random().toString(16).slice(2)}`,
    model: { id: 'm-0000000001', revisionId: 'r-0001' },
    document: { schema: 'dsh.cad/document@1', units: 'mm', parameters: {}, features: [{ id: 'base', op: 'box', length: 1, width: 1, height: 1 }] },
    outputDir,
    formats: ['step', 'glb'],
    checks: null,
    limits: { maxBoundingBoxMm: 2000, maxArtifactBytes: 1e6, maxFeatures: 64, maxParameters: 64 },
    preview: null,
    ...overrides,
  }
}

test('starts lazily, completes the hello handshake and reports status', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config)
  try {
    assert.equal(runtime.isReady, false, 'no child before first use')
    await runtime.ensureStarted()
    assert.equal(runtime.isReady, true)
    const status = runtime.status()
    assert.equal(status.available, true)
    assert.equal(status.state, 'ready')
    assert.ok(status.pid > 0)
    assert.equal(status.protocolVersion, '1.0')
    assert.equal(status.executable, process.execPath)
    const health = await runtime.health()
    assert.equal(health.ok, true)
    assert.equal(health.health.protocolVersion, '1.0')
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('brackets artifacts are declared and progress notifications are delivered', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config)
  try {
    const outputDir = join(dataDir, 'revisions', 'r-0001')
    await mkdir(outputDir, { recursive: true })
    const progress = []
    const result = await runtime.build(buildParams(outputDir), { onProgress: line => progress.push(line) })
    assert.equal(result.status, 'built')
    assert.equal(result.error, null)
    assert.equal(result.report.valid, true)
    assert.deepEqual(result.report.bbox.size, [80, 60, 8])
    assert.equal(result.artifacts.length, 2)
    assert.ok(existsSync(join(outputDir, 'model.step')))
    assert.ok(existsSync(join(outputDir, 'model.glb')))
    assert.ok(progress.length >= 2, `expected progress lines, got ${JSON.stringify(progress)}`)
    assert.ok(progress.some(line => line.includes('building')))
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('a geometry failure is a normal failed result, not a transport error', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config, { mode: 'geometry-fail' })
  try {
    const outputDir = join(dataDir, 'rev')
    const result = await runtime.build(buildParams(outputDir))
    assert.equal(result.status, 'failed')
    assert.equal(result.error.code, 'invalid_geometry')
    assert.equal(result.artifacts.length, 0)
    assert.ok(result.report.checks.some(check => check.id === 'brep_valid' && check.status === 'fail'))
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('a protocol version mismatch refuses the runtime with structured details', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config, { env: { FAKE_RUNTIME_BAD_VERSION: '9.9' } })
  try {
    let thrown = null
    try {
      await runtime.ensureStarted()
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError, `expected CadError, got ${String(thrown)}`)
    assert.equal(thrown.code, 'runtime_unavailable')
    assert.equal(thrown.details.expected, '1.0')
    assert.equal(thrown.details.received, '9.9')
    assert.equal(runtime.pid, null, 'a mismatched runtime must not be left running')
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('a hanging handshake times out and kills the child', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir, overrides: { runtimeStartTimeoutMs: 10_000 } })
  const runtime = fakeRuntime(config, { env: { FAKE_RUNTIME_HANG_HELLO: '1' } })
  const pid = { value: null }
  try {
    const started = Date.now()
    let thrown = null
    try {
      await runtime.ensureStarted()
    } catch (error) {
      thrown = error
    }
    pid.value = runtime.pid
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'timeout')
    assert.ok(Date.now() - started < 16_000, 'handshake timeout must be bounded')
    await waitFor(() => runtime.pid === null, { label: 'child cleanup', timeoutMs: 4_000 })
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('a crashed start is recovered on the next attempt (bounded restart)', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const flag = join(dataDir, 'crash-once.flag')
  const runtime = fakeRuntime(config, { env: { FAKE_RUNTIME_CRASH_ONCE: flag } })
  try {
    await mkdir(join(dataDir, 'rev'), { recursive: true })
    let firstError = null
    try {
      await runtime.ensureStarted()
    } catch (error) {
      firstError = error
    }
    assert.ok(firstError instanceof CadError, 'the first start must fail')
    assert.equal(runtime.isReady, false)
    // The supervisor arms a short backoff; keep retrying until it restarts.
    await waitFor(async () => {
      try {
        await runtime.ensureStarted()
        return true
      } catch {
        return false
      }
    }, { label: 'runtime restart', timeoutMs: 8_000 })
    assert.equal(runtime.isReady, true)
    assert.ok(runtime.status().restarts >= 1)
    const outputDir = join(dataDir, 'rev')
    const result = await runtime.build(buildParams(outputDir))
    assert.equal(result.status, 'built')
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('a build that overruns buildTimeoutMs is a structured timeout and the runtime is restarted', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir, overrides: { buildTimeoutMs: 800 } })
  const runtime = fakeRuntime(config, { mode: 'slow' })
  try {
    const firstPid = (await runtime.ensureStarted(), runtime.pid)
    assert.ok(firstPid > 0)
    const started = Date.now()
    let thrown = null
    try {
      await runtime.build(buildParams(join(dataDir, 'rev')))
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'timeout')
    assert.ok(Date.now() - started < 10_000)
    await waitFor(() => !isAlive(firstPid), { label: 'timed-out child to die', timeoutMs: 5_000 })
    assert.equal(runtime.isReady, false, 'the runtime stays down until the next call')
        // A subsequent call respawns a fresh process (kill+respawn semantics).
    await waitFor(async () => {
      try {
        await runtime.ensureStarted()
        return true
      } catch {
        return false
      }
    }, { label: 'respawn', timeoutMs: 8_000 })
    assert.ok(runtime.pid > 0)
    assert.notEqual(runtime.pid, firstPid)
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('caller cancellation forwards job.cancel and settles as cancelled', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config, { mode: 'slow' })
  try {
    await runtime.ensureStarted()
    const pidBefore = runtime.pid
    const controller = new AbortController()
    const started = Date.now()
    const pending = runtime.build(buildParams(join(dataDir, 'rev')), { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('test cancellation')), 100)
    let thrown = null
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError, `expected CadError, got ${String(thrown)}`)
    assert.equal(thrown.code, 'cancelled')
    assert.ok(Date.now() - started < 4_000, 'cooperative cancellation must be quick')
    // Cooperative cancel keeps the warm process alive (no kill+respawn needed).
    assert.equal(runtime.pid, pidBefore)
    assert.equal(runtime.isReady, true)
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('an unacknowledged cancellation kills and respawns the runtime', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config, { mode: 'slow', env: { FAKE_RUNTIME_IGNORE_CANCEL: '1' } })
  try {
    await runtime.ensureStarted()
    const pidBefore = runtime.pid
    await mkdir(join(dataDir, 'rev'), { recursive: true })
    const controller = new AbortController()
    const pending = runtime.build(buildParams(join(dataDir, 'rev')), { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    let thrown = null
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof CadError)
    assert.equal(thrown.code, 'cancelled')
    await waitFor(() => !isAlive(pidBefore), { label: 'ignored-cancel child to die', timeoutMs: 6_000 })
    await waitFor(async () => {
      try {
        await runtime.ensureStarted()
        return true
      } catch {
        return false
      }
    }, { label: 'respawn after kill', timeoutMs: 8_000 })
    assert.notEqual(runtime.pid, pidBefore)
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('validates through model.validate and parses checks', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config)
  try {
    const result = await runtime.validateModel({ document: { features: [{ id: 'b', op: 'box', length: 1, width: 1, height: 1 }] }, checks: null })
    assert.equal(result.valid, true)
    assert.ok(result.checks.length > 0)
    assert.ok(result.report.valid)
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('stderr diagnostics are kept in a bounded ring', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config, { env: { FAKE_RUNTIME_STDERR: 'fake boot diagnostic line' } })
  try {
    await runtime.ensureStarted()
    await waitFor(() => runtime.status().stderrTail.some(line => line.includes('fake boot diagnostic line')), { label: 'stderr ring' })
    assert.ok(runtime.diagnostics().stderrLines.length >= 1)
  } finally {
    await runtime.dispose()
    await removeDir(dataDir)
  }
})

test('disposal kills the child process, leaves no orphan, and is idempotent', async () => {
  const dataDir = await tempDir()
  const config = testConfig({ dataDir })
  const runtime = fakeRuntime(config)
  await runtime.ensureStarted()
  const pid = runtime.pid
  assert.ok(pid > 0)
  await runtime.dispose()
  await waitFor(() => !isAlive(pid), { label: 'child process teardown', timeoutMs: 6_000 })
  assert.equal(runtime.isReady, false)
  assert.equal(runtime.pid, null)
  await runtime.dispose()
  await removeDir(dataDir)
})

test('the child exits when the harness process is SIGKILLed (no orphan after crash)', async () => {
  // A parent that spawns the runtime with piped stdio and then SIGKILLs itself:
  // the kernel closes the pipe, the runtime sees stdin EOF and exits. This is
  // the orphan-prevention path for a harness process that dies without hooks.
  const parentScript = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, [${JSON.stringify(FAKE_RUNTIME)}], {
      cwd: ${JSON.stringify(FIXTURES_DIR)},
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    })
    process.stdout.write('CHILD_PID=' + child.pid + '\\n')
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300)
    setInterval(() => {}, 1000)
  `
  const parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'inherit'] })
  const childPidText = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('parent did not report a child pid')), 5_000)
    parent.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const match = buffer.match(/CHILD_PID=(\d+)/u)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    parent.once('error', reject)
  })
  const orphanPid = Number(childPidText)
  assert.ok(orphanPid > 0)
  await waitFor(() => !isAlive(orphanPid), { label: 'runtime child to exit after parent SIGKILL', timeoutMs: 10_000 })
  assert.equal(isAlive(orphanPid), false, `orphan runtime ${orphanPid} survived its parent`)
})

test('the runtime exits on stdin EOF even without a shutdown frame', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [FAKE_RUNTIME], { cwd: FIXTURES_DIR, stdio: ['pipe', 'pipe', 'ignore'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  await delay(100)
  child.stdin.end()
  const code = await Promise.race([exited, delay(5_000).then(() => 'timeout')])
  assert.notEqual(code, 'timeout', 'the runtime must exit when stdin closes')
})

test('the plugin root used by resolution exists and the fake runtime path is inside it', () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, 'package.json')))
  assert.ok(existsSync(FAKE_RUNTIME))
})
