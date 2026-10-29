/**
 * Optional copy of artifacts out of the model store into the session workspace.
 *
 * Strictly workspace-relative: an absolute `output_path`, a `..` segment, or a
 * symlinked destination that resolves outside the workspace is refused. Copying
 * never overwrites an existing file unless `overwrite: true`, so an export can
 * not silently destroy a user file.
 * @module host/export
 */

import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CadError } from './contracts.ts'

/** One file to copy out of the store. */
export interface WorkspaceCopyFile {
  /** Absolute source path inside the store. */
  source: string
  /** Destination basename (one of the fixed artifact file names). */
  fileName: string
}

/** Result of a workspace export. */
export interface WorkspaceCopyResult {
  /** Absolute destination directory. */
  directory: string
  /** Workspace-relative paths of the files written. */
  written: string[]
}

/** True when `target` is `root` or a descendant. */
function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`)
}

/**
 * Resolve and validate a workspace-relative destination directory.
 * @param workspaceRoot - absolute session workspace root.
 * @param outputPath - caller-supplied relative directory.
 * @returns the absolute destination directory (not created yet).
 * @throws {CadError} `invalid_argument` for an absolute path, `path_escape`
 *   for one that leaves the workspace.
 */
export function resolveWorkspaceDestination(workspaceRoot: string, outputPath: string): { root: string; directory: string } {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '' || !isAbsolute(workspaceRoot)) {
    throw new CadError('invalid_argument', 'the session workspace root is not an absolute path', { workspaceRoot })
  }
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new CadError('invalid_argument', 'output_path must be a non-empty workspace-relative directory', { outputPath })
  }
  if (isAbsolute(outputPath)) {
    throw new CadError('invalid_argument', 'output_path must be workspace-relative, not absolute', { outputPath })
  }
  if (outputPath.split(/[\\/]/u).includes('..')) {
    throw new CadError('path_escape', 'output_path must not contain ".."', { outputPath })
  }
  const root = resolve(workspaceRoot)
  const directory = resolve(root, outputPath)
  if (!isInside(root, directory)) {
    throw new CadError('path_escape', 'output_path escapes the session workspace', { outputPath })
  }
  return { root, directory }
}

/**
 * Create the destination directory and prove the real (symlink-resolved) path
 * is still inside the real workspace root.
 * @param workspaceRoot - absolute session workspace root.
 * @param outputPath - caller-supplied relative directory.
 * @returns the validated absolute destination directory.
 */
export async function prepareWorkspaceDirectory(workspaceRoot: string, outputPath: string): Promise<{ root: string; directory: string }> {
  const resolved = resolveWorkspaceDestination(workspaceRoot, outputPath)
  const rootInfo = await stat(resolved.root).catch(() => null)
  if (rootInfo === null || !rootInfo.isDirectory()) {
    throw new CadError('not_found', 'the session workspace directory does not exist', { workspaceRoot: resolved.root })
  }
  const rootReal = await realpath(resolved.root)
  await mkdir(resolved.directory, { recursive: true })
  const directoryReal = await realpath(resolved.directory)
  if (!isInside(rootReal, directoryReal)) {
    throw new CadError('path_escape', 'the destination resolves outside the session workspace', { outputPath })
  }
  return { root: resolved.root, directory: resolved.directory }
}

/**
 * Copy files into the workspace destination.
 * @param input - destination, files and overwrite policy.
 * @returns written workspace-relative paths.
 */
export async function copyArtifactsIntoWorkspace(input: {
  workspaceRoot: string
  outputPath: string
  files: WorkspaceCopyFile[]
  overwrite?: boolean
}): Promise<WorkspaceCopyResult> {
  const { root, directory } = await prepareWorkspaceDirectory(input.workspaceRoot, input.outputPath)
  const written: string[] = []
  for (const file of input.files) {
    if (file.fileName.includes('/') || file.fileName.includes('\\') || file.fileName.includes('..')) {
      throw new CadError('path_escape', 'artifact file name is not a bare file name', { fileName: file.fileName })
    }
    const destination = join(directory, file.fileName)
    const exists = await stat(destination).then(info => info.isFile()).catch(() => false)
    if (exists && input.overwrite !== true) {
      throw new CadError('invalid_argument', `refusing to overwrite existing file ${file.fileName} without overwrite:true`, {
        file: relative(root, destination),
      })
    }
    await copyFile(file.source, destination)
    written.push(relative(root, destination))
  }
  return { directory, written }
}
