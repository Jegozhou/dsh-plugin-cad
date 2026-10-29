/**
 * Typed access to the shared wire contracts.
 *
 * `src/contracts/*.js` is the single source of truth for method names, error
 * codes and the model-facing tool schemas; it is plain JavaScript because the
 * Python runtime mirrors the same constants. This module is the only place the
 * TypeScript host touches it, so the rest of the host depends on typed symbols
 * instead of loose imports.
 *
 * The file deliberately opts out of TypeScript checking: the .js contracts
 * carry JSDoc but no declaration files, and they are bundled by esbuild (which
 * resolves them) plus loaded directly by Node's type-stripping test runner.
 * @module host/contracts
 */
// @ts-nocheck -- see module note: contracts are plain JS by contract.
import * as protocolModule from '../contracts/protocol.js'
import * as errorsModule from '../contracts/errors.js'
import * as toolsModule from '../contracts/tools.js'

/** Wire protocol version the host speaks. */
export const PROTOCOL_VERSION: string = protocolModule.PROTOCOL_VERSION

/** Document schema identifier (`dsh.cad/document@1`). */
export const DOCUMENT_SCHEMA: string = protocolModule.DOCUMENT_SCHEMA

/** Runtime method names. */
export const METHODS: Readonly<{
  hello: string
  health: string
  shutdown: string
  build: string
  validate: string
  cancel: string
}> = protocolModule.METHODS

/** Runtime → host notification method names. */
export const NOTIFICATIONS: Readonly<{ progress: string; log: string }> = protocolModule.NOTIFICATIONS

/** Stable error codes crossing the runtime boundary. */
export const ERROR_CODES: Readonly<Record<string, string>> = protocolModule.ERROR_CODES

/** Artifact formats the runtime can produce. */
export const EXPORT_FORMATS: readonly string[] = protocolModule.EXPORT_FORMATS

/** Largest accepted JSON-RPC frame on either side. */
export const MAX_FRAME_BYTES: number = protocolModule.MAX_FRAME_BYTES

/** One structured plugin failure. */
export interface CadErrorShape extends Error {
  code: string
  details?: Record<string, unknown>
  status: number
}

type CadErrorCtor = new (code: string, message: string, details?: Record<string, unknown>) => CadErrorShape

/** Error class shared with the contracts package. */
export const CadError: CadErrorCtor = errorsModule.CadError

/** Type guard shared with the contracts package. */
export const isCadError: (value: unknown) => value is CadErrorShape = errorsModule.isCadError

/** Stable code → HTTP status. */
export const CAD_ERROR_STATUS: Readonly<Record<string, number>> = errorsModule.CAD_ERROR_STATUS

/** The nine agent tool names, in registration order. */
export const TOOL_NAMES: readonly string[] = toolsModule.TOOL_NAMES

/** Model-facing JSON Schemas keyed by tool name (registered verbatim). */
export const TOOL_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = toolsModule.TOOL_SCHEMAS
