/**
 * Plugin-local error taxonomy. Every failure that reaches a model is mapped to
 * one of these stable codes so prompts and tests can rely on them.
 * @module contracts/errors
 */

/** Code → HTTP status used by the viewer API. */
export const CAD_ERROR_STATUS = Object.freeze({
  invalid_argument: 400,
  invalid_document: 400,
  not_found: 404,
  revision_conflict: 409,
  model_locked: 409,
  permission_denied: 403,
  path_escape: 403,
  too_large: 413,
  runtime_unavailable: 503,
  runtime_crashed: 503,
  build_failed: 422,
  invalid_geometry: 422,
  export_failed: 422,
  cancelled: 499,
  timeout: 504,
  internal: 500,
})

/** One structured failure carrying a stable code, message and details. */
export class CadError extends Error {
  /**
   * @param {keyof typeof CAD_ERROR_STATUS} code - stable error code.
   * @param {string} message - human/model readable reason.
   * @param {Record<string, unknown>} [details] - structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'CadError'
    this.code = code
    this.details = details
    this.status = CAD_ERROR_STATUS[code] ?? 500
  }
}

/** @param {unknown} value - candidate error. */
export function isCadError(value) {
  return value instanceof CadError
}
