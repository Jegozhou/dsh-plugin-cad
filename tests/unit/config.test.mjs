import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  clampInt,
  expandPath,
  findPluginRoot,
  normalizeConfig,
  repairHint,
  resolveRuntimeCommand,
} from '../../src/host/config.ts'
import { PLUGIN_ROOT } from './helpers.mjs'

test('normalizeConfig applies safe defaults and derives <DSH_HOME>/cad', () => {
  const home = '/home/tester'
  const config = normalizeConfig({}, { env: {}, pluginRoot: PLUGIN_ROOT, home })
  assert.equal(config.dataDir, join(home, '.dsh', 'cad'))
  assert.equal(config.pythonExecutable, '')
  assert.equal(config.allowExport, true)
  assert.equal(config.allowModelWrite, true)
  assert.equal(config.allowRuntimeInstall, false)
  assert.equal(config.buildTimeoutMs, 180_000)
  assert.equal(config.runtimeStartTimeoutMs, 240_000)
  assert.equal(config.maxConcurrentBuilds, 1)
  assert.equal(config.maxBoundingBoxMm, 2000)
  assert.equal(config.maxArtifactBytes, 134_217_728)
  assert.equal(config.limits.maxParameters, 64)
  assert.equal(config.limits.maxFeatures, 64)
})

test('normalizeConfig clamps every numeric and never accepts nonsense', () => {
  const home = '/home/tester'
  const tiny = normalizeConfig({
    buildTimeoutMs: 1,
    runtimeStartTimeoutMs: -5,
    maxConcurrentBuilds: 0,
    maxBoundingBoxMm: 0.5,
    maxArtifactBytes: 1,
  }, { env: {}, pluginRoot: PLUGIN_ROOT, home })
  assert.equal(tiny.buildTimeoutMs, 5_000)
  assert.equal(tiny.runtimeStartTimeoutMs, 10_000)
  assert.equal(tiny.maxConcurrentBuilds, 1)
  assert.equal(tiny.maxBoundingBoxMm, 1)
  assert.equal(tiny.maxArtifactBytes, 4_096)

  const huge = normalizeConfig({
    buildTimeoutMs: 99_999_999,
    runtimeStartTimeoutMs: 99_999_999,
    maxConcurrentBuilds: 99,
    maxBoundingBoxMm: 99_999_999,
    maxArtifactBytes: 1e15,
  }, { env: {}, pluginRoot: PLUGIN_ROOT, home })
  assert.equal(huge.buildTimeoutMs, 1_800_000)
  assert.equal(huge.runtimeStartTimeoutMs, 600_000)
  assert.equal(huge.maxConcurrentBuilds, 4)
  assert.equal(huge.maxBoundingBoxMm, 100_000)
  assert.equal(huge.maxArtifactBytes, 1_073_741_824)

  assert.equal(clampInt(Number.NaN, 1, 10, 7), 7)
  assert.equal(clampInt(Infinity, 1, 10, 7), 7)
  assert.equal(clampInt('42', 1, 10, 7), 10, 'numeric config strings are coerced then clamped')
  assert.equal(clampInt('nonsense', 1, 10, 7), 7)
})

test('normalizeConfig resolves dataDir and DSH_HOME', () => {
  const withHome = normalizeConfig({}, { env: { DSH_HOME: '/srv/dsh' }, pluginRoot: PLUGIN_ROOT, home: '/home/tester' })
  assert.equal(withHome.dataDir, '/srv/dsh/cad')
  const explicit = normalizeConfig({ dataDir: '/var/cad-models' }, { env: {}, pluginRoot: PLUGIN_ROOT, home: '/home/tester' })
  assert.equal(explicit.dataDir, '/var/cad-models')
  assert.equal(expandPath('~/models', '/home/tester'), '/home/tester/models')
})

test('findPluginRoot walks up to the package manifest', () => {
  assert.equal(findPluginRoot(), PLUGIN_ROOT)
})

test('interpreter resolution order: config → env → managed venv → plugin venv → PATH probe', () => {
  const config = normalizeConfig({
    pythonExecutable: '/opt/cad/bin/python3',
  }, { env: { DSH_CAD_PYTHON: '/env/bin/python3' }, pluginRoot: '/pkg', home: '/home/t' })
  const makeDeps = overrides => ({
    platform: 'darwin',
    env: { DSH_CAD_PYTHON: '/env/bin/python3' },
    dshHome: '/home/t/.dsh',
    pluginRoot: '/pkg',
    exists: () => false,
    probe: () => false,
    ...overrides,
  })

  const fromConfig = resolveRuntimeCommand(config, makeDeps({ exists: path => path === '/opt/cad/bin/python3' }))
  assert.equal(fromConfig.command?.executable, '/opt/cad/bin/python3')
  assert.equal(fromConfig.command?.source, 'config')
  assert.deepEqual(fromConfig.command?.args, ['-m', 'cad_runtime'])
  assert.equal(fromConfig.command?.cwd, '/pkg/python')

  const fromEnv = resolveRuntimeCommand(
    normalizeConfig({}, { env: { DSH_CAD_PYTHON: '/env/bin/python3' }, pluginRoot: '/pkg', home: '/home/t' }),
    makeDeps({ exists: path => path === '/env/bin/python3' }),
  )
  assert.equal(fromEnv.command?.executable, '/env/bin/python3')
  assert.equal(fromEnv.command?.source, 'env')

  const managed = resolveRuntimeCommand(
    normalizeConfig({}, { env: {}, pluginRoot: '/pkg', home: '/home/t' }),
    makeDeps({ exists: path => path === '/home/t/.dsh/cad/venv/bin/python3' }),
  )
  assert.equal(managed.command?.source, 'dsh-home-venv')

  const pluginVenv = resolveRuntimeCommand(
    normalizeConfig({}, { env: {}, pluginRoot: '/pkg', home: '/home/t' }),
    makeDeps({ exists: path => path === '/pkg/python/.venv/bin/python3' }),
  )
  assert.equal(pluginVenv.command?.source, 'plugin-venv')

  const probed = resolveRuntimeCommand(
    normalizeConfig({}, { env: {}, pluginRoot: '/pkg', home: '/home/t' }),
    makeDeps({ exists: path => path === 'python3', probe: () => true }),
  )
  assert.equal(probed.command?.source, 'path-probe')
  assert.equal(probed.command?.executable, 'python3')

  const nothing = resolveRuntimeCommand(
    normalizeConfig({}, { env: {}, pluginRoot: '/pkg', home: '/home/t' }),
    makeDeps({}),
  )
  assert.equal(nothing.command, null)
  assert.ok(nothing.notes.length >= 3)
  assert.match(repairHint('/pkg', nothing.notes), /setup-runtime\.mjs/u)
})

test('windows venv layout is honoured', () => {
  const config = normalizeConfig({}, { env: {}, pluginRoot: 'C:/pkg', home: 'C:/home' })
  const resolution = resolveRuntimeCommand(config, {
    platform: 'win32',
    env: {},
    dshHome: 'C:/home/.dsh',
    pluginRoot: 'C:/pkg',
    exists: path => path === 'C:/pkg/python/.venv/Scripts/python.exe',
    probe: () => false,
  })
  assert.equal(resolution.command?.source, 'plugin-venv')
  assert.equal(resolution.command?.executable, 'C:/pkg/python/.venv/Scripts/python.exe')
})
