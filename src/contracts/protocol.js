/**
 * Runtime wire contract shared by the TypeScript Host and the Python CAD
 * runtime. This file is the single source of truth for method names, version
 * and error codes; the Python side mirrors the same constants in
 * `python/cad_runtime/protocol.py` and a unit test asserts both agree.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over the child process stdio
 * (one JSON object per line, UTF-8, no embedded newlines).
 *
 * @module contracts/protocol
 */

/** Protocol version. Bumped only on incompatible wire changes. */
export const PROTOCOL_VERSION = '1.0'

/** Document schema identifier for a CAD model document. */
export const DOCUMENT_SCHEMA = 'dsh.cad/document@1'

/** Methods the Host may call on the runtime. */
export const METHODS = Object.freeze({
  hello: 'runtime.hello',
  health: 'runtime.health',
  shutdown: 'runtime.shutdown',
  build: 'model.build',
  validate: 'model.validate',
  cancel: 'job.cancel',
})

/** Notifications the runtime pushes to the Host (no id, no reply). */
export const NOTIFICATIONS = Object.freeze({
  progress: 'build.progress',
  log: 'runtime.log',
})

/** Stable error codes crossing the boundary. */
export const ERROR_CODES = Object.freeze({
  protocol: 'protocol_error',
  versionMismatch: 'protocol_version_mismatch',
  invalid: 'invalid_document',
  unsupportedOp: 'unsupported_operation',
  buildFailed: 'build_failed',
  invalidGeometry: 'invalid_geometry',
  exportFailed: 'export_failed',
  cancelled: 'cancelled',
  timeout: 'timeout',
  internal: 'internal_error',
})

/** Artifact formats the runtime can produce. */
export const EXPORT_FORMATS = Object.freeze(['step', 'glb', 'stl'])

/** Highest protocol line the runtime will accept before refusing the frame. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
