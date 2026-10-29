/**
 * Supervisor for the single long-lived Python CAD runtime (ADR-0002).
 *
 * Responsibilities, all of them effect-scoped in `index.ts`:
 *   - spawn exactly one child (`python -m cad_runtime`) lazily on first use and
 *     keep it warm, because a cold `import build123d` costs ~80 s;
 *   - speak newline-delimited JSON-RPC 2.0 over stdin/stdout with request ids,
 *     a per-request timeout and cooperative `job.cancel`;
 *   - verify the wire protocol with `runtime.hello` before any build;
 *   - keep a bounded stderr ring buffer for diagnostics;
 *   - recover from crashes with bounded restart (surfacing `runtime_crashed` /
 *     `runtime_unavailable`, never a raw exception to the model);
 *   - on timeout or an un-acknowledged cancellation, kill and respawn, so a
 *     wedged OCCT call cannot block the harness;
 *   - on plugin disposal: shutdown → SIGTERM → SIGKILL with bounded waits, and
 *     the child also exits on stdin EOF if the harness process itself dies.
 *
 * No shell is ever involved: the command is an executable plus an args array.
 * The process runs in its own process group (`detached`) so disposal can signal
 * the whole group, including any helper the runtime spawns.
 * @module host/runtime
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { CadError, MAX_FRAME_BYTES, METHODS, PROTOCOL_VERSION } from './contracts.ts'
import type { CadErrorShape } from './contracts.ts'
import type { CadConfig, RuntimeCommand, RuntimeResolution } from './config.ts'
import { VERSION, repairHint, resolveRuntimeCommand, defaultResolveDeps, findPluginRoot } from './config.ts'
import { sanitizeReport, sanitizeRevisionError } from './store.ts'
import type { GeometryReport, ReportCheck, RevisionError, RuntimeStatus } from './types.ts'

/** Largest number of consecutive failed starts before reporting unavailable. */
const MAX_CONSECUTIVE_START_FAILURES = 3

/** Backoff schedule (ms) between failed starts. */
const START_BACKOFF_MS = [500, 1_000, 2_000]

/** Maximum stderr lines kept for diagnostics. */
const MAX_STDERR_LINES = 200

/** JSON-RPC frame the host writes. */
interface RpcRequestFrame {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

/** One in-flight request. */
interface PendingRequest {
  id: number
  method: string
  /** Correlates build progress notifications back to this call. */
  requestId: string | null
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout | null
  settled: boolean
  settledPromise: Promise<void>
  markSettled: () => void
  onProgress?: (line: string) => void
}

/** Result of the `runtime.hello` handshake. */
export interface HelloResult {
  protocolVersion: string
  runtime: Record<string, unknown> | null
  capabilities: Record<string, unknown> | null
}

/** Parse a runtime `model.build` result into the host's shape. */
export interface ParsedBuildResult {
  ok: boolean
  buildId: string | null
  status: 'built' | 'failed'
  report: GeometryReport | null
  artifacts: unknown[]
  error: RevisionError | null
}

/** Parse a runtime `model.validate` result into the host's shape. */
export interface ParsedValidateResult {
  ok: boolean
  valid: boolean
  checks: ReportCheck[]
  report: GeometryReport | null
}

/** Options for one supervised request. */
export interface RequestOptions {
  /** Wall-clock budget for the reply frame. */
  timeoutMs?: number
  /** Caller cancellation; forwarded as `job.cancel` and made quiescent. */
  signal?: AbortSignal
  /** Progress line sink (build.progress notifications). */
  onProgress?: (line: string) => void
  /** Correlation key echoed by the runtime on progress notifications. */
  requestId?: string
}

/** Dependencies seam for tests (fake runtime, fake clock-free waits). */
export interface CadRuntimeOptions {
  config: CadConfig
  pluginRoot?: string
  log?: (message: string, error?: unknown) => void
  /** Override interpreter resolution (tests point it at the fake runtime). */
  resolve?: () => RuntimeResolution
  /** Override argv for tests (`[process.execPath, fixture]`). */
  command?: RuntimeCommand
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Map a JSON-RPC error frame to a structured plugin error. */
function rpcErrorToCadError(frame: unknown, method: string): CadErrorShape {
  if (isRecord(frame)) {
    const data = isRecord(frame.data) ? frame.data : null
    const code = data !== null && typeof data.code === 'string' ? data.code : 'internal'
    const message = typeof frame.message === 'string' && frame.message !== ''
      ? frame.message
      : `${method} failed inside the CAD runtime`
    const details = data !== null && isRecord(data.details) ? data.details : undefined
    const normalized = code === 'internal_error' ? 'internal' : code
    return new CadError(normalized, message, details)
  }
  return new CadError('internal', `${method} failed inside the CAD runtime with a malformed error frame`)
}

/**
 * The supervisor. One instance per plugin activation; `shutdown()` (or the
 * effect disposer that calls it) leaves no child process behind.
 */
export class CadRuntime {
  private readonly config: CadConfig
  private readonly pluginRoot: string
  private readonly log: (message: string, error?: unknown) => void
  private readonly resolveOverride: (() => RuntimeResolution) | null
  private readonly commandOverride: RuntimeCommand | null

  private child: ChildProcess | null = null
  private state: RuntimeStatus['state'] = 'stopped'
  private generation = 0
  private startPromise: Promise<void> | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuffer = ''
  private stderrLines: string[] = []
  private malformedFrames = 0
  private restarts = 0
  private startFailures = 0
  private nextStartAllowedAt = 0
  private lastError: string | null = null
  private lastStartedAt: number | null = null
  private hello: HelloResult | null = null
  private resolved: RuntimeResolution | null = null
  private disposed = false
  private shuttingDown = false
  private exitWaiters: Array<() => void> = []

  constructor(options: CadRuntimeOptions) {
    this.config = options.config
    this.pluginRoot = options.pluginRoot ?? findPluginRoot()
    this.log = options.log ?? (() => undefined)
    this.resolveOverride = options.resolve ?? null
    this.commandOverride = options.command ?? null
  }

  /** Last resolved interpreter command (for diagnostics). */
  get command(): RuntimeCommand | null {
    return this.commandOverride ?? this.resolved?.command ?? null
  }

  /** True while the child is alive and the hello handshake succeeded. */
  get isReady(): boolean {
    return this.state === 'ready'
  }

  /** Current child pid, for the orphan-prevention test and status output. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Human-readable refusal text when no interpreter resolves. */
  unavailableMessage(): string {
    if (this.resolved !== null && this.resolved.command === null) {
      return repairHint(this.pluginRoot, this.resolved.notes)
    }
    return repairHint(this.pluginRoot, [])
  }

  /** Resolve the interpreter once, remembering the diagnostics. */
  private resolveCommand(): RuntimeResolution {
    if (this.commandOverride !== null) {
      return { command: this.commandOverride, notes: ['test command override'] }
    }
    if (this.resolveOverride !== null) {
      this.resolved ??= this.resolveOverride()
      return this.resolved
    }
    this.resolved ??= resolveRuntimeCommand(
      this.config,
      defaultResolveDeps(this.pluginRoot, process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
        ? process.env.DSH_HOME
        : `${process.env.HOME ?? ''}/.dsh`),
    )
    return this.resolved
  }

  /** Re-resolve the interpreter (repair path); returns the diagnostic notes. */
  reResolve(): string[] {
    this.resolved = null
    const resolution = this.resolveCommand()
    return resolution.notes
  }

  /** Snapshot for `/api/health`, `cad_runtime_status` and logs. */
  status(): RuntimeStatus {
    const command = this.command
    const uptimeMs = this.lastStartedAt === null ? 0 : Date.now() - this.lastStartedAt
    return {
      available: this.state === 'ready',
      state: this.state,
      pid: this.child?.pid ?? null,
      executable: command?.executable ?? null,
      executableSource: command?.source ?? null,
      protocolVersion: this.hello?.protocolVersion ?? null,
      runtime: this.hello?.runtime ?? null,
      restarts: this.restarts,
      lastError: this.lastError,
      lastStartedAt: this.lastStartedAt === null ? null : new Date(this.lastStartedAt).toISOString(),
      uptimeMs: this.state === 'ready' ? uptimeMs : 0,
      stderrTail: this.stderrLines.slice(-20),
    }
  }

  /** Full diagnostics (cad_runtime_status verbose). */
  diagnostics(): Record<string, unknown> {
    const status = this.status()
    return {
      ...status,
      protocolVersionExpected: PROTOCOL_VERSION,
      pluginVersion: VERSION,
      capabilities: this.hello?.capabilities ?? null,
      stderrLines: this.stderrLines.slice(-80),
      resolveNotes: this.resolved?.notes ?? [],
      command: this.command === null
        ? null
        : { executable: this.command.executable, args: this.command.args, cwd: this.command.cwd, source: this.command.source },
    }
  }

  /** Append one stderr line to the bounded ring. */
  private appendStderr(line: string): void {
    const trimmed = line.replace(/[\r\n]+$/u, '')
    if (trimmed === '') return
    this.stderrLines.push(trimmed)
    if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES)
  }

  /**
   * Start the runtime if it is not already running. Concurrent callers share one
   * start; a crashed runtime is restarted here (bounded backoff).
   * @throws {CadError} `runtime_unavailable` when no interpreter resolves or the
   *   backoff window is still closed.
   */
  async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new CadError('runtime_unavailable', 'the CAD runtime supervisor has been disposed')
    }
    if (this.state === 'ready' && this.child !== null) return
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  /** One start attempt: spawn, wire framing, hello handshake. */
  private async startOnce(): Promise<void> {
    if (Date.now() < this.nextStartAllowedAt) {
      throw new CadError('runtime_unavailable', this.unavailableMessage(), {
        retryAfterMs: this.nextStartAllowedAt - Date.now(),
        lastError: this.lastError,
      })
    }
    const resolution = this.resolveCommand()
    if (resolution.command === null) {
      this.state = 'disabled'
      this.lastError = 'no Python interpreter with build123d resolved'
      throw new CadError('runtime_unavailable', repairHint(this.pluginRoot, resolution.notes), {
        notes: resolution.notes,
      })
    }
    this.state = 'starting'
    const generation = this.generation + 1
    this.generation = generation
    const command = resolution.command
    let child: ChildProcess
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // Own process group so disposal can signal every descendant. The child
        // also exits on stdin EOF, which covers a SIGKILLed harness process.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      this.registerStartFailure(`could not spawn ${command.executable}`, error)
      throw new CadError('runtime_unavailable', this.unavailableMessage(), { notes: resolution.notes })
    }
    this.child = child
    this.stdoutBuffer = ''
    this.malformedFrames = 0
    this.attachChild(child, generation)
    try {
      const hello = await this.sendHello(child)
      this.hello = hello
      this.state = 'ready'
      this.startFailures = 0
      this.nextStartAllowedAt = 0
      this.lastError = null
      this.lastStartedAt = Date.now()
      if (this.restarts > 0) this.log(`runtime: restarted (${String(this.restarts)} total)`)
      else this.log(`runtime: ready (${command.executable}, source ${command.source}, pid ${String(child.pid)})`)
    } catch (error) {
      const mapped = error instanceof CadError && error.code === 'protocol_version_mismatch'
        ? new CadError('runtime_unavailable', error.message, error.details ?? {})
        : error
      this.registerStartFailure('runtime handshake failed', mapped)
      await this.killChild('handshake failed')
      throw mapped instanceof CadError
        ? mapped
        : new CadError('runtime_unavailable', 'the CAD runtime did not complete its handshake', { cause: String(mapped) })
    }
  }

  /** Wire one child instance's stdio and lifecycle. */
  private attachChild(child: ChildProcess, generation: number): void {
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (generation !== this.generation) return
      this.consumeStdout(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      if (generation !== this.generation) return
      for (const line of chunk.split('\n')) this.appendStderr(line)
    })
    child.on('error', (error: Error) => {
      this.appendStderr(`child error: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (generation !== this.generation) return
      this.onChildExit(code, signal)
    })
    child.stdin?.on('error', () => {
      // EPIPE after a crash is expected; the exit handler owns state.
    })
  }

  /** Handle child exit: settle pending work and mark the supervisor crashed. */
  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = `CAD runtime exited (code ${String(code)}, signal ${String(signal)})`
    this.appendStderr(detail)
    this.child = null
    this.hello = null
    const interrupted = [...this.pending.values()]
    this.pending.clear()
    if (!this.shuttingDown) {
      this.state = 'crashed'
      this.lastError = detail
      this.restarts += 1
    } else {
      this.state = 'stopped'
    }
    for (const pending of interrupted) {
      this.settlePending(pending, undefined, new CadError('runtime_crashed', detail, {
        code: code ?? undefined,
        signal: signal ?? undefined,
      }))
    }
    const waiters = this.exitWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  /** Record one failed start and arm the bounded backoff. */
  private registerStartFailure(message: string, error: unknown): void {
    this.startFailures += 1
    this.lastError = `${message}: ${error instanceof Error ? error.message : String(error)}`
    this.state = 'crashed'
    const backoff = START_BACKOFF_MS[Math.min(this.startFailures - 1, START_BACKOFF_MS.length - 1)] ?? 0
    this.nextStartAllowedAt = Date.now() + backoff
    this.log(`runtime: ${this.lastError}${this.startFailures >= MAX_CONSECUTIVE_START_FAILURES ? ' (giving up until next attempt)' : ''}`)
  }

  /** Consume stdout text and dispatch whole frames. */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    if (this.stdoutBuffer.length > MAX_FRAME_BYTES * 2 && !this.stdoutBuffer.includes('\n')) {
      this.appendStderr('protocol error: oversized frame without a newline; killing the runtime')
      void this.killChild('oversized frame')
      return
    }
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.trim() !== '') this.handleLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  /** Dispatch one JSON-RPC frame (reply or notification). */
  private handleLine(line: string): void {
    if (line.length > MAX_FRAME_BYTES) {
      this.appendStderr('protocol error: frame exceeds MAX_FRAME_BYTES; killing the runtime')
      void this.killChild('oversized frame')
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.malformedFrames += 1
      this.appendStderr(`protocol warning: non-JSON line from runtime (${String(line.length)} bytes)`)
      if (this.malformedFrames > 5) {
        this.appendStderr('protocol error: too many malformed frames; killing the runtime')
        void this.killChild('malformed frames')
      }
      return
    }
    this.malformedFrames = 0
    if (!isRecord(frame)) return
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (isRecord(frame.error)) {
        this.settlePending(pending, undefined, rpcErrorToCadError(frame.error, pending.method))
      } else {
        this.settlePending(pending, frame.result ?? null)
      }
      return
    }
    const method = frame.method
    if (typeof method !== 'string') return
    const params = isRecord(frame.params) ? frame.params : {}
    if (method === 'build.progress') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : null
      const pending = requestId === null ? undefined : [...this.pending.values()].find(entry => entry.requestId === requestId)
      const line = typeof params.message === 'string' && params.message !== ''
        ? `${typeof params.phase === 'string' ? params.phase : 'build'} ${typeof params.percent === 'number' ? `${String(params.percent)}% ` : ''}${params.message}`.trim()
        : null
      if (line !== null) {
        this.appendStderr(`progress: ${line}`)
        pending?.onProgress?.(line)
      }
      return
    }
    if (method === 'runtime.log') {
      const level = typeof params.level === 'string' ? params.level : 'info'
      const message = typeof params.message === 'string' ? params.message : ''
      this.appendStderr(`[${level}] ${message}`)
      if (level === 'error') this.log(`runtime: ${message}`)
    }
  }

  /** Register and write one request frame. */
  private writeRequest(method: string, params: Record<string, unknown>, options: RequestOptions): PendingRequest {
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new CadError('runtime_crashed', 'the CAD runtime is not running')
    }
    const id = this.nextId
    this.nextId += 1
    let markSettled!: () => void
    const settledPromise = new Promise<void>(resolve => {
      markSettled = resolve
    })
    const pending: PendingRequest = {
      id,
      method,
      requestId: options.requestId ?? null,
      resolve: () => undefined,
      reject: () => undefined,
      timer: null,
      settled: false,
      settledPromise,
      markSettled,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    this.pending.set(id, pending)
    const timeoutMs = options.timeoutMs
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        void this.onRequestTimeout(pending, timeoutMs)
      }, timeoutMs)
      if (typeof pending.timer.unref === 'function') pending.timer.unref()
    }
    const abort = options.signal
    if (abort !== undefined) {
      if (abort.aborted) {
        queueMicrotask(() => {
          void this.cancelPending(pending, abort.reason)
        })
      } else {
        const listener = (): void => {
          void this.cancelPending(pending, abort.reason)
        }
        abort.addEventListener('abort', listener, { once: true })
        const originalSettle = pending.markSettled
        pending.markSettled = () => {
          abort.removeEventListener('abort', listener)
          originalSettle()
        }
      }
    }
    const frame: RpcRequestFrame = { jsonrpc: '2.0', id, method, params }
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      this.pending.delete(id)
      this.settlePending(pending, undefined, new CadError('runtime_crashed', 'could not write to the CAD runtime', {
        cause: error instanceof Error ? error.message : String(error),
      }))
    }
    // Store the promise on the pending record through a side channel so callers
    // await exactly this request.
    pendingResult.set(pending, promise)
    return pending
  }

  /** Resolve or reject one pending request exactly once. */
  private settlePending(pending: PendingRequest, value?: unknown, error?: unknown): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    pending.markSettled()
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value ?? null)
  }

  /** Run one request and return its result. */
  async request(method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    await this.ensureStarted()
    const pending = this.writeRequest(method, params, options)
    const promise = pendingResult.get(pending)
    if (promise === undefined) throw new CadError('internal', 'request bookkeeping failed')
    return promise
  }

  /** Timeout path: kill+respawn the runtime so a wedged call cannot persist. */
  private async onRequestTimeout(pending: PendingRequest, timeoutMs: number): Promise<void> {
    if (pending.settled) return
    this.pending.delete(pending.id)
    if (pending.method !== METHODS.shutdown) {
      await this.killChild(`request ${pending.method} timed out`)
    }
    this.settlePending(pending, undefined, new CadError('timeout', `${pending.method} did not finish within ${String(timeoutMs)} ms`, {
      method: pending.method,
      timeoutMs,
      hint: 'the CAD runtime was restarted; retry the call',
    }))
  }

  /** Cancellation path: cooperative cancel, then bounded quiescence. */
  private async cancelPending(pending: PendingRequest, reason: unknown): Promise<void> {
    if (pending.settled || this.disposed) return
    const text = reason instanceof Error && reason.message !== '' ? reason.message : 'cancelled by the caller'
    this.sendCancelFrame(pending.requestId ?? String(pending.id), text)
    const settled = await Promise.race([
      pending.settledPromise.then(() => true),
      delay(this.config.cancelGraceMs).then(() => false),
    ])
    if (!settled) {
      // Detach first: the kill below settles every pending call with
      // runtime_crashed, but this one must report `cancelled`.
      this.pending.delete(pending.id)
      await this.killChild(`request ${pending.method} did not settle after job.cancel`)
    }
    this.settlePending(pending, undefined, new CadError('cancelled', text, { method: pending.method }))
  }

  /** Write a fire-and-forget `job.cancel` frame (its reply is ignored). */
  private sendCancelFrame(requestId: string, reason: string): void {
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) return
    const id = this.nextId
    this.nextId += 1
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: METHODS.cancel,
        params: { requestId, reason },
      })}\n`)
    } catch {
      // A dead stdin is handled by the exit path and the kill backstop.
    }
  }

  /** Send hello on a freshly spawned child and check the protocol version. */
  private async sendHello(child: ChildProcess): Promise<HelloResult> {
    const pending = this.writeRequest(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION,
      host: { name: 'dsh-plugin-cad', version: VERSION },
    }, { timeoutMs: this.config.runtimeStartTimeoutMs })
    const promise = pendingResult.get(pending)
    if (promise === undefined) throw new CadError('internal', 'hello bookkeeping failed')
    const result = await promise
    if (child !== this.child) throw new CadError('runtime_crashed', 'the CAD runtime exited during its handshake')
    if (!isRecord(result)) throw new CadError('runtime_unavailable', 'the CAD runtime returned a malformed hello')
    const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : ''
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new CadError('runtime_unavailable', `the CAD runtime speaks protocol ${JSON.stringify(protocolVersion)} but this host requires ${PROTOCOL_VERSION}`, {
        expected: PROTOCOL_VERSION,
        received: protocolVersion,
        runtime: result.runtime ?? null,
      })
    }
    return {
      protocolVersion,
      runtime: isRecord(result.runtime) ? result.runtime : null,
      capabilities: isRecord(result.capabilities) ? result.capabilities : null,
    }
  }

  /** Probe an already-running runtime (`cad_runtime_status`, `/api/health`). */
  async health(): Promise<Record<string, unknown>> {
    if (this.state !== 'ready' || this.child === null) {
      return { ok: false, ...this.status() }
    }
    try {
      const result = await this.request(METHODS.health, {}, { timeoutMs: this.config.healthTimeoutMs })
      if (!isRecord(result)) return { ok: true, ...this.status() }
      return { ok: result.ok !== false, ...this.status(), health: result }
    } catch (error) {
      return {
        ok: false,
        ...this.status(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * `model.build` with the host's timeout and cancellation semantics.
   * @param params - document, output directory, formats, limits, preview.
   * @param options - signal, progress sink, request id.
   */
  async build(params: Record<string, unknown>, options: RequestOptions = {}): Promise<ParsedBuildResult> {
    const requestId = options.requestId ?? (typeof params.requestId === 'string' ? params.requestId : undefined)
    const result = await this.request(METHODS.build, params, {
      ...options,
      ...(requestId === undefined ? {} : { requestId }),
      timeoutMs: options.timeoutMs ?? this.config.buildTimeoutMs,
    })
    if (options.signal?.aborted === true) {
      throw new CadError('cancelled', 'the build was cancelled by the caller', { method: METHODS.build })
    }
    const parsed = this.parseBuildResult(result)
    if (parsed.status === 'failed' && parsed.error?.code === 'cancelled') {
      throw new CadError('cancelled', parsed.error.message, parsed.error.details ?? { method: METHODS.build })
    }
    return parsed
  }

  /** Parse and sanitize one `model.build` result frame. */
  parseBuildResult(raw: unknown): ParsedBuildResult {
    if (!isRecord(raw)) {
      throw new CadError('internal', 'the CAD runtime returned a malformed build result')
    }
    const status = raw.status === 'built' ? 'built' : 'failed'
    const report = sanitizeReport(raw.report, status === 'built')
    const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : []
    const error = sanitizeRevisionError(raw.error)
    return {
      ok: raw.ok !== false,
      buildId: typeof raw.buildId === 'string' ? raw.buildId : null,
      status,
      report,
      artifacts,
      error,
    }
  }

  /** `model.validate`: extra geometry checks without writing files. */
  async validateModel(params: Record<string, unknown>, options: RequestOptions = {}): Promise<ParsedValidateResult> {
    const requestId = options.requestId ?? (typeof params.requestId === 'string' ? params.requestId : undefined)
    const result = await this.request(METHODS.validate, params, {
      ...options,
      ...(requestId === undefined ? {} : { requestId }),
      timeoutMs: options.timeoutMs ?? this.config.buildTimeoutMs,
    })
    if (options.signal?.aborted === true) {
      throw new CadError('cancelled', 'the validation was cancelled by the caller', { method: METHODS.validate })
    }
    if (!isRecord(result)) throw new CadError('internal', 'the CAD runtime returned a malformed validate result')
    const checks: ReportCheck[] = Array.isArray(result.checks)
      ? result.checks.flatMap(entry => {
          if (!isRecord(entry)) return []
          const status = entry.status
          if (status !== 'pass' && status !== 'fail' && status !== 'warn') return []
          return [{
            id: typeof entry.id === 'string' ? entry.id : 'unknown',
            status,
            message: typeof entry.message === 'string' ? entry.message : '',
          }]
        })
      : []
    return {
      ok: result.ok !== false,
      valid: result.valid === true,
      checks,
      report: sanitizeReport(result.report, result.valid === true),
    }
  }

  /** Kill the child if needed and start a fresh one (repair / post-crash). */
  async restart(reason = 'requested'): Promise<RuntimeStatus> {
    await this.killChild(reason)
    this.startFailures = 0
    this.nextStartAllowedAt = 0
    this.lastError = null
    await this.ensureStarted()
    return this.status()
  }

  /** Signal the whole child process group, falling back to the child handle. */
  private signalChild(signal: NodeJS.Signals): void {
    const child = this.child
    if (child === null || child.pid === undefined) return
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // Fall through to the direct kill below (ESRCH or a non-group child).
      }
    }
    try {
      child.kill(signal)
    } catch {
      // The process is already gone.
    }
  }

  /** Resolve once the current child exits or the timeout elapses. */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child === null) return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      this.exitWaiters.push(() => finish(true))
      const timer = setTimeout(() => finish(this.child === null), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /**
   * Bounded teardown: graceful stdin EOF → runtime.shutdown → SIGTERM → SIGKILL.
   * Always resolves; never throws.
   * @param reason - diagnostic reason recorded in the stderr ring.
   */
  async killChild(reason = 'dispose'): Promise<void> {
    const child = this.child
    if (child === null) {
      this.state = 'stopped'
      this.hello = null
      return
    }
    this.shuttingDown = true
    this.appendStderr(`supervisor: stopping runtime (${reason})`)
    // 1. Cooperative shutdown, only when the handshake succeeded.
    if (this.state === 'ready' && child.stdin !== null && !child.stdin.destroyed) {
      try {
        const pending = this.writeRequest(METHODS.shutdown, { reason }, { timeoutMs: this.config.shutdownGraceMs })
        const promise = pendingResult.get(pending)
        if (promise !== undefined) await promise.catch(() => undefined)
      } catch {
        // Best effort: the signals below are the hard stop.
      }
    }
    // 2. Close stdin: the runtime exits on EOF even if no frame was processed.
    try {
      child.stdin?.end()
    } catch {
      // Already closed.
    }
    // 3. SIGTERM the group, then SIGKILL.
    if (!(await this.waitForExit(this.config.shutdownGraceMs))) {
      this.signalChild('SIGTERM')
      if (!(await this.waitForExit(this.config.terminateGraceMs))) {
        this.signalChild('SIGKILL')
        await this.waitForExit(this.config.killWaitMs)
      }
    }
    // The exit handler normally cleared this; make the state authoritative.
    if (this.child === child) {
      this.child = null
      this.hello = null
      const interrupted = [...this.pending.values()]
      this.pending.clear()
      for (const pending of interrupted) {
        this.settlePending(pending, undefined, new CadError('runtime_crashed', 'the CAD runtime was stopped'))
      }
    }
    this.state = 'stopped'
    this.shuttingDown = false
    this.lastStartedAt = null
  }

  /** Effect disposer body: never leaves a child process behind. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.killChild('plugin disposed')
  }
}

/**
 * Side channel from a pending record to the promise the caller awaits.
 * A `WeakMap` keeps the record shape small and avoids exposing the promise to
 * the frame dispatcher.
 */
const pendingResult = new WeakMap<PendingRequest, Promise<unknown>>()
