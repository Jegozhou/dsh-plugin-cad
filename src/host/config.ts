/**
 * Configuration normalization and Python-interpreter resolution.
 *
 * The bundle patch (`cordis.patch.yml`) supplies a complete config, and the
 * loader replaces `config` wholesale rather than deep-merging it, so every
 * field is optional here and every field is clamped: a bad patch can make the
 * plugin conservative, never dangerous or unbounded.
 *
 * Interpreter resolution order (SPEC/ADR-0002):
 *   1. `config.pythonExecutable`
 *   2. `$DSH_CAD_PYTHON`
 *   3. `<DSH_HOME>/cad/venv/bin/python3`
 *   4. `<pluginRoot>/python/.venv/bin/python3`
 *   5. probe `python3 -c "import build123d"` on PATH
 * Resolution is lazy (first geometry work), so plugin activation never blocks
 * for the ~80 s cold `import build123d`.
 * @module host/config
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

/** Plugin id used in logs and in the data directory name. */
export const PLUGIN_ID = 'dsh-plugin-cad'

/** Version reported by health and tool results. */
export const VERSION = '0.1.0'

/** Runtime module invocation (`python -m cad_runtime`). */
export const RUNTIME_MODULE = 'cad_runtime'

/** Raw config exactly as the bundle patch / user patch may declare it. */
export interface RawConfig {
  dataDir?: string
  pythonExecutable?: string
  pythonPath?: string
  allowExport?: boolean
  allowModelWrite?: boolean
  allowRuntimeInstall?: boolean
  buildTimeoutMs?: number
  runtimeStartTimeoutMs?: number
  maxConcurrentBuilds?: number
  maxBoundingBoxMm?: number
  maxArtifactBytes?: number
  checks?: string[]
}

/** Hard limits that are not user-tunable (defense in depth, not preferences). */
export interface CadLimits {
  /** Largest accepted document JSON in bytes. */
  maxDocumentBytes: number
  /** Largest accepted API request body. */
  maxBodyBytes: number
  /** Parameters per document. */
  maxParameters: number
  /** Features per document. */
  maxFeatures: number
  /** Longest accepted model name / description. */
  maxNameLength: number
  /** Longest accepted request id. */
  maxRequestIdLength: number
  /** Longest artifact basename the store will serve. */
  maxArtifactNameLength: number
  /** stderr ring buffer kept for diagnostics. */
  maxStderrBytes: number
  /** Revision history entries returned by one read. */
  maxHistoryEntries: number
  /** Models returned by one list call. */
  maxModelsListed: number
}

/** Normalized, clamped plugin configuration. */
export interface CadConfig {
  /** Absolute model-store root. */
  dataDir: string
  /** Configured interpreter; empty means "resolve". */
  pythonExecutable: string
  /** Extra PYTHONPATH entry; empty means the package's own python/ dir. */
  pythonPath: string
  allowExport: boolean
  allowModelWrite: boolean
  /** When true, `cad_runtime_status action:"repair"` may spawn the installer. */
  allowRuntimeInstall: boolean
  buildTimeoutMs: number
  runtimeStartTimeoutMs: number
  maxConcurrentBuilds: number
  maxBoundingBoxMm: number
  maxArtifactBytes: number
  /** Longest a cancelled build may take to settle before the runtime is killed. */
  cancelGraceMs: number
  /** `runtime.shutdown` reply budget. */
  shutdownGraceMs: number
  /** SIGTERM → SIGKILL wait. */
  terminateGraceMs: number
  /** SIGKILL reap wait. */
  killWaitMs: number
  /** `runtime.health` reply budget. */
  healthTimeoutMs: number
  /** Checks requested by config (empty = all). */
  checks: string[]
  limits: CadLimits
}

/** One candidate runtime command. */
export interface RuntimeCommand {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  source: 'config' | 'env' | 'dsh-home-venv' | 'plugin-venv' | 'path-probe'
}

/** Result of interpreter resolution. */
export interface RuntimeResolution {
  command: RuntimeCommand | null
  notes: string[]
}

/** Injectable filesystem/probe seams so resolution is unit-testable. */
export interface RuntimeResolveDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  dshHome: string
  pluginRoot: string
  exists: (path: string) => boolean
  /** True when `executable` can import build123d. */
  probe: (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => boolean
}

/** The plugin package root, found by walking up to its package.json. */
export function findPluginRoot(start: string = import.meta.url): string {
  let current = start.startsWith('file:') ? dirname(new URL(start).pathname) : start
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === PLUGIN_ID) return current
      } catch {
        // An unreadable or unrelated manifest is not our root; keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // Bundled layout: lib/index.js sits directly under the package root.
  return resolve(dirname(new URL(start.startsWith('file:') ? start : `file://${start}`).pathname), '..')
}

/** Default seam implementations backed by the real filesystem and PATH. */
export function defaultResolveDeps(pluginRoot: string, dshHome: string): RuntimeResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    dshHome,
    pluginRoot,
    exists: path => existsSync(path),
    probe: (executable, args, options) => {
      try {
        execFileSync(executable, args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
          stdio: 'ignore',
          windowsHide: true,
        })
        return true
      } catch {
        return false
      }
    },
  }
}

/** Expand a leading `~` and resolve to an absolute path. */
export function expandPath(value: string, home: string = homedir()): string {
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/** Clamp an integer config value into `[min, max]`, falling back on nonsense. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.trunc(number)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

/** Read a boolean config value, defaulting when it is not a boolean. */
function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize the raw config into the single object the rest of the host reads.
 * Every numeric is clamped; every string is absolute where it names a path.
 * @param raw - config object from the bundle patch (possibly malformed).
 * @param options - environment and plugin root seams.
 * @returns the normalized configuration.
 */
export function normalizeConfig(
  raw: RawConfig | undefined,
  options: { env?: NodeJS.ProcessEnv; pluginRoot?: string; home?: string } = {},
): CadConfig {
  const env = options.env ?? process.env
  const pluginRoot = options.pluginRoot ?? findPluginRoot()
  const home = options.home ?? homedir()
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? expandPath(env.DSH_HOME, home)
    : join(home, '.dsh')
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const configuredDataDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  const dataDir = configuredDataDir === '' ? join(dshHome, 'cad') : expandPath(configuredDataDir, home)
  const buildTimeoutMs = clampInt(config.buildTimeoutMs, 5_000, 1_800_000, 180_000)
  const maxParameters = 64
  const maxFeatures = 64
  const checks = Array.isArray(config.checks)
    ? config.checks.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').slice(0, 16)
    : []
  return {
    dataDir,
    pythonExecutable: typeof config.pythonExecutable === 'string' ? config.pythonExecutable.trim() : '',
    pythonPath: typeof config.pythonPath === 'string' ? config.pythonPath.trim() : '',
    allowExport: boolOr(config.allowExport, true),
    allowModelWrite: boolOr(config.allowModelWrite, true),
    allowRuntimeInstall: boolOr(config.allowRuntimeInstall, false),
    buildTimeoutMs,
    runtimeStartTimeoutMs: clampInt(config.runtimeStartTimeoutMs, 10_000, 600_000, 240_000),
    maxConcurrentBuilds: clampInt(config.maxConcurrentBuilds, 1, 4, 1),
    maxBoundingBoxMm: clampInt(config.maxBoundingBoxMm, 1, 100_000, 2000),
    maxArtifactBytes: clampInt(config.maxArtifactBytes, 4096, 1_073_741_824, 134_217_728),
    cancelGraceMs: 2_500,
    shutdownGraceMs: 2_000,
    terminateGraceMs: 3_000,
    killWaitMs: 2_000,
    healthTimeoutMs: 5_000,
    checks,
    limits: {
      maxDocumentBytes: 262_144,
      maxBodyBytes: 1_048_576,
      maxParameters,
      maxFeatures,
      maxNameLength: 200,
      maxRequestIdLength: 128,
      maxArtifactNameLength: 64,
      maxStderrBytes: 65_536,
      maxHistoryEntries: 100,
      maxModelsListed: 200,
    },
  }
}

/** Candidate interpreter paths for a venv-style installation. */
function venvPython(venvRoot: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(venvRoot, 'Scripts', 'python.exe') : join(venvRoot, 'bin', 'python3')
}

/** Build the environment overrides the runtime process receives. */
function runtimeEnv(config: CadConfig, pluginRoot: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const pythonDir = join(pluginRoot, 'python')
  const pathEntries = [config.pythonPath, pythonDir].filter(entry => entry !== '')
  const extra: Record<string, string> = {
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: pathEntries.join(delimiter),
  }
  if (env.PYTHONHOME !== undefined) extra.PYTHONHOME = env.PYTHONHOME
  return extra
}

/**
 * Resolve the interpreter to spawn, lazily. Never spawns the runtime itself.
 * @param config - normalized configuration.
 * @param deps - filesystem/probe seams (defaults to the real ones).
 * @returns the command plus diagnostics for every candidate that was skipped.
 */
export function resolveRuntimeCommand(
  config: CadConfig,
  deps: RuntimeResolveDeps = defaultResolveDeps(findPluginRoot(), process.env.DSH_HOME ?? join(homedir(), '.dsh')),
): RuntimeResolution {
  const notes: string[] = []
  const pluginRoot = deps.pluginRoot
  const cwd = join(pluginRoot, 'python')
  const env = runtimeEnv(config, pluginRoot, deps.env)
  const make = (executable: string, source: RuntimeCommand['source']): RuntimeCommand => ({
    executable,
    args: ['-m', RUNTIME_MODULE],
    cwd,
    env,
    source,
  })

  const explicit: Array<{ value: string; source: RuntimeCommand['source'] }> = []
  if (config.pythonExecutable !== '') explicit.push({ value: expandPath(config.pythonExecutable), source: 'config' })
  const fromEnv = deps.env.DSH_CAD_PYTHON
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') explicit.push({ value: expandPath(fromEnv), source: 'env' })
  for (const candidate of explicit) {
    if (deps.exists(candidate.value)) return { command: make(candidate.value, candidate.source), notes }
    notes.push(`${candidate.source === 'config' ? 'config.pythonExecutable' : '$DSH_CAD_PYTHON'} does not exist: ${candidate.value}`)
  }

  const managedVenv = venvPython(join(deps.dshHome, 'cad', 'venv'), deps.platform)
  if (deps.exists(managedVenv)) return { command: make(managedVenv, 'dsh-home-venv'), notes }
  notes.push(`no managed runtime at ${managedVenv}`)

  const pluginVenv = venvPython(join(pluginRoot, 'python', '.venv'), deps.platform)
  if (deps.exists(pluginVenv)) return { command: make(pluginVenv, 'plugin-venv'), notes }
  notes.push(`no package runtime at ${pluginVenv}`)

  const probeArgs = ['-c', 'import build123d']
  for (const name of deps.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    if (deps.exists(name)) {
      if (deps.probe(name, probeArgs, { cwd, env: { ...deps.env, ...env }, timeoutMs: config.runtimeStartTimeoutMs })) {
        return { command: make(name, 'path-probe'), notes }
      }
      notes.push(`${name} exists but cannot import build123d`)
      continue
    }
    if (deps.probe(name, probeArgs, { cwd, env: { ...deps.env, ...env }, timeoutMs: config.runtimeStartTimeoutMs })) {
      return { command: make(name, 'path-probe'), notes }
    }
    notes.push(`PATH has no usable ${name}`)
  }
  return { command: null, notes }
}

/** Human-readable repair guidance returned when no interpreter resolves. */
export function repairHint(pluginRoot: string, notes: string[] = []): string {
  const command = `node ${join(pluginRoot, 'python', 'setup-runtime.mjs')}`
  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  return `No Python interpreter with build123d was found. Run "${command}" once, or set pythonExecutable / $DSH_CAD_PYTHON.${suffix}`
}
