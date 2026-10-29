/**
 * Path safety for the model store and the artifact server.
 *
 * Two independent guards, both required:
 *   1. every caller-supplied segment is validated as a single path component
 *      (no `..`, no separator, no NUL, no control characters, no empty string);
 *   2. the resolved target is proven to stay inside its root both textually and
 *      after `realpath`, and no existing component below the root may be a
 *      symlink.
 *
 * The store writes and the HTTP asset route share this module, so a traversal
 * defence cannot drift between them.
 * @module host/paths
 */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CadError } from './contracts.ts'

/** Model directory names: `m-` plus 10 lowercase hex characters. */
export const MODEL_ID_PATTERN = /^m-[0-9a-f]{10}$/u

/** Revision directory names: `r-` plus at least four digits. */
export const REVISION_ID_PATTERN = /^r-\d{4,}$/u

/** Artifact file name → wire format. */
export const ARTIFACT_FILE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'model.step': 'step',
  'model.glb': 'glb',
  'model.stl': 'stl',
  'preview.svg': 'svg',
})

/** Wire format → artifact file name. */
export const ARTIFACT_FORMAT_FILES: Readonly<Record<string, string>> = Object.freeze({
  step: 'model.step',
  glb: 'model.glb',
  stl: 'model.stl',
  svg: 'preview.svg',
})

/** Known content types only; the asset route serves nothing else. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.step': 'application/step',
  '.stp': 'application/step',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
  '.svg': 'image/svg+xml',
})

/** Extra content types for API-serving of derived text (never arbitrary). */
export const API_CONTENT_TYPE_JSON = 'application/json; charset=utf-8'

/**
 * Reject a value that is not a single safe path component.
 * @param value - candidate segment.
 * @param label - field name used in the error message.
 * @returns the segment unchanged.
 */
export function assertSegment(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CadError('invalid_argument', `${label} must be a non-empty string`, { field: label })
  }
  if (value === '.' || value === '..') {
    throw new CadError('path_escape', `${label} must not be "." or ".."`, { field: label })
  }
  if (value.length > 128) {
    throw new CadError('invalid_argument', `${label} is too long`, { field: label })
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new CadError('path_escape', `${label} must be a bare path component, got ${JSON.stringify(value)}`, { field: label })
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CadError('path_escape', `${label} contains control characters`, { field: label })
  }
  return value
}

/** Validate a model id (`m-` + 10 hex). */
export function assertModelId(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value)) {
    throw new CadError('invalid_argument', 'model_id must look like "m-1a2b3c4d5e"', { field: 'model_id' })
  }
  return value
}

/** Validate a revision id (`r-` + >=4 digits). */
export function assertRevisionId(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_ID_PATTERN.test(value)) {
    throw new CadError('invalid_argument', 'revision_id must look like "r-0002"', { field: 'revision_id' })
  }
  return value
}

/** Format a revision number as its directory name. */
export function revisionIdOf(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CadError('internal', `invalid revision number ${String(number)}`)
  }
  return `r-${String(number).padStart(4, '0')}`
}

/** Parse a revision id back to its number, or null when malformed. */
export function revisionNumberFromId(revisionId: string): number | null {
  if (!REVISION_ID_PATTERN.test(revisionId)) return null
  const number = Number(revisionId.slice(2))
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/** True when `target` is `root` itself or a descendant of it. */
export function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
}

/**
 * Resolve `segments` under `root`, creating the parent when asked, and prove the
 * result cannot escape. Throws `path_escape` when any guard fails.
 * @param root - absolute root directory that must already exist.
 * @param segments - validated-or-unvalidated single path components.
 * @param options - `createParent` creates the immediate parent; `kind` is 'file' or 'dir'.
 * @returns the absolute, symlink-checked target path.
 */
export async function safePath(
  root: string,
  segments: string[],
  options: { createParent?: boolean; kind?: 'file' | 'dir' } = {},
): Promise<string> {
  const rootResolved = resolve(root)
  const safeSegments = segments.map((segment, index) => assertSegment(segment, `path segment ${index}`))
  const target = resolve(rootResolved, ...safeSegments)
  if (!isInside(rootResolved, target)) {
    throw new CadError('path_escape', 'resolved path escaped its root', { root: rootResolved, target })
  }
  if (options.createParent === true) {
    await mkdir(options.kind === 'dir' ? target : resolve(target, '..'), { recursive: true })
  }
  const rootReal = await realpath(rootResolved).catch(() => {
    throw new CadError('not_found', `store directory does not exist: ${rootResolved}`)
  })
  // Walk each existing component under the root; a symlink there is an escape.
  let current = rootResolved
  const remainder = relative(rootResolved, target)
    .split(sep)
    .filter(segment => segment !== '')
  for (const segment of remainder) {
    current = join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (info === null) break
    if (info.isSymbolicLink()) {
      throw new CadError('path_escape', 'path component is a symbolic link', { target: current })
    }
    if (segment !== remainder[remainder.length - 1] && !info.isDirectory()) {
      throw new CadError('path_escape', 'path component is not a directory', { target: current })
    }
  }
  const existing = await lstat(target).catch(() => null)
  if (existing !== null) {
    const targetReal = await realpath(target)
    if (!isInside(rootReal, targetReal)) {
      throw new CadError('path_escape', 'target escapes its root through a symbolic link', { target })
    }
  }
  return target
}

/** Content type for one artifact file name, or null when not servable. */
export function contentTypeForFileName(fileName: string): string | null {
  const format = ARTIFACT_FILE_NAMES[fileName]
  if (format === undefined) return null
  if (format === 'glb') return 'model/gltf-binary'
  if (format === 'step') return 'application/step'
  if (format === 'stl') return 'model/stl'
  if (format === 'svg') return 'image/svg+xml'
  return null
}
