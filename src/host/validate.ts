/**
 * Structural validation of CAD documents (SPEC_P0 §3) and validation of
 * parameter edits before they reach the runtime (SPEC_P0 §7).
 *
 * The host validates first and on purpose: an invalid parameter edit must
 * create **no revision**, so a viewer can never observe a half-broken revision.
 * The runtime re-validates independently; this is not the security boundary,
 * it is the "no bad revision exists" boundary.
 *
 * Every rejection carries `details.path` (`features[2].diameter`) so a model
 * or a user can fix the exact field.
 * @module host/validate
 */

import { CadError, DOCUMENT_SCHEMA } from './contracts.ts'
import type { CadConfig } from './config.ts'
import type { CadDocument, CadFeature, DocumentEdit, NumericField } from './types.ts'

/** Fields every feature may not carry. */
const FEATURE_BASE_KEYS = new Set(['id', 'op'])

/** Numeric fields accepted by the P0 catalogue, with their positivity rule. */
const NUMERIC_FIELDS: Record<string, 'positive' | 'nonnegative' | 'nonzero'> = {
  length: 'positive',
  width: 'positive',
  height: 'positive',
  diameter: 'positive',
  radius: 'positive',
  depth: 'positive',
  distance: 'positive',
  inset: 'nonnegative',
  pitch_diameter: 'positive',
}

/** Allowed keys per `op`; anything else is an `invalid_document`. */
const OP_FIELDS: Record<string, readonly string[]> = {
  box: ['id', 'op', 'length', 'width', 'height', 'center'],
  cylinder: ['id', 'op', 'diameter', 'height', 'center', 'axis'],
  hole: ['id', 'op', 'diameter', 'at', 'through', 'depth', 'axis', 'face'],
  hole_pattern: [
    'id', 'op', 'pattern', 'diameter', 'inset', 'span', 'through', 'count', 'spacing',
    'center', 'pitch_diameter',
  ],
  fillet: ['id', 'op', 'radius', 'target'],
  chamfer: ['id', 'op', 'distance', 'target'],
  cut: ['id', 'op', 'shape'],
  union: ['id', 'op', 'shape'],
}

/** Feature ops that create material (the first feature must be one of these). */
const ADDITIVE_OPS = new Set(['box', 'cylinder', 'union'])

/** ops allowed inside `shape` of cut/union. */
const SHAPE_OPS = new Set(['box', 'cylinder'])

/** Edge-target vocabulary shared by fillet and chamfer. */
const EDGE_TARGETS = new Set(['vertical_edges', 'top_edges', 'bottom_edges', 'all_edges'])

/** Axis vocabulary. */
const AXES = new Set(['x', 'y', 'z'])

/** Hole-pattern vocabulary. */
const PATTERNS = new Set(['rect_corners', 'grid', 'bolt_circle'])

/** Parameter name pattern (SPEC_P0 §3). */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u

/** Feature id pattern (SPEC_P0 §3). */
const FEATURE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u

/** A single violated rule. */
export interface Violation {
  path: string
  message: string
}

/** Thrown as one CadError carrying every violation, with the first as `path`. */
function reject(violations: Violation[], code: 'invalid_document' | 'invalid_argument' = 'invalid_document'): never {
  const first = violations[0] ?? { path: '', message: 'invalid document' }
  const details: Record<string, unknown> = {
    path: first.path,
    violations: violations.slice(0, 32).map(violation => `${violation.path}: ${violation.message}`),
  }
  const summary = violations.length === 1
    ? `${first.path}: ${first.message}`
    : `${first.path}: ${first.message} (${String(violations.length)} violations)`
  throw new CadError(code, summary, details)
}

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Check a numeric field that may be a literal or a `"$name"` reference. */
function checkNumericField(
  raw: unknown,
  path: string,
  rule: 'positive' | 'nonnegative' | 'nonzero',
  parameters: Record<string, number>,
  violations: Violation[],
): void {
  if (typeof raw === 'string') {
    if (!raw.startsWith('$') || raw.length < 2) {
      violations.push({ path, message: 'a numeric string must be a parameter reference "$name"' })
      return
    }
    const name = raw.slice(1)
    if (!PARAMETER_NAME.test(name)) {
      violations.push({ path, message: `"${name}" is not a valid parameter name` })
      return
    }
    if (!Object.hasOwn(parameters, name)) {
      violations.push({ path, message: `unknown parameter reference "$${name}"` })
      return
    }
    checkNumberValue(parameters[name] as number, path, rule, violations)
    return
  }
  if (!isFiniteNumber(raw)) {
    violations.push({ path, message: 'must be a finite number or a "$name" parameter reference' })
    return
  }
  checkNumberValue(raw, path, rule, violations)
}

/** Enforce the positivity rule on a resolved number. */
function checkNumberValue(value: number, path: string, rule: 'positive' | 'nonnegative' | 'nonzero', violations: Violation[]): void {
  if (rule === 'positive' && !(value > 0)) {
    violations.push({ path, message: `must be greater than 0, got ${String(value)}` })
  } else if (rule === 'nonnegative' && !(value >= 0)) {
    violations.push({ path, message: `must be zero or greater, got ${String(value)}` })
  } else if (rule === 'nonzero' && value === 0) {
    violations.push({ path, message: 'must not be zero' })
  }
}

/**
 * Check a `[x, y]` / `[x, y, z]` numeric tuple. Entries may be literals or
 * `"$name"` parameter references, exactly like scalar numeric fields.
 */
function checkTuple(
  raw: unknown,
  path: string,
  lengths: readonly number[],
  parameters: Record<string, number>,
  violations: Violation[],
): void {
  if (!Array.isArray(raw) || !lengths.includes(raw.length)) {
    violations.push({ path, message: `must be an array of ${lengths.join(' or ')} numbers` })
    return
  }
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]
    if (typeof entry === 'string') {
      if (!entry.startsWith('$') || entry.length < 2 || !PARAMETER_NAME.test(entry.slice(1))) {
        violations.push({ path: `${path}[${String(index)}]`, message: 'must be a number or a "$name" parameter reference' })
        continue
      }
      if (!Object.hasOwn(parameters, entry.slice(1))) {
        violations.push({ path: `${path}[${String(index)}]`, message: `unknown parameter reference "${entry}"` })
      }
      continue
    }
    if (!isFiniteNumber(entry)) violations.push({ path: `${path}[${String(index)}]`, message: 'must be a finite number or a "$name" reference' })
  }
}

/** Check an enum-valued field. */
function checkEnum(raw: unknown, path: string, allowed: readonly string[], violations: Violation[]): void {
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    violations.push({ path, message: `must be one of ${allowed.join(' | ')}` })
  }
}

/** Validate one feature against the P0 catalogue. */
function validateFeature(
  raw: unknown,
  path: string,
  parameters: Record<string, number>,
  violations: Violation[],
  options: { requireId: boolean; shapeOf?: string },
): void {
  if (!isRecord(raw)) {
    violations.push({ path, message: 'must be an object' })
    return
  }
  const op = raw.op
  if (typeof op !== 'string') {
    violations.push({ path: `${path}.op`, message: 'is required and must be a string' })
    return
  }
  const allowed = OP_FIELDS[op]
  if (allowed === undefined) {
    violations.push({ path: `${path}.op`, message: `unknown feature op "${op}"` })
    return
  }
  if (options.shapeOf !== undefined && !SHAPE_OPS.has(op)) {
    violations.push({ path: `${path}.op`, message: `${options.shapeOf}.shape may only be box or cylinder` })
    return
  }
  if (options.requireId) {
    if (typeof raw.id !== 'string' || !FEATURE_ID.test(raw.id)) {
      violations.push({ path: `${path}.id`, message: 'is required and must match ^[A-Za-z][A-Za-z0-9_-]{0,39}$' })
    }
  } else if (raw.id !== undefined && (typeof raw.id !== 'string' || !FEATURE_ID.test(raw.id))) {
    violations.push({ path: `${path}.id`, message: 'must match ^[A-Za-z][A-Za-z0-9_-]{0,39}$' })
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      violations.push({ path: `${path}.${key}`, message: `is not a field of "${op}"` })
    }
  }
  for (const [key, rule] of Object.entries(NUMERIC_FIELDS)) {
    if (raw[key] !== undefined) checkNumericField(raw[key], `${path}.${key}`, rule, parameters, violations)
  }
  if (raw.center !== undefined) checkTuple(raw.center, `${path}.center`, [2, 3], parameters, violations)
  if (raw.at !== undefined) checkTuple(raw.at, `${path}.at`, [2], parameters, violations)
  if (raw.span !== undefined) checkTuple(raw.span, `${path}.span`, [2], parameters, violations)
  if (raw.spacing !== undefined) {
    checkTuple(raw.spacing, `${path}.spacing`, [2], parameters, violations)
    if (Array.isArray(raw.spacing)) {
      for (let index = 0; index < raw.spacing.length; index += 1) {
        const resolved = resolveNumber(raw.spacing[index] as NumericField, parameters)
        if (resolved !== null && resolved === 0) {
          violations.push({ path: `${path}.spacing[${String(index)}]`, message: 'must not be zero' })
        }
      }
    }
  }
  if (raw.axis !== undefined) checkEnum(raw.axis, `${path}.axis`, [...AXES], violations)
  if (raw.face !== undefined) checkEnum(raw.face, `${path}.face`, ['top', 'bottom'], violations)
  if (raw.target !== undefined) checkEnum(raw.target, `${path}.target`, [...EDGE_TARGETS], violations)
  if (raw.through !== undefined && typeof raw.through !== 'boolean') {
    violations.push({ path: `${path}.through`, message: 'must be a boolean' })
  }

  // Per-op required fields and cross-field rules.
  if (op === 'box') {
    for (const field of ['length', 'width', 'height']) {
      if (raw[field] === undefined) violations.push({ path: `${path}.${field}`, message: 'is required for op "box"' })
    }
  } else if (op === 'cylinder') {
    for (const field of ['diameter', 'height']) {
      if (raw[field] === undefined) violations.push({ path: `${path}.${field}`, message: 'is required for op "cylinder"' })
    }
  } else if (op === 'hole') {
    if (raw.diameter === undefined) violations.push({ path: `${path}.diameter`, message: 'is required for op "hole"' })
    const through = raw.through === undefined ? true : raw.through === true
    if (!through && raw.depth === undefined) {
      violations.push({ path: `${path}.depth`, message: 'is required when through is false' })
    }
  } else if (op === 'hole_pattern') {
    if (raw.pattern === undefined) {
      violations.push({ path: `${path}.pattern`, message: 'is required for op "hole_pattern"' })
    }
    if (raw.diameter === undefined) violations.push({ path: `${path}.diameter`, message: 'is required for op "hole_pattern"' })
    if (raw.pattern === 'rect_corners') {
      if (raw.inset === undefined) violations.push({ path: `${path}.inset`, message: 'is required for pattern "rect_corners"' })
    } else if (raw.pattern === 'grid') {
      if (raw.count === undefined) {
        violations.push({ path: `${path}.count`, message: 'is required for pattern "grid" ([nx, ny])' })
      } else if (!Array.isArray(raw.count) || raw.count.length !== 2) {
        violations.push({ path: `${path}.count`, message: 'must be [nx, ny] for pattern "grid"' })
      } else {
        for (let index = 0; index < 2; index += 1) {
          const value = raw.count[index]
          if (!Number.isInteger(value) || value < 2 || value > 10) {
            violations.push({ path: `${path}.count[${String(index)}]`, message: 'must be an integer between 2 and 10' })
          }
        }
      }
      if (raw.spacing === undefined) violations.push({ path: `${path}.spacing`, message: 'is required for pattern "grid"' })
    } else if (raw.pattern === 'bolt_circle') {
      if (raw.count === undefined) {
        violations.push({ path: `${path}.count`, message: 'is required for pattern "bolt_circle"' })
      } else if (!Number.isInteger(raw.count) || (raw.count as number) < 3 || (raw.count as number) > 24) {
        violations.push({ path: `${path}.count`, message: 'must be an integer between 3 and 24' })
      }
      if (raw.pitch_diameter === undefined) {
        violations.push({ path: `${path}.pitch_diameter`, message: 'is required for pattern "bolt_circle"' })
      }
    }
  } else if (op === 'fillet') {
    if (raw.radius === undefined) violations.push({ path: `${path}.radius`, message: 'is required for op "fillet"' })
  } else if (op === 'chamfer') {
    if (raw.distance === undefined) violations.push({ path: `${path}.distance`, message: 'is required for op "chamfer"' })
  } else if (op === 'cut' || op === 'union') {
    if (raw.shape === undefined) {
      violations.push({ path: `${path}.shape`, message: `is required for op "${op}"` })
    } else {
      validateFeature(raw.shape, `${path}.shape`, parameters, violations, { requireId: false, shapeOf: op })
    }
  }
}

/**
 * Validate and normalize a document (SPEC_P0 §3).
 * @param raw - untrusted document from a tool call or an HTTP body.
 * @param config - limits.
 * @returns the normalized document safe to persist.
 * @throws {CadError} `invalid_document` with `details.path` and `details.violations`.
 */
export function validateDocument(raw: unknown, config: CadConfig): CadDocument {
  const violations: Violation[] = []
  if (!isRecord(raw)) return reject([{ path: 'document', message: 'must be a JSON object' }])
  const allowedTopLevel = new Set(['schema', 'name', 'description', 'units', 'parameters', 'features'])
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) violations.push({ path: key, message: 'is not a document field' })
  }
  if (raw.schema !== undefined && raw.schema !== DOCUMENT_SCHEMA) {
    violations.push({ path: 'schema', message: `must be "${DOCUMENT_SCHEMA}"` })
  }
  if (raw.units !== undefined && raw.units !== 'mm') {
    violations.push({ path: 'units', message: 'P0 accepts only "mm"' })
  }
  for (const field of ['name', 'description']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || (raw[field] as string).length > config.limits.maxNameLength)) {
      violations.push({ path: field, message: `must be a string of at most ${String(config.limits.maxNameLength)} characters` })
    }
  }

  const parameters: Record<string, number> = {}
  if (raw.parameters !== undefined) {
    if (!isRecord(raw.parameters)) {
      violations.push({ path: 'parameters', message: 'must be an object of name → number' })
    } else {
      const names = Object.keys(raw.parameters)
      if (names.length > config.limits.maxParameters) {
        violations.push({ path: 'parameters', message: `at most ${String(config.limits.maxParameters)} parameters are allowed` })
      }
      for (const name of names) {
        const value = raw.parameters[name]
        if (!PARAMETER_NAME.test(name)) {
          violations.push({ path: `parameters.${name}`, message: 'must match ^[A-Za-z][A-Za-z0-9_]{0,39}$' })
          continue
        }
        if (!isFiniteNumber(value)) {
          violations.push({ path: `parameters.${name}`, message: 'must be a finite number' })
          continue
        }
        parameters[name] = value
      }
    }
  }

  if (!Array.isArray(raw.features)) {
    violations.push({ path: 'features', message: 'is required and must be an array' })
    return reject(violations)
  }
  if (raw.features.length === 0) violations.push({ path: 'features', message: 'must contain at least one feature' })
  if (raw.features.length > config.limits.maxFeatures) {
    violations.push({ path: 'features', message: `at most ${String(config.limits.maxFeatures)} features are allowed` })
  }
  const seen = new Set<string>()
  raw.features.forEach((feature, index) => {
    validateFeature(feature, `features[${String(index)}]`, parameters, violations, { requireId: true })
    if (isRecord(feature) && typeof feature.id === 'string') {
      if (seen.has(feature.id)) violations.push({ path: `features[${String(index)}].id`, message: `duplicate feature id "${feature.id}"` })
      seen.add(feature.id)
    }
  })
  if (raw.features.length > 0) {
    const first = raw.features[0]
    if (isRecord(first) && typeof first.op === 'string' && !ADDITIVE_OPS.has(first.op)) {
      violations.push({ path: 'features[0].op', message: 'the first feature must create material (box, cylinder or union)' })
    }
  }
  if (violations.length > 0) return reject(violations)
  return {
    schema: DOCUMENT_SCHEMA,
    units: 'mm',
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    parameters,
    features: raw.features as CadFeature[],
  }
}

/** Resolve a numeric field (literal or `$name`) against a parameter set. */
export function resolveNumber(value: NumericField | undefined, parameters: Record<string, number>): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.startsWith('$')) {
    const resolved = parameters[value.slice(1)]
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null
  }
  return null
}

/** Approximate material extent of the additive features, in mm. */
export function estimateExtent(document: CadDocument, parameters: Record<string, number>): { x: number; y: number; z: number } | null {
  let minX = 0
  let maxX = 0
  let minY = 0
  let maxY = 0
  let minZ = 0
  let maxZ = 0
  let found = false
  const expand = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void => {
    found = true
    minX = Math.min(minX, cx - sx / 2)
    maxX = Math.max(maxX, cx + sx / 2)
    minY = Math.min(minY, cy - sy / 2)
    maxY = Math.max(maxY, cy + sy / 2)
    minZ = Math.min(minZ, cz - sz / 2)
    maxZ = Math.max(maxZ, cz + sz / 2)
  }
  const applyPrimitive = (shape: Record<string, unknown>, op: string): void => {
    const centerRaw = Array.isArray(shape.center) ? shape.center : []
    const cx = isFiniteNumber(centerRaw[0]) ? centerRaw[0] : 0
    const cy = isFiniteNumber(centerRaw[1]) ? centerRaw[1] : 0
    const cz = isFiniteNumber(centerRaw[2]) ? centerRaw[2] : 0
    const length = resolveNumber(shape.length as NumericField, parameters)
    const width = resolveNumber(shape.width as NumericField, parameters)
    const height = resolveNumber(shape.height as NumericField, parameters)
    const diameter = resolveNumber(shape.diameter as NumericField, parameters)
    if (op === 'box' && length !== null && width !== null && height !== null) {
      expand(cx, cy, cz, length, width, height)
    } else if (op === 'cylinder' && diameter !== null && height !== null) {
      const axis = shape.axis === 'x' || shape.axis === 'y' ? shape.axis : 'z'
      if (axis === 'z') expand(cx, cy, cz, diameter, diameter, height)
      else if (axis === 'x') expand(cx, cy, cz, height, diameter, diameter)
      else expand(cx, cy, cz, diameter, height, diameter)
    }
  }
  for (const feature of document.features) {
    if (typeof feature.op !== 'string') continue
    if (feature.op === 'box' || feature.op === 'cylinder') {
      applyPrimitive(feature as unknown as Record<string, unknown>, feature.op)
    } else if (feature.op === 'union') {
      const shape = feature.shape
      if (isRecord(shape) && (shape.op === 'box' || shape.op === 'cylinder')) applyPrimitive(shape, shape.op)
    }
  }
  if (!found) return null
  return { x: Math.abs(maxX - minX), y: Math.abs(maxY - minY), z: Math.abs(maxZ - minZ) }
}

/**
 * Apply an edit to a document and validate the result *before* any build.
 * Structural feature edits reuse the document validator; parameter edits are
 * checked against SPEC_P0 §7 (unknown parameter, non-positive dimension, hole
 * larger than the part) and produce `invalid_argument`, not a revision.
 * @param document - current immutable document.
 * @param edit - requested change.
 * @param config - limits.
 * @returns the next document, validated.
 * @throws {CadError} `invalid_argument` with `details.path`.
 */
export function applyEdit(document: CadDocument, edit: DocumentEdit, config: CadConfig): CadDocument {
  const violations: Violation[] = []
  const currentParameters: Record<string, number> = { ...(document.parameters ?? {}) }
  const nextParameters: Record<string, number> = { ...currentParameters }

  if (edit.parameters !== undefined) {
    if (!isRecord(edit.parameters)) {
      violations.push({ path: 'parameters', message: 'must be an object of name → number' })
    } else {
      for (const [name, value] of Object.entries(edit.parameters)) {
        if (!Object.hasOwn(currentParameters, name)) {
          violations.push({ path: `parameters.${name}`, message: `unknown parameter "${name}"` })
          continue
        }
        if (!isFiniteNumber(value)) {
          violations.push({ path: `parameters.${name}`, message: 'must be a finite number' })
          continue
        }
        nextParameters[name] = value
      }
    }
  }
  if (violations.length > 0) reject(violations, 'invalid_argument')

  // Resolve every feature with the (possibly) new parameter values.
  let features: CadFeature[] = [...document.features]
  if (Array.isArray(edit.removeFeatures) && edit.removeFeatures.length > 0) {
    const removals = new Set(edit.removeFeatures)
    for (const id of edit.removeFeatures) {
      if (typeof id !== 'string' || id.length === 0) violations.push({ path: 'remove_features', message: 'entries must be feature ids' })
    }
    const existing = new Set(features.map(feature => feature.id))
    for (const id of removals) {
      if (!existing.has(id)) violations.push({ path: 'remove_features', message: `no feature with id "${id}"` })
    }
    features = features.filter(feature => !removals.has(feature.id))
  }
  if (Array.isArray(edit.addFeatures) && edit.addFeatures.length > 0) {
    features = [...features, ...(edit.addFeatures as CadFeature[])]
  }
  if (features.length === 0) violations.push({ path: 'features', message: 'a document needs at least one feature' })
  if (features.length > config.limits.maxFeatures) {
    violations.push({ path: 'features', message: `at most ${String(config.limits.maxFeatures)} features are allowed` })
  }
  if (violations.length > 0) reject(violations, 'invalid_argument')

  const candidate: CadDocument = {
    ...document,
    parameters: nextParameters,
    features,
    ...(edit.name !== undefined ? { name: edit.name } : {}),
    ...(edit.description !== undefined ? { description: edit.description } : {}),
  }
  // Structural validation of the resulting document; a structural break in an
  // edit is the caller's argument error, not a corrupt stored document.
  let normalized: CadDocument
  try {
    normalized = validateDocument(candidate, config)
  } catch (error) {
    if (error instanceof Error && 'details' in error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {}
      throw new CadError('invalid_argument', error.message, details)
    }
    throw error
  }

  // SPEC_P0 §7: dimensions must stay positive and holes must fit in the part.
  checkFeasibility(normalized, violations)
  if (violations.length > 0) reject(violations, 'invalid_argument')
  return normalized
}

/** Cross-feature feasibility checks for an edited document. */
function checkFeasibility(document: CadDocument, violations: Violation[]): void {
  const parameters: Record<string, number> = { ...(document.parameters ?? {}) }
  const extent = estimateExtent(document, parameters)
  document.features.forEach((feature, index) => {
    const path = `features[${String(index)}]`
    const op = feature.op
    const shape = isRecord(feature.shape) ? feature.shape : null
    if (op === 'hole') {
      const diameter = resolveNumber(feature.diameter as NumericField, parameters)
      if (diameter !== null && extent !== null) {
        const limit = feature.axis === 'x' ? extent.y : feature.axis === 'y' ? extent.x : Math.min(extent.x, extent.y)
        if (limit > 0 && diameter >= limit) {
          violations.push({ path: `${path}.diameter`, message: `Ø${String(diameter)} mm does not fit in the part (${String(limit)} mm)` })
        }
      }
      if (feature.through === false) {
        const depth = resolveNumber(feature.depth as NumericField, parameters)
        const height = extent === null ? null : (feature.axis === 'x' ? extent.x : feature.axis === 'y' ? extent.y : extent.z)
        if (depth !== null && height !== null && depth > height) {
          violations.push({ path: `${path}.depth`, message: `depth ${String(depth)} mm exceeds the part (${String(height)} mm)` })
        }
      }
    } else if (op === 'hole_pattern') {
      const diameter = resolveNumber(feature.diameter as NumericField, parameters)
      if (diameter === null) return
      if (feature.pattern === 'rect_corners') {
        const inset = resolveNumber(feature.inset as NumericField, parameters)
        if (inset !== null && diameter > inset * 2) {
          violations.push({ path: `${path}.diameter`, message: `Ø${String(diameter)} mm needs inset ≥ ${String(diameter / 2)} mm` })
        }
        const span = Array.isArray(feature.span) ? feature.span : null
        const spanX = span === null ? extent?.x ?? null : resolveNumber(span[0] as NumericField, parameters)
        const spanY = span === null ? extent?.y ?? null : resolveNumber(span[1] as NumericField, parameters)
        if (inset !== null && spanX !== null && spanY !== null && (inset * 2 >= spanX || inset * 2 >= spanY)) {
          violations.push({ path: `${path}.inset`, message: 'two insets must leave room between the corner holes' })
        }
      } else if (feature.pattern === 'bolt_circle') {
        const pitch = resolveNumber(feature.pitch_diameter as NumericField, parameters)
        if (pitch !== null && pitch <= diameter) {
          violations.push({ path: `${path}.pitch_diameter`, message: 'pitch diameter must exceed the hole diameter' })
        }
        if (pitch !== null && extent !== null && pitch / 2 + diameter / 2 > Math.min(extent.x, extent.y) / 2) {
          violations.push({ path: `${path}.pitch_diameter`, message: 'bolt circle does not fit inside the part' })
        }
      }
    } else if ((op === 'cut' || op === 'union') && shape !== null) {
      // A subtracted solid must not be larger than the material it cuts.
      if (op === 'cut' && extent !== null && shape.op === 'box') {
        const length = resolveNumber(shape.length as NumericField, parameters)
        const width = resolveNumber(shape.width as NumericField, parameters)
        if (length !== null && width !== null && (length > extent.x || width > extent.y)) {
          violations.push({ path: `${path}.shape`, message: 'cut box is larger than the part' })
        }
      }
    }
  })
}
