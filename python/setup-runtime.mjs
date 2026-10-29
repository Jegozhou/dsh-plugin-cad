#!/usr/bin/env node
/**
 * dsh-plugin-cad Python runtime installer / repair tool.
 *
 * Creates (or repairs) the long-lived Python CAD runtime virtualenv with the
 * uv-managed CPython 3.12, installs the pinned requirements, then runs the
 * runtime's own self-test (`python -m cad_runtime --selftest`) which builds the
 * acceptance bracket and exports STEP/GLB/STL/SVG.
 *
 * Contract with the Host and the docs:
 *   - non-interactive and idempotent;
 *   - prints exactly ONE machine-readable JSON object on stdout;
 *   - all human/diagnostic output goes to stderr;
 *   - exit code 0 = runtime usable, non-zero = not usable (JSON says why and
 *     how to recover);
 *   - no sudo, no telemetry, no network beyond the Python package index
 *     (uv may download its own CPython 3.12 if the machine has none).
 *
 * Usage:
 *   node python/setup-runtime.mjs            # install or verify, print JSON
 *   node python/setup-runtime.mjs --check    # verify only, never install
 *   node python/setup-runtime.mjs --repair   # recreate the venv from scratch
 *   node python/setup-runtime.mjs --no-dev   # skip pytest (runtime only)
 *
 * Environment:
 *   DSH_CAD_VENV   override the venv directory (default <pkg>/python/.venv)
 *   DSH_CAD_UV     override the uv executable
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(SCRIPT_DIR)
const REQUIREMENTS = join(SCRIPT_DIR, 'requirements.txt')
const REQUIREMENTS_DEV = join(SCRIPT_DIR, 'requirements-dev.txt')
const STARTED_AT = Date.now()

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const venvFlagIndex = argv.indexOf('--venv')
const venvFromFlag = venvFlagIndex >= 0 ? argv[venvFlagIndex + 1] : undefined
const CHECK_ONLY = flags.has('--check')
const REPAIR = flags.has('--repair')
const NO_DEV = flags.has('--no-dev')
const VENV_DIR = resolve(venvFromFlag || process.env.DSH_CAD_VENV || join(SCRIPT_DIR, '.venv'))
const PYTHON = join(VENV_DIR, 'bin', 'python')
const ACTION = CHECK_ONLY ? 'check' : REPAIR ? 'repair' : 'install'

const timings = { totalMs: 0, venvMs: 0, installMs: 0, selfTestMs: 0 }
const warnings = []
const log = (message) => process.stderr.write(`[setup-runtime] ${message}\n`)

class SetupError extends Error {
  constructor(code, message, recovery) {
    super(message)
    this.code = code
    this.recovery = recovery
  }
}

function finish(payload, exitCode = 0) {
  timings.totalMs = Date.now() - STARTED_AT
  const status = {
    ok: exitCode === 0,
    action: ACTION,
    plugin: 'dsh-plugin-cad',
    venv: VENV_DIR,
    python: PYTHON,
    uv: null,
    pinned: readPins(),
    installed: null,
    created: false,
    repaired: false,
    dev: !NO_DEV,
    timings,
    warnings,
    selfTest: null,
    recovery: null,
    error: null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ...payload,
  }
  process.stdout.write(`${JSON.stringify(status)}\n`)
  process.exit(exitCode)
}

function fail(error) {
  const setupError =
    error instanceof SetupError
      ? error
      : new SetupError('internal_error', String(error && error.message ? error.message : error), 're-run with --check and inspect stderr')
  log(`ERROR ${setupError.code}: ${setupError.message}`)
  finish({ error: { code: setupError.code, message: setupError.message }, recovery: setupError.recovery }, 1)
}

function readPins() {
  const pins = {}
  try {
    for (const raw of readFileSync(REQUIREMENTS, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)/)
      if (match) pins[match[1]] = match[2]
    }
  } catch {
    /* missing file is reported later */
  }
  return pins
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function run(command, args, { timeoutMs = 600_000, cwd = PKG_ROOT, env = {} } = {}) {
  log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new SetupError('exec_failed', `${command} failed to start: ${result.error.message}`, null)
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result
}

function findUv() {
  const candidates = [
    process.env.DSH_CAD_UV,
    'uv',
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    join(os.homedir(), '.local/bin/uv'),
    join(os.homedir(), '.cargo/bin/uv'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 20_000 })
    if (!probe.error && probe.status === 0) {
      return { executable: candidate, version: (probe.stdout || '').trim() }
    }
  }
  throw new SetupError(
    'uv_missing',
    'uv is required to create the managed CPython 3.12 virtualenv and it was not found',
    'Install uv (https://docs.astral.sh/uv/getting-started/installation/) or set DSH_CAD_UV=/path/to/uv, then re-run: node python/setup-runtime.mjs',
  )
}

function probeVenv() {
  if (!existsSync(PYTHON)) return null
  const result = spawnSync(
    PYTHON,
    ['-c', 'import json,sys; print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable}))'],
    { encoding: 'utf8', timeout: 60_000 },
  )
  if (result.error || result.status !== 0) return null
  try {
    return JSON.parse(result.stdout.trim().split('\n').pop())
  } catch {
    return null
  }
}

function probePackages() {
  const script = [
    'import importlib.metadata as m, json',
    'names = ["build123d", "trimesh", "numpy", "pytest"]',
    'out = {}',
    'for name in names:',
    '    try: out[name] = m.version(name)',
    '    except Exception: out[name] = None',
    'print(json.dumps(out))',
  ].join('\n')
  const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8', timeout: 120_000 })
  if (result.error || result.status !== 0) return null
  try {
    return JSON.parse(result.stdout.trim().split('\n').pop())
  } catch {
    return null
  }
}

function versionMatches(installed, pins) {
  return Object.entries(pins).every(([name, want]) => installed && installed[name] === want)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(REQUIREMENTS)) {
    throw new SetupError('requirements_missing', `missing ${REQUIREMENTS}`, 'reinstall dsh-plugin-cad; python/requirements.txt ships with the package')
  }
  let uv = null
  const existing = probeVenv()
  const created = false
  let repaired = false

  if (CHECK_ONLY) {
    if (!existing) {
      throw new SetupError('venv_missing', `no usable virtualenv at ${VENV_DIR}`, 'run: node python/setup-runtime.mjs')
    }
    const uvInfo = (() => {
      try {
        return findUv()
      } catch {
        return null
      }
    })()
    uv = uvInfo ? uvInfo.executable : null
    if (existing.version.split('.')[0] !== '3') {
      throw new SetupError('python_version', `venv python is ${existing.version}, expected 3.12.x`, 'run: node python/setup-runtime.mjs --repair')
    }
    if (!existing.version.startsWith('3.12.')) {
      warnings.push(`venv python is ${existing.version}; the pinned environment is CPython 3.12.x`)
    }
    const installed = probePackages()
    if (!installed) {
      throw new SetupError('packages_missing', 'cannot import the runtime dependencies from the venv', 'run: node python/setup-runtime.mjs')
    }
    const pins = readPins()
    if (!versionMatches(installed, pins)) {
      throw new SetupError(
        'packages_mismatch',
        `installed versions ${JSON.stringify(installed)} do not match pins ${JSON.stringify(pins)}`,
        'run: node python/setup-runtime.mjs',
      )
    }
    finish({ uv, installed, created: false, repaired: false, checkOnly: true })
    return
  }

  const uvInfo = findUv()
  uv = uvInfo.executable
  log(`uv ${uvInfo.version} at ${uv}`)
  log(`venv target ${VENV_DIR}`)

  // 1. create / repair the venv ------------------------------------------------
  const venvStarted = Date.now()
  let venv = existing
  if (REPAIR || !venv) {
    const args = ['venv', '--python', '3.12']
    if (existsSync(VENV_DIR)) args.push('--clear')
    args.push(VENV_DIR)
    const result = run(uv, args, { timeoutMs: 600_000 })
    if (result.status !== 0) {
      throw new SetupError(
        'venv_failed',
        `uv venv failed with exit code ${result.status}`,
        'run: uv python install 3.12 && node python/setup-runtime.mjs --repair',
      )
    }
    repaired = Boolean(REPAIR && existsSync(VENV_DIR))
    venv = probeVenv()
    if (!venv) {
      throw new SetupError('venv_unusable', `the venv at ${VENV_DIR} has no usable python`, 'run: node python/setup-runtime.mjs --repair')
    }
  } else {
    log(`reusing existing venv (python ${venv.version})`)
  }
  if (!venv.version.startsWith('3.12.')) {
    throw new SetupError(
      'python_version',
      `venv python is ${venv.version}, expected 3.12.x (Homebrew Pythons are broken for uv on macOS)`,
      'run: node python/setup-runtime.mjs --repair',
    )
  }
  timings.venvMs = Date.now() - venvStarted

  // 2. install pinned requirements --------------------------------------------
  const installStarted = Date.now()
  const installArgs = ['pip', 'install', '--python', PYTHON, '-r', REQUIREMENTS]
  if (!NO_DEV && existsSync(REQUIREMENTS_DEV)) installArgs.push('-r', REQUIREMENTS_DEV)
  const install = run(uv, installArgs, { timeoutMs: 900_000 })
  if (install.status !== 0) {
    throw new SetupError(
      'install_failed',
      `dependency installation failed with exit code ${install.status}`,
      'check network access to the Python package index, then run: node python/setup-runtime.mjs --repair',
    )
  }
  timings.installMs = Date.now() - installStarted

  const installed = probePackages()
  const pins = readPins()
  if (!installed || !versionMatches(installed, pins)) {
    throw new SetupError(
      'packages_mismatch',
      `installed versions ${JSON.stringify(installed)} do not match pins ${JSON.stringify(pins)}`,
      'run: node python/setup-runtime.mjs --repair',
    )
  }
  if (installed.pytest === null) warnings.push('pytest is not installed (dev dependency); runtime works, tests do not')

  // 3. self-test: build the acceptance bracket through the real pipeline ------
  const selfTestStarted = Date.now()
  const selfTest = run(PYTHON, ['-m', 'cad_runtime', '--selftest'], {
    timeoutMs: 600_000,
    cwd: SCRIPT_DIR,
    env: { PYTHONPATH: SCRIPT_DIR },
  })
  timings.selfTestMs = Date.now() - selfTestStarted
  let selfTestPayload = null
  try {
    const lines = (selfTest.stdout || '').trim().split('\n').filter(Boolean)
    selfTestPayload = JSON.parse(lines[lines.length - 1])
  } catch {
    throw new SetupError(
      'selftest_unparseable',
      'the runtime self-test did not print a JSON status object',
      'run manually: PYTHONPATH=python python/.venv/bin/python -m cad_runtime --selftest',
    )
  }
  if (selfTest.status !== 0 || !selfTestPayload.ok) {
    throw new SetupError(
      'selftest_failed',
      `runtime self-test failed: ${JSON.stringify(selfTestPayload.error || selfTestPayload.status || 'unknown')}`,
      'run manually: PYTHONPATH=python python/.venv/bin/python -m cad_runtime --selftest; re-run this installer with --repair if the venv is corrupt',
    )
  }

  finish({
    uv,
    installed,
    created,
    repaired,
    pythonVersion: selfTestPayload.versions ? selfTestPayload.versions.python : venv.version,
    versions: selfTestPayload.versions || null,
    selfTest: {
      ok: true,
      status: selfTestPayload.status,
      geometry: selfTestPayload.geometry || null,
      artifacts: selfTestPayload.artifacts || null,
      importMs: selfTestPayload.importMs ?? null,
      selftestMs: selfTestPayload.selftestMs ?? null,
    },
  })
}

try {
  main()
} catch (error) {
  fail(error)
}
