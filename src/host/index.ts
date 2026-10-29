/**
 * dsh-plugin-cad — Host half entry point.
 *
 * One Cordis plugin row owns the revisioned model store, the supervised Python
 * CAD runtime, nine native agent tools, the read-only viewer API and the
 * background-build job bridge. Everything is registered inside `apply()` as a
 * `ctx.effect` with a disposer, so disabling the plugin leaves no tool, route,
 * listener, timer, temp file or child process behind.
 *
 * `python/` is bundled with the package and spawned as `python -m cad_runtime`
 * from the package root; the child exits on stdin EOF, which is what kills it
 * even if the harness process is SIGKILLed.
 * @module host/index
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CadApi } from './api.ts'
import { PLUGIN_ID, VERSION, findPluginRoot, normalizeConfig } from './config.ts'
import type { RawConfig } from './config.ts'
import { CadJobs } from './jobs.ts'
import type { JobRegistryLike } from './jobs.ts'
import { CadRuntime } from './runtime.ts'
import { API_PREFIX, ASSET_PREFIX, CadService } from './service.ts'
import { CadStore } from './store.ts'
import { registerTools } from './tools.ts'
import type { ToolsRegistryLike } from './tools.ts'

/** Cordis plugin name (diagnostics). */
export const name = PLUGIN_ID

/** Version reported by health and the viewer. */
export const version = VERSION

/** Services the plugin cannot work without. */
export const inject = ['tools']

/** Minimal structural view of the Cordis context members this plugin uses. */
interface PluginContext {
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  }
  effect?: (callback: () => void | (() => void) | Promise<void | (() => void)>, label?: string) => unknown
  inject?: (names: string[], callback: (context: PluginContext) => void) => void
  get?: (name: string) => unknown
  provide?: (name: string, value: unknown) => () => void
  tools?: ToolsRegistryLike
  jobs?: JobRegistryLike
  webServer?: {
    register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void
  }
}

/** Structural view of the connection admission service. */
interface ConnectionLike {
  requestRejection?: (req: IncomingMessage) => number | undefined
}

/** A fresh service map for one activation; nothing lives outside apply(). */
export function apply(ctx: PluginContext, rawConfig: RawConfig = {}): void {
  const pluginRoot = findPluginRoot(import.meta.url)
  const config = normalizeConfig(rawConfig, { pluginRoot })
  const log = (message: string, error?: unknown): void => {
    const suffix = error === undefined ? '' : ` ${error instanceof Error ? error.message : String(error)}`
    if (error !== undefined) ctx.logger?.warn?.(`${PLUGIN_ID}: ${message}${suffix}`)
    else ctx.logger?.info?.(`${PLUGIN_ID}: ${message}${suffix}`)
  }

  // The store is the source of truth; it creates its root lazily so activation
  // cannot fail on an unwritable data directory (the first tool call reports it).
  const store = new CadStore({ root: config.dataDir, limits: config.limits, log })
  store.ready().then(
    () => log(`ready — model store at ${config.dataDir}`),
    error => log('could not create the model store directory', error),
  )

  const runtime = new CadRuntime({ config, pluginRoot, log })
  const jobs = new CadJobs({
    getRegistry: () => (ctx.get?.('jobs') as JobRegistryLike | undefined) ?? ctx.jobs ?? null,
    log,
  })
  const service = new CadService({
    config,
    store,
    runtime,
    log,
    jobStats: () => ({ active: jobs.activeCount() }),
  })

  // 1. Job controller: the registry refuses start() until a controller serves it.
  ctx.effect?.(() => jobs.attach(), `${PLUGIN_ID}: jobs controller`)

  // 2. Service registration for other host plugins.
  const disposeService = ctx.provide?.('cadService', service)
  if (typeof disposeService === 'function') {
    ctx.effect?.(() => disposeService, `${PLUGIN_ID}: service`)
  }

  // 3. Agent tools (exactly the nine contract tools).
  const toolDisposers = ctx.tools === undefined ? [] : registerTools(ctx.tools, { service, jobs, config, log })
  ctx.effect?.(() => () => {
    for (const dispose of toolDisposers) dispose()
  }, `${PLUGIN_ID}: tools`)

  // 4. Read-only viewer API + artifact bytes, optionally on the web carrier.
  const admit = (req: IncomingMessage): number | undefined => {
    const connection = ctx.get?.('connection') as ConnectionLike | undefined
    return connection?.requestRejection?.(req)
  }
  const api = new CadApi({ service, admit, log })
  ctx.inject?.(['webServer'], webContext => {
    const webServer = webContext.webServer
    if (typeof webServer?.register !== 'function') {
      log('web carrier present but webServer.register is unavailable; viewer API not served')
      return
    }
    webContext.effect?.(() => webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => api.handleApi(req, res),
    }), `${PLUGIN_ID}: ${API_PREFIX}`)
    webContext.effect?.(() => webServer.register({
      kind: 'prefix',
      path: ASSET_PREFIX,
      handler: (req, res) => api.handleAsset(req, res),
    }), `${PLUGIN_ID}: ${ASSET_PREFIX}`)
  })

  // 5. Runtime lifetime is an effect: shutdown → SIGTERM → SIGKILL, bounded.
  ctx.effect?.(() => () => runtime.dispose(), `${PLUGIN_ID}: python runtime`)

  log(`activated — ${String(toolDisposers.length)} tools, store ${config.dataDir}, runtime ${runtime.command?.executable ?? 'unresolved'}`)
}
