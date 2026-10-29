#!/usr/bin/env node
/**
 * Scripted fake CAD runtime for host unit tests.
 *
 * It speaks the exact newline-delimited JSON-RPC 2.0 seam documented in
 * docs/CAD_RUNTIME_PROTOCOL.md, so host tests exercise the real supervisor
 * (spawn, framing, timeouts, cancellation, crash recovery, teardown) without
 * requiring Python or build123d. Behaviour is selected per process with env
 * vars so one fixture covers every scenario:
 *
 *   FAKE_RUNTIME_MODE        ok | geometry-fail | error-invalid-document |
 *                            crash-on-build | slow | bad-sha | missing-artifact |
 *                            no-shutdown-reply
 *   FAKE_RUNTIME_DELAY_MS    reply delay for model.build/validate (default 0)
 *   FAKE_RUNTIME_CRASH_ONCE  path to a flag file: first start exits during
 *                            hello, later starts work normally
 *   FAKE_RUNTIME_HANG_HELLO  "1" = never answer hello
 *   FAKE_RUNTIME_BAD_VERSION "9.9" = answer hello with a mismatched version
 *   FAKE_RUNTIME_STDERR      extra text written to stderr on startup
 *
 * Artifacts are written with real bytes and truthful sha256/bytes so the host's
 * artifact verification is genuinely exercised.
 */

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const MODE = process.env.FAKE_RUNTIME_MODE ?? 'ok'
const DELAY_MS = Number(process.env.FAKE_RUNTIME_DELAY_MS ?? '0')
const BAD_VERSION = process.env.FAKE_RUNTIME_BAD_VERSION ?? ''
const HANG_HELLO = process.env.FAKE_RUNTIME_HANG_HELLO === '1'
const CRASH_ONCE = process.env.FAKE_RUNTIME_CRASH_ONCE ?? ''
const STDERR_TEXT = process.env.FAKE_RUNTIME_STDERR ?? ''
const IGNORE_CANCEL = process.env.FAKE_RUNTIME_IGNORE_CANCEL === '1'

const startedAt = Date.now()
let shutdownRequested = false
/** requestId → was cancellation requested */
const cancelled = new Map()
/** requestId → { id, reply } of an in-flight, still-delayed build */
const pendingBuilds = new Map()
let exiting = false

if (STDERR_TEXT !== '') process.stderr.write(`${STDERR_TEXT}\n`)

// Crash once: the first process that claims the flag file dies during hello.
if (CRASH_ONCE !== '') {
  if (!existsSync(CRASH_ONCE)) {
    writeFileSync(CRASH_ONCE, String(process.pid))
    process.stderr.write('fake-runtime: crashing on purpose (crash-once)\n')
    process.exit(7)
  }
}

/** Write one frame to stdout. */
function send(frame) {
  if (exiting) return
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

/** Send an application error frame. */
function sendError(id, code, message, details) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { code, message, details } } })
}

/** sha256 hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Numeric parameter of the built document, with a fallback. */
function param(params, name, fallback) {
  const document = params && typeof params.document === 'object' ? params.document : null
  const parameters = document && typeof document.parameters === 'object' ? document.parameters : null
  const value = parameters ? parameters[name] : undefined
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Default geometry report of the acceptance bracket (dimensions follow the document). */
function bracketReport(params = {}) {
  const length = param(params, 'length', 80)
  const width = param(params, 'width', 60)
  const thickness = param(params, 'thickness', 8)
  return {
    volume: Number((length * width * thickness - 3.1).toFixed(2)),
    surfaceArea: Number((2 * (length * width + length * thickness + width * thickness)).toFixed(2)),
    boundingBox: {
      min: [-length / 2, -width / 2, -thickness / 2],
      max: [length / 2, width / 2, thickness / 2],
      size: [length, width, thickness],
    },
    centroid: [0, 0, 0],
    topology: { faces: 17, edges: 45, vertices: 30, solids: 1 },
    checks: [
      { id: 'document_schema', status: 'pass', message: 'document accepted' },
      { id: 'single_solid', status: 'pass', message: 'exactly one solid' },
      { id: 'brep_valid', status: 'pass', message: 'B-rep is valid' },
      { id: 'positive_volume', status: 'pass', message: 'volume > 0' },
      { id: 'closed_shell', status: 'pass', message: 'mesh is watertight' },
      { id: 'bounding_box', status: 'pass', message: 'within maxBoundingBoxMm' },
      { id: 'feature_effects', status: 'pass', message: 'all subtractive features took effect' },
      { id: 'wall_thickness', status: 'warn', message: 'closest wall 3.0 mm' },
    ],
    featureReports: [
      { id: 'base', op: 'box', status: 'pass', detail: 'material added' },
      { id: 'center_hole', op: 'hole', status: 'pass', detail: 'Ø20 through hole' },
      { id: 'corner_holes', op: 'hole_pattern', status: 'pass', detail: '4 × Ø6 holes' },
    ],
    warnings: ['wall thickness check is heuristic'],
    timings: { totalMs: 42, buildMs: 30, exportMs: 12 },
  }
}

/** Write one declared artifact and return its declaration. */
function writeArtifact(outputDir, format, fileName, contentType, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  writeFileSync(join(outputDir, fileName), bytes)
  return { format, fileName, bytes: bytes.length, sha256: sha256(bytes), contentType }
}

/** Produce the requested formats into outputDir. */
function produceArtifacts(params) {
  const outputDir = typeof params.outputDir === 'string' ? params.outputDir : ''
  const formats = Array.isArray(params.formats) ? params.formats : []
  const artifacts = []
  for (const format of formats) {
    if (format === 'step') {
      artifacts.push(writeArtifact(outputDir, 'step', 'model.step', 'application/step', 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'))
    } else if (format === 'glb') {
      const header = Buffer.alloc(12)
      header.write('glTF', 0, 'ascii')
      header.writeUInt32LE(2, 4)
      header.writeUInt32LE(28, 8)
      const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'fake-runtime' }, meshes: [] }))
      const chunk = Buffer.alloc(8)
      chunk.writeUInt32LE(json.length, 0)
      chunk.write('JSON', 4, 'ascii')
      artifacts.push(writeArtifact(outputDir, 'glb', 'model.glb', 'model/gltf-binary', Buffer.concat([header, chunk, json])))
    } else if (format === 'stl') {
      artifacts.push(writeArtifact(outputDir, 'stl', 'model.stl', 'model/stl', 'solid fake\nendsolid fake\n'))
    } else if (format === 'svg') {
      const view = params.preview && typeof params.preview.view === 'string' ? params.preview.view : 'iso'
      const width = params.preview && Number.isFinite(params.preview.width) ? params.preview.width : 1200
      const height = params.preview && Number.isFinite(params.preview.height) ? params.preview.height : 900
      artifacts.push(writeArtifact(outputDir, 'svg', 'preview.svg', 'image/svg+xml',
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 80 60" data-view="${view}"><rect x="1" y="1" width="78" height="58" fill="none" stroke="#111"/><circle cx="40" cy="30" r="10" fill="none" stroke="#111"/></svg>`))
    }
  }
  return artifacts
}

/** Simulate a geometry failure report. */
function failingReport(params = {}) {
  const report = bracketReport(params)
  report.checks = report.checks.map(check => (check.id === 'brep_valid'
    ? { id: 'brep_valid', status: 'fail', message: 'B-rep self-intersection at face 12' }
    : check))
  report.featureReports = [
    { id: 'base', op: 'box', status: 'pass', detail: 'material added' },
    { id: 'center_hole', op: 'hole', status: 'fail', detail: 'hole silently absorbed' },
  ]
  return report
}

/** Validate shape of one build request. */
function validateBuildParams(params) {
  if (typeof params.outputDir !== 'string' || !params.outputDir.startsWith('/')) {
    return { path: '/outputDir', message: 'outputDir must be an absolute path' }
  }
  if (!Array.isArray(params.formats) || params.formats.length === 0) {
    return { path: '/formats', message: 'formats must be a non-empty array' }
  }
  for (const format of params.formats) {
    if (!['step', 'glb', 'stl', 'svg'].includes(format)) return { path: '/formats', message: `unknown format ${format}` }
  }
  if (params.document === null || typeof params.document !== 'object') {
    return { path: '/document', message: 'document must be an object' }
  }
  return null
}

/** Handle model.build (delayed + cancellable). */
function handleBuild(id, params) {
  const requestId = typeof params.requestId === 'string' ? params.requestId : String(id)
  cancelled.set(requestId, false)
  const bad = validateBuildParams(params)
  if (bad !== null) {
    sendError(id, 'invalid_argument', `invalid build parameters: ${bad.message}`, bad)
    return
  }
  const finish = () => {
    pendingBuilds.delete(requestId)
    if (shutdownRequested) return
    if (cancelled.get(requestId) === true) {
      send({
        jsonrpc: '2.0', id, result: {
          ok: true, buildId: 'b-cancelled', status: 'failed', report: null, artifacts: [],
          error: { code: 'cancelled', message: 'the build was cancelled', details: {} },
        },
      })
      return
    }
    if (MODE === 'crash-on-build') {
      process.stderr.write('fake-runtime: crashing during build\n')
      process.exit(9)
      return
    }
    shiftPercent(requestId, 40, 'building', 'extruding base')
    if (MODE === 'geometry-fail') {
      const report = failingReport(params)
      send({
        jsonrpc: '2.0', id, result: {
          ok: true, buildId: 'b-fail', status: 'failed', report,
          artifacts: [],
          error: { code: 'invalid_geometry', message: 'B-rep failed validation', details: { checks: report.checks.filter(check => check.status === 'fail') } },
        },
      })
      return
    }
    shiftPercent(requestId, 90, 'exporting', 'writing artifacts')
    let artifacts
    try {
      artifacts = produceArtifacts(params)
    } catch (error) {
      send({
        jsonrpc: '2.0', id, result: {
          ok: true, buildId: 'b-export-failed', status: 'failed', report: bracketReport(), artifacts: [],
          error: { code: 'export_failed', message: `could not write artifacts: ${String(error)}`, details: {} },
        },
      })
      return
    }
    if (MODE === 'bad-sha' && artifacts.length > 0) artifacts[0].sha256 = 'f'.repeat(64)
    if (MODE === 'missing-artifact') artifacts.push({ format: 'stl', fileName: 'model.stl', bytes: 10, sha256: 'a'.repeat(64), contentType: 'model/stl' })
    send({
      jsonrpc: '2.0', id, result: {
        ok: true, buildId: 'b-ok', status: 'built', report: bracketReport(params), artifacts, error: null,
      },
    })
  }
  if (DELAY_MS > 0 || MODE === 'slow') {
    shiftPercent(requestId, 1, 'validating', 'preparing document')
    let timer = null
    const reply = () => {
      if (timer !== null) clearTimeout(timer)
      finish()
    }
    pendingBuilds.set(requestId, { id, reply })
    timer = setTimeout(finish, DELAY_MS > 0 ? DELAY_MS : 30_000)
    return
  }
  finish()
}

/** Send one progress notification. */
function shiftPercent(requestId, percent, phase, message) {
  send({ jsonrpc: '2.0', method: 'build.progress', params: { requestId, phase, percent, message } })
}

/** Handle one request frame. */
function handleRequest(id, method, params) {
  if (method === 'runtime.hello') {
    if (HANG_HELLO) return
    if (BAD_VERSION !== '') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'protocol mismatch', data: { code: 'protocol_version_mismatch', message: 'expected 1.0', details: { expected: '1.0', received: BAD_VERSION } } } })
      return
    }
    send({
      jsonrpc: '2.0', id, result: {
        protocolVersion: '1.0',
        runtime: { name: 'fake-cad-runtime', version: '0.0.0', python: '3.12.13', build123d: '0.13.0', ocp: '8.0.1' },
        capabilities: { formats: ['step', 'glb', 'stl', 'svg'], checks: ['document_schema', 'single_solid', 'brep_valid'], previewViews: ['iso', 'front', 'top', 'right'] },
        ready: true,
      },
    })
    return
  }
  if (method === 'runtime.health') {
    send({ jsonrpc: '2.0', id, result: { ok: true, pid: process.pid, uptimeMs: Date.now() - startedAt, protocolVersion: '1.0', busy: false, jobs: 0, ready: true, warmup: false } })
    return
  }
  if (method === 'runtime.shutdown') {
    if (MODE === 'no-shutdown-reply') return
    send({ jsonrpc: '2.0', id, result: { ok: true } })
    shutdownRequested = true
    exiting = true
    setTimeout(() => process.exit(0), 10)
    return
  }
  if (method === 'model.build') {
    handleBuild(id, params)
    return
  }
  if (method === 'model.validate') {
    const run = () => {
      if (MODE === 'geometry-fail') {
        const report = failingReport()
        send({ jsonrpc: '2.0', id, result: { ok: true, valid: false, checks: report.checks, report } })
        return
      }
      const report = bracketReport(params)
      send({ jsonrpc: '2.0', id, result: { ok: true, valid: true, checks: report.checks, report } })
    }
    if (DELAY_MS > 0) setTimeout(run, DELAY_MS)
    else run()
    return
  }
  if (method === 'job.cancel') {
    const requestId = typeof params.requestId === 'string' ? params.requestId : ''
    const known = cancelled.has(requestId)
    if (known) cancelled.set(requestId, true)
    send({ jsonrpc: '2.0', id, result: { ok: true, cancelled: known } })
    // A cooperative runtime aborts promptly; FAKE_RUNTIME_IGNORE_CANCEL=1
    // models one that does not, so the host's kill+respawn backstop is tested.
    const pending = pendingBuilds.get(requestId)
    if (pending !== undefined && !IGNORE_CANCEL) {
      pendingBuilds.delete(requestId)
      pending.reply()
      if (cancelled.get(requestId) === true) {
        // The reply above already recorded the cancellation; finish() sends it.
      }
    }
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}`, data: { code: 'protocol_error', message: `unknown method ${method}` } } })
}

// Newline-delimited JSON-RPC over stdin.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  const text = line.trim()
  if (text === '') return
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error', data: { code: 'protocol_error', message: 'parse error' } } })
    return
  }
  if (frame === null || typeof frame !== 'object') return
  const { id, method, params } = frame
  if (typeof method !== 'string') return
  // Notifications carry no id and get no reply.
  if (id === undefined || id === null) return
  handleRequest(id, method, params && typeof params === 'object' ? params : {})
})

// EOF (the host closed stdin) or a signal means "exit cleanly".
lines.on('close', () => {
  exiting = true
  setTimeout(() => process.exit(0), 5)
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    exiting = true
    process.exit(0)
  })
}
process.on('uncaughtException', error => {
  process.stderr.write(`fake-runtime: uncaught ${String(error)}\n`)
})
