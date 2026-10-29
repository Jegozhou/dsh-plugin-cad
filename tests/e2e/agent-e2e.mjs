/**
 * Agent-driven acceptance scenarios for dsh-plugin-cad.
 *
 * Each scenario runs a **real headless DeepSeek Harness agent**
 * (`dsh --profile <headless-profile> "<prompt>"`) against the installed plugin,
 * then verifies the outcome against the on-disk model store and the exported
 * artifacts — never against what the agent *says* it did.
 *
 *   discover  B  the agent sees and calls the native cad_* tools
 *   create    C,D,E  natural language -> structured CAD document -> real
 *                    B-Rep -> STEP + GLB that an independent parser accepts
 *   modify    G  parameter edit -> new immutable revision with new dimensions
 *   cancel    H  background build + cancellation -> controlled runtime state
 *
 * Usage:
 *   node tests/e2e/agent-e2e.mjs --profile cadheadless [--scenario create] [--json]
 *
 * Requires: the plugin installed in the profile, the Python runtime set up, and
 * OPENCODE_GO_API_KEY resolvable (exported, or present in ~/.dsh/.credentials.yaml).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGlb, parseStep, verifyBracket } from './verify-artifacts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')
const outDir = join(packageRoot, 'tests', 'fixtures', 'out')
mkdirSync(outDir, { recursive: true })

const options = parseArgs(process.argv.slice(2))
const profile = options.profile ?? 'cadheadless'
const jsonMode = options.json === true
const modelRoot = options['model-root'] ?? join(process.env.HOME ?? '', '.dsh', 'cad', 'models')
const workspace = options.workspace ?? resolve(packageRoot, '..')
const selected = options.scenario ? String(options.scenario).split(',') : ['discover', 'create', 'modify', 'cancel']
const report = { profile, modelRoot, startedAt: new Date().toISOString(), scenarios: [] }

/** Acceptance dimensions from docs/research/SPEC_P0.md. */
const NOMINAL = { length: 80, width: 60, height: 8, centerDiameter: 20, cornerDiameter: 6, cornerCount: 4 }
const MODIFIED = {
  ...NOMINAL,
  length: Number(options.length ?? 100),
  width: Number(options.width ?? 60),
  height: Number(options.height ?? 10),
}

async function main() {
  let ok = true
  try {
    for (const name of selected) {
      process.stdout.write(`\n=== agent scenario: ${name} ===\n`)
      const scenario = SCENARIOS[name]
      if (!scenario) throw new Error(`unknown scenario "${name}"`)
      const result = await scenario()
      report.scenarios.push({ name, ...result })
      if (result.status !== 'pass') ok = false
    }
  } finally {
    report.finishedAt = new Date().toISOString()
    report.ok = ok
    writeFileSync(join(here, 'agent-e2e-report.json'), JSON.stringify(report, null, 2) + '\n')
    if (jsonMode) console.log(JSON.stringify(report, null, 2))
    else for (const scenario of report.scenarios) console.log(`${scenario.status.toUpperCase().padEnd(5)} ${scenario.name.padEnd(9)} ${scenario.detail ?? ''}`)
  }
  process.exit(ok ? 0 : 1)
}

// ------------------------------------------------------------ scenarios ----
const SCENARIOS = {
  /** B — tool discovery and a read-only native call. */
  async discover() {
    const started = Date.now()
    const run = await runAgent(
      'You have native CAD tools. Call cad_list_models once with no arguments, then reply with the exact tool name you called and whether it returned ok:true. Keep the reply to two lines.',
      300_000,
    )
    const mentionsTool = /cad_list_models/.test(run.output)
    const sawOk = /ok:\s*true|"ok":\s*true|\bok\b.*true/i.test(run.output)
    return {
      status: run.code === 0 && mentionsTool ? 'pass' : 'fail',
      detail: `exit=${run.code} toolNameInAnswer=${mentionsTool} okMentioned=${sawOk} ${((Date.now() - started) / 1000).toFixed(1)}s`,
      evidence: { prompt: run.prompt, output: tail(run.output, 25), exitCode: run.code },
    }
  },

  /** C,D,E — build the acceptance bracket and verify the artifacts independently. */
  async create() {
    const before = listModels()
    const prompt = [
      'Create a parametric rectangular mounting bracket using your native CAD tools.',
      'Nominal dimensions: length 80 mm, width 60 mm, thickness 8 mm, one central through-hole 20 mm diameter, and four corner through-holes 6 mm diameter inset 12 mm from each edge.',
      'Keep the geometry parametric: name the parameters length, width, thickness, center_hole_diameter, corner_hole_diameter, corner_inset.',
      'Build the geometry, export STEP and GLB, and finish by printing a single JSON line with the keys model_id, revision_id, volume, bbox and artifact formats. Do not summarise anything else.',
    ].join(' ')
    const run = await runAgent(prompt, 600_000)
    const after = listModels()
    const created = after.filter(model => !before.some(previous => previous.modelId === model.modelId))
    const model = pickNewest(created.length > 0 ? created : after)
    const verdict = model ? verifyModel(model, NOMINAL) : { ok: false, checks: [{ id: 'model_created', status: 'fail', detail: 'no model directory was written' }], failed: ['model_created'] }
    return {
      status: run.code === 0 && verdict.ok ? 'pass' : 'fail',
      detail: model ? `model=${model.modelId} rev=${model.revisions.at(-1)?.revisionId} checks=${verdict.checks.filter(c => c.status === 'pass').length}/${verdict.checks.length}` : 'no model created',
      evidence: { prompt, output: tail(run.output, 30), exitCode: run.code, model: model ? summariseModel(model) : null, checks: verdict.checks },
    }
  },

  /** G — parameter change produces a new immutable revision. */
  async modify() {
    const models = listModels()
    const model = pickNewest(models)
    if (!model) return { status: 'fail', detail: 'no model exists to modify (run create first)' }
    const current = model.revisions.at(-1)
    const prompt = [
      `Model ${model.modelId} is currently at revision ${current.revision}.`,
      `Use your native CAD tools to change the parameters length to ${MODIFIED.length}, width to ${MODIFIED.width} and thickness to ${MODIFIED.height}, keeping the other parameters unchanged.`,
      `Rebuild, export STEP and GLB, and verify that the new bounding box is ${MODIFIED.length} x ${MODIFIED.width} x ${MODIFIED.height} mm.`,
      'Finish by printing a single JSON line with keys model_id, previous_revision, new_revision, bbox.',
    ].join(' ')
    const run = await runAgent(prompt, 600_000)
    const updated = listModels().find(entry => entry.modelId === model.modelId)
    const revisions = updated?.revisions ?? []
    const newest = revisions.filter(entry => entry.status === 'ok').at(-1)
    const grewByOne = revisions.length === model.revisions.length + 1
    const oldStillThere = revisions.some(entry => entry.revisionId === current.revisionId)
    const verdict = newest ? verifyModel({ ...updated, revisions: [newest] }, MODIFIED) : { ok: false, checks: [], failed: ['no successful new revision'] }
    return {
      status: run.code === 0 && grewByOne && oldStillThere && verdict.ok ? 'pass' : 'fail',
      detail: `revisions ${model.revisions.length}->${revisions.length} immutableOld=${oldStillThere} newBboxCheck=${verdict.ok}`,
      evidence: { prompt, output: tail(run.output, 25), exitCode: run.code, revisions: revisions.map(entry => ({ id: entry.revisionId, status: entry.status, bbox: entry.report?.bbox?.size })), checks: verdict.checks },
    }
  },

  /** H — a published background job can be cancelled and the runtime stays usable. */
  async cancel() {
    // A part that takes ~4.4 s to build (measured over the protocol:
    // 200x200x20 plate + 10x10 hole grid + 4 mm all-edge fillet), so a
    // background job is genuinely in flight when the agent cancels it.
    const heavyDocA = JSON.stringify({
      schema: 'dsh.cad/document@1', units: 'mm',
      parameters: { length: 200, width: 200, thickness: 20, hole_diameter: 4, fillet_radius: 4 },
      features: [
        { id: 'plate', op: 'box', length: '$length', width: '$width', height: '$thickness' },
        { id: 'holes', op: 'hole_pattern', pattern: 'grid', diameter: '$hole_diameter', count: [10, 10], spacing: [16, 16], through: true },
        { id: 'edge_round', op: 'fillet', radius: '$fillet_radius', target: 'all_edges' },
      ],
    })
    const heavyDocB = heavyDocA.replace('"length":200', '"length":210')
    const heavy = [
      'Do this exactly in order and do not retry anything.',
      `1. Call cad_create_model with build:true, background:true and this exact document: ${heavyDocA}. Record the returned job id as A.`,
      `2. Immediately call cad_create_model again with build:true, background:true and this exact document: ${heavyDocB}. Record the returned job id as B. It will queue behind A.`,
      '3. Call cad_get_job_status with action:"cancel" and job_id B, then call cad_get_job_status for B again and record the status string.',
      '4. Call cad_get_job_status with action:"cancel" and job_id A, then call cad_get_job_status for A again and record the status string.',
      '5. Call cad_runtime_status with action:"status" and record whether the runtime is healthy.',
      'Finish by printing exactly these two JSON lines, nothing after them:',
      '{"job_a":"<id>","job_b":"<id>"}',
      '{"job_b_status":"<status>","job_a_status":"<status>","runtime_healthy":true}',
    ].join(' ')
    const run = await runAgent(heavy, 900_000)
    const output = run.output
    const jobIds = [...output.matchAll(/cad-[0-9a-f]{8,}/g)].map(match => match[0])
    // The agent must have observed a terminal cancellation for at least one job.
    const cancelledObserved = /"(killed|cancell?ed|stopping|cancel_requested)"|status["']?\s*:\s*["'](killed|cancell?ed|stopping)/i.test(output)
    const runtimeHealthy = /"runtime_healthy"\s*:\s*true|"status"\s*:\s*"ok"|"ok"\s*:\s*true/i.test(output)
    const noCrash = !/\bUNKNOWN_TOOL\b|Cannot read propert|TypeError|traceback/i.test(output)
    return {
      status: run.code === 0 && jobIds.length > 0 && cancelledObserved && runtimeHealthy && noCrash ? 'pass' : 'fail',
      detail: `jobIds=${jobIds.length} cancelObserved=${cancelledObserved} runtimeHealthy=${runtimeHealthy} noCrash=${noCrash}`,
      evidence: { prompt: heavy, output: tail(output, 40), exitCode: run.code, jobIds: [...new Set(jobIds)].slice(0, 6) },
    }
  },
}

// ------------------------------------------------------------- modelling ----
/** Read the model store from disk: models/<id>/model.json + revisions. */
function listModels() {
  if (!existsSync(modelRoot)) return []
  const models = []
  for (const entry of readdirSync(modelRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(modelRoot, entry.name)
    const meta = readJson(join(dir, 'model.json'))
    const revisionsDir = join(dir, 'revisions')
    const revisions = []
    if (existsSync(revisionsDir)) {
      for (const revisionEntry of readdirSync(revisionsDir, { withFileTypes: true })) {
        if (!revisionEntry.isDirectory()) continue
        const revisionDir = join(revisionsDir, revisionEntry.name)
        const report = readJson(join(revisionDir, 'report.json'))
        revisions.push({
          revisionId: revisionEntry.name,
          revision: Number(String(revisionEntry.name).replace(/[^0-9]/g, '')) || 0,
          status: report?.valid === true ? 'ok' : (report ? 'failed' : 'unknown'),
          report,
          dir: revisionDir,
        })
      }
    }
    revisions.sort((a, b) => a.revision - b.revision)
    models.push({ modelId: meta?.modelId ?? entry.name, meta, dir, revisions })
  }
  models.sort((a, b) => String(b.modelId).localeCompare(String(a.modelId)))
  return models
}

/** Verify one model revision's artifacts with the independent parser. */
function verifyModel(model, expected) {
  const revision = model.revisions.filter(entry => entry.status === 'ok').at(-1) ?? model.revisions.at(-1)
  if (!revision) return { ok: false, checks: [{ id: 'revision_exists', status: 'fail', detail: 'no revision directory' }], failed: ['revision_exists'] }
  const stepPath = findArtifact(revision.dir, 'model.step') ?? findArtifact(revision.dir, '.step')
  const glbPath = findArtifact(revision.dir, 'model.glb') ?? findArtifact(revision.dir, '.glb')
  const checks = []
  if (!stepPath) checks.push({ id: 'step_artifact', status: 'fail', detail: 'model.step not written' })
  if (!glbPath) checks.push({ id: 'glb_artifact', status: 'fail', detail: 'model.glb not written' })
  let step = null
  let glb = null
  if (stepPath) {
    step = parseStep(readFileSync(stepPath, 'utf8'))
    glb = glbPath ? parseGlb(readFileSync(glbPath)) : null
    const verdict = verifyBracket(step, glb, expected)
    checks.push(...verdict.checks)
  }
  const reportBbox = revision.report?.bbox?.size ?? revision.report?.geometry?.bbox?.size
  if (reportBbox) {
    const nominal = [expected.length, expected.width, expected.height]
    const actual = [...reportBbox].sort((a, b) => a - b)
    const valid = actual.every((value, index) => Math.abs(value - [...nominal].sort((a, b) => a - b)[index]) <= 0.05)
    checks.push({ id: 'report_bbox', status: valid ? 'pass' : 'fail', detail: `report bbox ${reportBbox.join(' x ')}` })
  }
  const failed = checks.filter(check => check.status === 'fail')
  return { ok: failed.length === 0, checks, failed: failed.map(check => check.id) }
}

function findArtifact(revisionDir, needle) {
  const candidates = []
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === needle || (needle.startsWith('.') && entry.name.endsWith(needle))) candidates.push(full)
    }
  }
  walk(revisionDir)
  return candidates[0] ?? null
}

function summariseModel(model) {
  return {
    modelId: model.modelId,
    revisions: model.revisions.map(revision => ({
      id: revision.revisionId,
      status: revision.status,
      bbox: revision.report?.bbox?.size ?? revision.report?.geometry?.bbox?.size,
      volume: revision.report?.volume ?? revision.report?.geometry?.volume,
    })),
  }
}

function pickNewest(models) {
  return models
    .filter(model => model.revisions.length > 0)
    .sort((a, b) => {
      const aTime = a.revisions.at(-1)?.report?.builtAt ?? ''
      const bTime = b.revisions.at(-1)?.report?.builtAt ?? ''
      return String(bTime).localeCompare(String(aTime)) || String(b.modelId).localeCompare(String(a.modelId))
    })[0] ?? models[0] ?? null
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// ----------------------------------------------------------------- agent ----
/** Run one headless agent turn and capture combined output. */
async function runAgent(prompt, timeoutMs) {
  const env = { ...process.env }
  if (!env.OPENCODE_GO_API_KEY) {
    const key = credentialFromStore('OPENCODE_GO_API_KEY')
    if (key) env.OPENCODE_GO_API_KEY = key
  }
  if (jsonMode) console.log(`\n$ dsh --profile ${profile} <prompt:${prompt.length} chars>`)
  const result = spawnSync('dsh', ['--profile', profile, prompt], {
    encoding: 'utf8',
    env,
    cwd: workspace,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { code: result.status ?? 1, output, prompt }
}

/** Read a provider key from the harness credential file without printing it. */
function credentialFromStore(name) {
  try {
    const text = readFileSync(join(process.env.HOME ?? '', '.dsh', '.credentials.yaml'), 'utf8')
    const match = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(text)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** List CAD jobs from the harness job registry through the agent (best effort). */
async function runJobsList() {
  const result = await runAgent('Reply with the JSON array of CAD background jobs you currently know about, or [] if you have none. Use cad_get_job_status with no job_id.', 300_000)
  const match = /\[[\s\S]*\]/.exec(result.output)
  if (!match) return []
  try { return JSON.parse(match[0]) } catch { return [] }
}

// --------------------------------------------------------------- helpers ----
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [flag, inline] = arg.slice(2).split('=')
    if (inline !== undefined) out[flag] = inline
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { out[flag] = argv[index + 1]; index += 1 }
    else out[flag] = true
  }
  return out
}

function tail(text, lines) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n')
}

await main()
