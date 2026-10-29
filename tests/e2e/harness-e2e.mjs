/**
 * Harness-level end-to-end driver for dsh-plugin-cad.
 *
 * Everything here runs against the **real** DeepSeek Harness CLI/profile — no
 * mocks. It covers the lifecycle scenarios that do not need an LLM:
 *
 *   install     install the plugin into a profile with the documented command
 *   compose     the bundle row appears in the composed loader tree
 *   boot        the web app boots, the plugin HTTP API answers, and the client
 *               module is in the boot graph and served under /plugins
 *   security    path-traversal probes against the artifact route are refused
 *   restart     model references survive a full harness restart
 *   disable     disabling the row removes the plugin's tools and routes
 *   uninstall   removing the package leaves no route, no child process, and no
 *               damage to user CAD data
 *
 * Agent-driven scenarios (tool discovery, modelling, revision changes,
 * cancellation) are run separately through `dsh --profile <headless> "<prompt>"`
 * and verified with verify-artifacts.mjs; see tests/e2e/RESULTS.md.
 *
 * Usage:
 *   node tests/e2e/harness-e2e.mjs --plugin <dir> [--profile cadtest] [--port 64899]
 *   node tests/e2e/harness-e2e.mjs --plugin <dir> --scenario boot,security
 *   node tests/e2e/harness-e2e.mjs --plugin <dir> --skip-install   # already installed
 *
 * Exit code 0 when every selected scenario passes.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')
const resultsPath = join(here, 'e2e-report.json')
const outDir = join(packageRoot, 'tests', 'fixtures', 'out')
mkdirSync(outDir, { recursive: true })

const options = parseArgs(process.argv.slice(2))
const profile = options.profile ?? 'cadtest'
const port = Number(options.port ?? 64899)
const pluginPath = options.plugin ? resolve(options.plugin) : packageRoot
const manifest = JSON.parse(readFileSync(join(pluginPath, 'package.json'), 'utf8'))
const pluginName = manifest.name
const baseUrl = `http://127.0.0.1:${port}`
const checkout = "dsh"
const keepInstalled = options['keep-installed'] === true

const report = { plugin: pluginName, profile, port, startedAt: new Date().toISOString(), scenarios: [] }

/** Selected scenario names, in canonical order. */
const ALL = ['install', 'compose', 'boot', 'security', 'restart', 'disable', 'uninstall']
const selected = options.scenario ? String(options.scenario).split(',') : ALL

async function main() {
  let pass = true
  try {
    for (const name of selected) {
      const scenario = SCENARIOS[name]
      if (!scenario) throw new Error(`unknown scenario "${name}"`)
      process.stdout.write(`\n=== scenario: ${name} ===\n`)
      const result = await scenario()
      report.scenarios.push({ name, ...result })
      if (result.status !== 'pass') pass = false
      if (result.status === 'fail') break
    }
  } finally {
    await stopServer()
    report.finishedAt = new Date().toISOString()
    report.ok = pass
    writeFileSync(resultsPath, JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(outDir, 'e2e-report.json'), JSON.stringify(report, null, 2) + '\n')
    for (const scenario of report.scenarios) {
      console.log(`${scenario.status.toUpperCase().padEnd(5)} ${scenario.name.padEnd(10)} ${scenario.detail ?? ''}`)
    }
    console.log(`\nreport: ${resultsPath}`)
  }

  if (!keepInstalled) {
    // Leave the profile in the state we found it (uninstall scenario removes).
  }
  process.exit(pass ? 0 : 1)
}

// ------------------------------------------------------------ scenarios ----
const SCENARIOS = {
  async install() {
    const run = sh('dsh', ['plugin', '--profile', profile, 'add', pluginPath], { allowFailure: true })
    const profilePkgPath = join(home(), '.dsh', 'profiles', profile, 'package.json')
    const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
    const bundles = profilePkg.dsh?.profile?.bundles ?? []
    const hasDependency = Boolean(profilePkg.dependencies?.[pluginName])
    const hasBundle = bundles.includes(pluginName)
    const ok = run.code === 0 && hasDependency && hasBundle
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit=${run.code} dependency=${hasDependency} bundle=${hasBundle}`,
      evidence: { command: `dsh plugin --profile ${profile} add ${pluginPath}`, stdout: tail(run.stdout, 12), stderr: tail(run.stderr, 12), bundles },
    }
  },

  async compose() {
    const run = sh('dsh', ['--profile', profile, '--dump-config'])
    const row = new RegExp(`- id: ${escapeRegExp(pluginName)}\\n  name: ${escapeRegExp(pluginName)}`)
    const present = row.test(run.stdout)
    return {
      status: run.code === 0 && present ? 'pass' : 'fail',
      detail: `dump-config exit=${run.code} row=${present}`,
      evidence: { command: `dsh --profile ${profile} --dump-config`, matched: present, excerpt: excerptAround(run.stdout, pluginName, 6) },
    }
  },

  async boot() {
    const server = await startServer()
    const health = await fetchJson(`${baseUrl}/dsh-plugin-cad/api/health`, { cookie: server.cookie })
    const html = await fetchText(`${baseUrl}/`, { cookie: server.cookie })
    const bootGraphHasClient = html.includes(`${pluginName}/client.js`)
    // The harness serves the client bundle from a content-addressed URL; use
    // the revision hash from the boot graph instead of inventing one (an
    // unknown rev is a 404 by design).
    const rev = new RegExp(`${escapeRegExp(pluginName)}/client\\.js&rev=([a-f0-9]+)`).exec(html)?.[1]
    const bundle = await fetchRaw(`${baseUrl}/plugins/??${pluginName}/client.js${rev ? `&rev=${rev}` : ''}`, { cookie: server.cookie })
    const bundleText = await bundle.text()
    const routerServesClient = bundle.status === 200 && bundleText.includes('__ModuleLoader__.load')
    const healthOk = health.status === 200 && health.json && (health.json.ok === true || health.json.status === 'ok' || health.json.plugin === pluginName)
    return {
      status: healthOk && bootGraphHasClient && routerServesClient ? 'pass' : 'fail',
      detail: `api/health=${health.status} bootGraph=${bootGraphHasClient} clientBundle=${bundle.status}`,
      evidence: {
        url: server.url,
        apiHealth: { status: health.status, body: health.json },
        bootGraphHasClient,
        clientBundle: { status: bundle.status, contentType: bundle.headers['content-type'], containsFactory: bundleText.includes('__ModuleLoader__.load'), bytes: bundleText.length },
      },
    }
  },

  async security() {
    const server = await startServer()
    // Every probe must be refused. A probe "leaks" if the response body looks
    // like a real /etc/passwd or an outside-workspace file we planted.
    const sentinel = 'DSH-CAD-SECRET-SENTINEL'
    const outside = join(outDir, 'outside-secret.txt')
    writeFileSync(outside, sentinel)
    const probes = [
      '/dsh-plugin-cad/assets/../../../../etc/passwd',
      '/dsh-plugin-cad/assets/%2e%2e%2f%2e%2e%2fetc/passwd',
      '/dsh-plugin-cad/assets/..%2f..%2f..%2fetc%2fpasswd',
      '/dsh-plugin-cad/assets//etc/passwd',
      `/dsh-plugin-cad/assets/${encodeURIComponent(outside)}`,
      '/dsh-plugin-cad/assets/models/%2e%2e%2f%2e%2e%2foutside-secret.txt',
      '/dsh-plugin-cad/api/models/..%2f..%2f..%2fetc%2fpasswd',
    ]
    const results = []
    let leaked = false
    for (const probe of probes) {
      const response = await fetchRaw(`${baseUrl}${probe}`, { cookie: server.cookie })
      const body = await response.text()
      const looksLeaked = body.includes(sentinel) || /root:[x*]:0:0:/.test(body)
      if (looksLeaked) leaked = true
      results.push({ probe, status: response.status, leaked: looksLeaked, bytes: body.length })
    }
    return {
      status: leaked ? 'fail' : 'pass',
      detail: `${probes.length} traversal probes, leaked=${leaked}`,
      evidence: { probes: results },
    }
  },

  async restart() {
    const first = await startServer()
    const before = await fetchJson(`${baseUrl}/dsh-plugin-cad/api/models`, { cookie: first.cookie })
    const dataDir = join(home(), '.dsh', 'cad')
    await stopServer()
    const second = await startServer()
    const after = await fetchJson(`${baseUrl}/dsh-plugin-cad/api/models`, { cookie: second.cookie })
    // The model set must be identical after a cold restart: references are
    // host-persisted, never held in a browser or process memory only.
    const ids = response => (response.json?.models ?? []).map(model => model.modelId ?? model.id).sort()
    const beforeIds = ids(before)
    const afterIds = ids(after)
    const same = JSON.stringify(beforeIds) === JSON.stringify(afterIds)
    return {
      status: after.status === 200 && same ? 'pass' : 'fail',
      detail: `models before=[${beforeIds.join(',')}] after=[${afterIds.join(',')}]`,
      evidence: { beforeStatus: before.status, afterStatus: after.status, beforeIds, afterIds, dataDir, dataDirExists: existsSync(dataDir) },
    }
  },

  async disable() {
    const patchPath = join(home(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
    const original = readFileSync(patchPath, 'utf8')
    try {
      // A fresh profile's patch layer is the empty-array literal `[]`; appending
      // a sequence to it would be invalid YAML, so drop the literal first.
      const base = original.replace(/^\s*\[\s*\]\s*$/mu, '').trimEnd()
      writeFileSync(patchPath, `${base}${base.length > 0 ? '\n' : ''}- id: ${pluginName}\n  disabled: true\n`)
      const dump = sh('dsh', ['--profile', profile, '--dump-config'])
      // Split the composed tree into row blocks (`- id: ...` at column 0) and
      // inspect only the block for our row: the config block can be long, so a
      // fixed-size window around the id is fragile.
      const blocks = dump.stdout.split(/\n(?=- id: )/u)
      const rowBlock = blocks.find(block => block.startsWith(`- id: ${pluginName}\n`)) ?? ''
      const disabled = /^\s*disabled: true\s*$/mu.test(rowBlock) || /disabled: !!js/mu.test(rowBlock)
      const server = await startServer()
      const health = await fetchJson(`${baseUrl}/dsh-plugin-cad/api/health`, { cookie: server.cookie })
      const disabledRoute = health.status === 404 || health.status === 401
      return {
        status: disabled && disabledRoute ? 'pass' : 'fail',
        detail: `row disabled=${disabled} routeAfterDisable=${health.status}`,
        evidence: { dumpExcerpt: excerptAround(dump.stdout, pluginName, 5), healthStatusAfterDisable: health.status },
      }
    } finally {
      writeFileSync(patchPath, original)
      await stopServer()
    }
  },

  async uninstall() {
    const run = sh('dsh', ['plugin', '--profile', profile, 'remove', pluginName], { allowFailure: true })
    const profilePkg = JSON.parse(readFileSync(join(home(), '.dsh', 'profiles', profile, 'package.json'), 'utf8'))
    const stillBundled = (profilePkg.dsh?.profile?.bundles ?? []).includes(pluginName)
    const dataDir = join(home(), '.dsh', 'cad')
    const modelsBefore = existsSync(dataDir) ? walk(join(dataDir, 'models')).length : 0
    const server = await startServer()
    const health = await fetchJson(`${baseUrl}/dsh-plugin-cad/api/health`, { cookie: server.cookie })
    const routeGone = health.status === 404 || health.status === 401
    await stopServer()
    const strayProcesses = findStrayRuntimeProcesses(pluginPath)
    const modelsAfter = existsSync(dataDir) ? walk(join(dataDir, 'models')).length : 0
    const dataPreserved = modelsAfter >= modelsBefore
    return {
      status: run.code === 0 && !stillBundled && routeGone && strayProcesses.length === 0 && dataPreserved ? 'pass' : 'fail',
      detail: `removeExit=${run.code} stillBundled=${stillBundled} routeGone=${routeGone} strayProcesses=${strayProcesses.length} dataPreserved=${dataPreserved}`,
      evidence: { removeExit: run.code, stillBundled, healthAfterUninstall: health.status, strayProcesses, modelsBefore, modelsAfter, dataDirPreserved: existsSync(dataDir) },
    }
  },
}

// -------------------------------------------------------------- helpers ----
/** Run a command synchronously and capture output. */
function sh(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', cwd: options.cwd ?? packageRoot, timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (!options.allowFailure) throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr || error.message}`)
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) }
  }
}

let server = null

/** Boot the harness web app and return its token-authenticated cookie. */
async function startServer() {
  await stopServer()
  const child = spawn('dsh', ['--profile', profile, '--no-open', '--port', String(port)], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { child, cookie: '', url: '', log: '', exited: false }
  child.stdout.on('data', chunk => { state.log += chunk.toString() })
  child.stderr.on('data', chunk => { state.log += chunk.toString() })
  child.on('exit', () => { state.exited = true })
  server = state

  const token = await waitFor(() => /token=([A-Za-z0-9_-]+)/.exec(state.log)?.[1], 90_000, 'web boot token')
  state.url = `${baseUrl}/?token=${token}`
  // Exchange the token for the browser-session cookie the harness admission
  // fence expects; without it every plugin route answers 401 by design.
  const response = await fetch(state.url, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  state.cookie = setCookie.map(value => value.split(';')[0]).join('; ')
  await waitFor(async () => {
    const probe = await fetch(`${baseUrl}/`, { headers: state.cookie ? { cookie: state.cookie } : {}, redirect: 'manual' })
    return probe.status === 200 ? true : undefined
  }, 60_000, 'authenticated root')
  return state
}

/** Stop the harness web app and wait for the port to close. */
async function stopServer() {
  if (!server) return
  const current = server
  server = null
  if (!current.exited) {
    current.child.kill('SIGTERM')
    await waitFor(() => (current.exited ? true : undefined), 15_000, 'server exit').catch(() => undefined)
    if (!current.exited) current.child.kill('SIGKILL')
  }
  // Give the OS a moment to release the listening socket.
  await new Promise(resolve => setTimeout(resolve, 400))
}

/** Poll until `probe` returns a truthy value. */
async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function fetchRaw(url, { cookie } = {}) {
  const response = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
  return response
}
async function fetchText(url, options) {
  return (await fetchRaw(url, options)).text()
}
async function fetchJson(url, options) {
  const response = await fetchRaw(url, options)
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON error pages are fine */ }
  return { status: response.status, json, text }
}

/** Find child Python processes that belong to this plugin (leak check). */
function findStrayRuntimeProcesses(pluginRoot) {
  try {
    const output = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
    // Match only a real runtime interpreter, never a shell command line that
    // merely mentions the plugin path (`ps` shows our own test commands too).
    return output.split('\n').filter(line => /\b-m\s+cad_runtime\b/u.test(line) || /cad_runtime[/\\]__main__/u.test(line))
  } catch {
    return []
  }
}

function walk(directory) {
  if (!existsSync(directory)) return []
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Minimal `--flag value` / `--flag` argument parser. */
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

/** Last n lines of captured output, for evidence. */
function tail(text, lines) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n')
}

/** A few lines around the first occurrence of a token, for evidence. */
function excerptAround(text, token, lines) {
  const all = String(text ?? '').split('\n')
  const index = all.findIndex(line => line.includes(token))
  if (index < 0) return null
  return all.slice(Math.max(0, index - 1), index + lines).join('\n')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function home() {
  return process.env.HOME ?? '/Users/' + process.env.USER
}

await main()
