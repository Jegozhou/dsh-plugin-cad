// src/contracts/protocol.js
var PROTOCOL_VERSION = "1.0";
var DOCUMENT_SCHEMA = "dsh.cad/document@1";
var METHODS = Object.freeze({
  hello: "runtime.hello",
  health: "runtime.health",
  shutdown: "runtime.shutdown",
  build: "model.build",
  validate: "model.validate",
  cancel: "job.cancel"
});
var NOTIFICATIONS = Object.freeze({
  progress: "build.progress",
  log: "runtime.log"
});
var ERROR_CODES = Object.freeze({
  protocol: "protocol_error",
  versionMismatch: "protocol_version_mismatch",
  invalid: "invalid_document",
  unsupportedOp: "unsupported_operation",
  buildFailed: "build_failed",
  invalidGeometry: "invalid_geometry",
  exportFailed: "export_failed",
  cancelled: "cancelled",
  timeout: "timeout",
  internal: "internal_error"
});
var EXPORT_FORMATS = Object.freeze(["step", "glb", "stl"]);
var MAX_FRAME_BYTES = 8 * 1024 * 1024;

// src/contracts/errors.js
var CAD_ERROR_STATUS = Object.freeze({
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
  internal: 500
});
var CadError = class extends Error {
  /**
   * @param {keyof typeof CAD_ERROR_STATUS} code - stable error code.
   * @param {string} message - human/model readable reason.
   * @param {Record<string, unknown>} [details] - structured context.
   */
  constructor(code, message, details) {
    super(message);
    this.name = "CadError";
    this.code = code;
    this.details = details;
    this.status = CAD_ERROR_STATUS[code] ?? 500;
  }
};
function isCadError(value) {
  return value instanceof CadError;
}

// src/contracts/tools.js
var TOOL_NAMES = Object.freeze([
  "cad_create_model",
  "cad_modify_model",
  "cad_inspect_model",
  "cad_validate_model",
  "cad_export_model",
  "cad_render_preview",
  "cad_list_models",
  "cad_get_job_status",
  "cad_runtime_status"
]);
var modelId = {
  type: "string",
  description: 'Model id returned by cad_create_model (form "m-1a2b3c4d5e").'
};
var revisionId = {
  type: "string",
  description: 'Immutable revision id (form "r-0003"). Defaults to the current revision.'
};
var revision = {
  type: "integer",
  minimum: 0,
  description: "Current revision number the caller expects. A mismatch is rejected with revision_conflict."
};
var requestId = {
  type: "string",
  description: "Optional idempotency key; replaying the same value returns the revision already created instead of creating a second one."
};
var feature = {
  type: "object",
  description: 'One ordered modelling feature. op \u2208 box | cylinder | hole | hole_pattern | fillet | chamfer | cut | union. Numeric fields accept a number or a parameter reference string "$name". See docs/research/SPEC_P0.md \xA73.1.',
  properties: {
    id: { type: "string", description: 'Unique feature id, e.g. "base" or "center_hole".' },
    op: {
      type: "string",
      enum: ["box", "cylinder", "hole", "hole_pattern", "fillet", "chamfer", "cut", "union"]
    },
    length: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    diameter: { type: "number" },
    radius: { type: "number" },
    depth: { type: "number" },
    distance: { type: "number" },
    inset: { type: "number" },
    through: { type: "boolean" },
    axis: { type: "string", enum: ["x", "y", "z"] },
    target: {
      type: "string",
      enum: ["vertical_edges", "top_edges", "bottom_edges", "all_edges"]
    },
    pattern: { type: "string", enum: ["rect_corners", "grid", "bolt_circle"] },
    count: {
      description: "grid: [nx, ny]; bolt_circle: hole count.",
      anyOf: [{ type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 }, { type: "integer" }]
    },
    spacing: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    span: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    pitch_diameter: { type: "number" },
    at: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    center: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 },
    face: { type: "string", enum: ["top", "bottom"] }
  },
  required: ["id", "op"],
  additionalProperties: false
};
var document = {
  type: "object",
  description: 'Declarative CAD document: {schema, units:"mm", parameters:{name:number}, features:[...]}. Prefer parameters over hard-coded numbers so the model can be edited by changing values.',
  properties: {
    schema: { type: "string", enum: ["dsh.cad/document@1"] },
    name: { type: "string" },
    description: { type: "string" },
    units: { type: "string", enum: ["mm"] },
    parameters: {
      type: "object",
      description: 'Named scalar parameters referenced from features as "$name".',
      additionalProperties: { type: "number" }
    },
    features: { type: "array", items: feature, minItems: 1, maxItems: 64 }
  },
  required: ["features"],
  additionalProperties: false
};
var formats = {
  type: "array",
  description: 'Engineering formats to export. Defaults to ["step","glb"].',
  items: { type: "string", enum: ["step", "glb", "stl"] },
  minItems: 1,
  maxItems: 3
};
var buildOptions = {
  background: {
    type: "boolean",
    description: "Run the build as a native Harness background job and return a job_id immediately. Use for heavy models; otherwise the call returns the finished revision."
  },
  build: { type: "boolean", description: "Build geometry now (default true). Set false to store the document only." }
};
var TOOL_SCHEMAS = Object.freeze({
  cad_create_model: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human readable model name." },
      description: { type: "string" },
      document,
      ...buildOptions,
      request_id: requestId
    },
    required: ["document"],
    additionalProperties: false
  },
  cad_modify_model: {
    type: "object",
    properties: {
      model_id: modelId,
      expected_revision: revision,
      parameters: {
        type: "object",
        description: "Values to merge into document.parameters. This is the normal parameter edit.",
        additionalProperties: { type: "number" }
      },
      add_features: { type: "array", items: feature, description: "Features appended in order." },
      remove_features: {
        type: "array",
        items: { type: "string" },
        description: "Feature ids removed from the document (dependants are not rewritten automatically)."
      },
      name: { type: "string" },
      description: { type: "string" },
      ...buildOptions,
      request_id: requestId
    },
    required: ["model_id", "expected_revision"],
    additionalProperties: false
  },
  cad_inspect_model: {
    type: "object",
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      include: {
        type: "string",
        enum: ["summary", "document", "full"],
        description: "summary (default): metadata + geometry report; document: adds parameters/features; full: adds revision history."
      },
      history_limit: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["model_id"],
    additionalProperties: false
  },
  cad_validate_model: {
    type: "object",
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      document,
      checks: {
        type: "array",
        items: { type: "string" },
        description: "Optional subset of check ids to run; omit for all."
      }
    },
    additionalProperties: false
  },
  cad_export_model: {
    type: "object",
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      formats,
      output_path: {
        type: "string",
        description: "Optional workspace-relative directory to copy the artifacts into. Must stay inside the session workspace. Existing files are never overwritten unless overwrite is true."
      },
      overwrite: { type: "boolean" }
    },
    required: ["model_id"],
    additionalProperties: false
  },
  cad_render_preview: {
    type: "object",
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      view: { type: "string", enum: ["iso", "front", "top", "right"], description: "Default iso." },
      width: { type: "integer", minimum: 200, maximum: 4e3, description: "SVG width in px, default 1200." },
      height: { type: "integer", minimum: 200, maximum: 4e3 },
      format: { type: "string", enum: ["svg"], description: "P0 renders SVG technical projection (hidden-line removed)." }
    },
    required: ["model_id"],
    additionalProperties: false
  },
  cad_list_models: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 200 },
      include_failed: { type: "boolean", description: "Include models whose latest revision failed to build." }
    },
    additionalProperties: false
  },
  cad_get_job_status: {
    type: "object",
    properties: {
      job_id: { type: "string", description: 'Harness job id (form "cad-1"). Omit to list recent CAD jobs.' },
      action: { type: "string", enum: ["status", "cancel"] },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  cad_runtime_status: {
    type: "object",
    properties: {
      verbose: { type: "boolean" },
      action: {
        type: "string",
        enum: ["status", "repair"],
        description: "status (default) probes the Python CAD runtime; repair runs the documented, non-interactive runtime installer and is a write/execute operation."
      }
    },
    additionalProperties: false
  }
});

// src/host/contracts.ts
var PROTOCOL_VERSION2 = PROTOCOL_VERSION;
var DOCUMENT_SCHEMA2 = DOCUMENT_SCHEMA;
var METHODS2 = METHODS;
var EXPORT_FORMATS2 = EXPORT_FORMATS;
var MAX_FRAME_BYTES2 = MAX_FRAME_BYTES;
var CadError2 = CadError;
var isCadError2 = isCadError;
var TOOL_NAMES2 = TOOL_NAMES;
var TOOL_SCHEMAS2 = TOOL_SCHEMAS;

// src/host/service.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir4, realpath as realpath3, stat as stat3 } from "node:fs/promises";
import { relative as relative3 } from "node:path";

// src/host/config.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
var PLUGIN_ID = "dsh-plugin-cad";
var VERSION = "0.1.0";
var RUNTIME_MODULE = "cad_runtime";
function findPluginRoot(start = import.meta.url) {
  let current = start.startsWith("file:") ? dirname(new URL(start).pathname) : start;
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name === PLUGIN_ID) return current;
      } catch {
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(dirname(new URL(start.startsWith("file:") ? start : `file://${start}`).pathname), "..");
}
function defaultResolveDeps(pluginRoot, dshHome) {
  return {
    platform: process.platform,
    env: process.env,
    dshHome,
    pluginRoot,
    exists: (path) => existsSync(path),
    probe: (executable, args, options) => {
      try {
        execFileSync(executable, args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
          stdio: "ignore",
          windowsHide: true
        });
        return true;
      } catch {
        return false;
      }
    }
  };
}
function expandPath(value, home = homedir()) {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}
function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function normalizeConfig(raw, options = {}) {
  const env = options.env ?? process.env;
  const pluginRoot = options.pluginRoot ?? findPluginRoot();
  const home = options.home ?? homedir();
  const dshHome = env.DSH_HOME !== void 0 && env.DSH_HOME.trim() !== "" ? expandPath(env.DSH_HOME, home) : join(home, ".dsh");
  const config = raw !== null && typeof raw === "object" ? raw : {};
  const configuredDataDir = typeof config.dataDir === "string" ? config.dataDir.trim() : "";
  const dataDir = configuredDataDir === "" ? join(dshHome, "cad") : expandPath(configuredDataDir, home);
  const buildTimeoutMs = clampInt(config.buildTimeoutMs, 5e3, 18e5, 18e4);
  const maxParameters = 64;
  const maxFeatures = 64;
  const checks = Array.isArray(config.checks) ? config.checks.filter((entry) => typeof entry === "string" && entry.trim() !== "").slice(0, 16) : [];
  return {
    dataDir,
    pythonExecutable: typeof config.pythonExecutable === "string" ? config.pythonExecutable.trim() : "",
    pythonPath: typeof config.pythonPath === "string" ? config.pythonPath.trim() : "",
    allowExport: boolOr(config.allowExport, true),
    allowModelWrite: boolOr(config.allowModelWrite, true),
    allowRuntimeInstall: boolOr(config.allowRuntimeInstall, false),
    buildTimeoutMs,
    runtimeStartTimeoutMs: clampInt(config.runtimeStartTimeoutMs, 1e4, 6e5, 24e4),
    maxConcurrentBuilds: clampInt(config.maxConcurrentBuilds, 1, 4, 1),
    maxBoundingBoxMm: clampInt(config.maxBoundingBoxMm, 1, 1e5, 2e3),
    maxArtifactBytes: clampInt(config.maxArtifactBytes, 4096, 1073741824, 134217728),
    cancelGraceMs: 2500,
    shutdownGraceMs: 2e3,
    terminateGraceMs: 3e3,
    killWaitMs: 2e3,
    healthTimeoutMs: 5e3,
    checks,
    limits: {
      maxDocumentBytes: 262144,
      maxBodyBytes: 1048576,
      maxParameters,
      maxFeatures,
      maxNameLength: 200,
      maxRequestIdLength: 128,
      maxArtifactNameLength: 64,
      maxStderrBytes: 65536,
      maxHistoryEntries: 100,
      maxModelsListed: 200
    }
  };
}
function venvPython(venvRoot, platform) {
  return platform === "win32" ? join(venvRoot, "Scripts", "python.exe") : join(venvRoot, "bin", "python3");
}
function runtimeEnv(config, pluginRoot, env) {
  const pythonDir = join(pluginRoot, "python");
  const pathEntries = [config.pythonPath, pythonDir].filter((entry) => entry !== "");
  const extra = {
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: pathEntries.join(delimiter)
  };
  if (env.PYTHONHOME !== void 0) extra.PYTHONHOME = env.PYTHONHOME;
  return extra;
}
function resolveRuntimeCommand(config, deps = defaultResolveDeps(findPluginRoot(), process.env.DSH_HOME ?? join(homedir(), ".dsh"))) {
  const notes = [];
  const pluginRoot = deps.pluginRoot;
  const cwd = join(pluginRoot, "python");
  const env = runtimeEnv(config, pluginRoot, deps.env);
  const make = (executable, source) => ({
    executable,
    args: ["-m", RUNTIME_MODULE],
    cwd,
    env,
    source
  });
  const explicit = [];
  if (config.pythonExecutable !== "") explicit.push({ value: expandPath(config.pythonExecutable), source: "config" });
  const fromEnv = deps.env.DSH_CAD_PYTHON;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") explicit.push({ value: expandPath(fromEnv), source: "env" });
  for (const candidate of explicit) {
    if (deps.exists(candidate.value)) return { command: make(candidate.value, candidate.source), notes };
    notes.push(`${candidate.source === "config" ? "config.pythonExecutable" : "$DSH_CAD_PYTHON"} does not exist: ${candidate.value}`);
  }
  const managedVenv = venvPython(join(deps.dshHome, "cad", "venv"), deps.platform);
  if (deps.exists(managedVenv)) return { command: make(managedVenv, "dsh-home-venv"), notes };
  notes.push(`no managed runtime at ${managedVenv}`);
  const pluginVenv = venvPython(join(pluginRoot, "python", ".venv"), deps.platform);
  if (deps.exists(pluginVenv)) return { command: make(pluginVenv, "plugin-venv"), notes };
  notes.push(`no package runtime at ${pluginVenv}`);
  const probeArgs = ["-c", "import build123d"];
  for (const name2 of deps.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    if (deps.exists(name2)) {
      if (deps.probe(name2, probeArgs, { cwd, env: { ...deps.env, ...env }, timeoutMs: config.runtimeStartTimeoutMs })) {
        return { command: make(name2, "path-probe"), notes };
      }
      notes.push(`${name2} exists but cannot import build123d`);
      continue;
    }
    if (deps.probe(name2, probeArgs, { cwd, env: { ...deps.env, ...env }, timeoutMs: config.runtimeStartTimeoutMs })) {
      return { command: make(name2, "path-probe"), notes };
    }
    notes.push(`PATH has no usable ${name2}`);
  }
  return { command: null, notes };
}
function repairHint(pluginRoot, notes = []) {
  const command = `node ${join(pluginRoot, "python", "setup-runtime.mjs")}`;
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return `No Python interpreter with build123d was found. Run "${command}" once, or set pythonExecutable / $DSH_CAD_PYTHON.${suffix}`;
}

// src/host/paths.ts
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join2, relative, resolve as resolve2, sep } from "node:path";
var MODEL_ID_PATTERN = /^m-[0-9a-f]{10}$/u;
var REVISION_ID_PATTERN = /^r-\d{4,}$/u;
var ARTIFACT_FILE_NAMES = Object.freeze({
  "model.step": "step",
  "model.glb": "glb",
  "model.stl": "stl",
  "preview.svg": "svg"
});
var ARTIFACT_FORMAT_FILES = Object.freeze({
  step: "model.step",
  glb: "model.glb",
  stl: "model.stl",
  svg: "preview.svg"
});
var CONTENT_TYPES = Object.freeze({
  ".step": "application/step",
  ".stp": "application/step",
  ".glb": "model/gltf-binary",
  ".stl": "model/stl",
  ".svg": "image/svg+xml"
});
function assertSegment(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CadError2("invalid_argument", `${label} must be a non-empty string`, { field: label });
  }
  if (value === "." || value === "..") {
    throw new CadError2("path_escape", `${label} must not be "." or ".."`, { field: label });
  }
  if (value.length > 128) {
    throw new CadError2("invalid_argument", `${label} is too long`, { field: label });
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0") || isAbsolute2(value)) {
    throw new CadError2("path_escape", `${label} must be a bare path component, got ${JSON.stringify(value)}`, { field: label });
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CadError2("path_escape", `${label} contains control characters`, { field: label });
  }
  return value;
}
function assertModelId(value) {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value)) {
    throw new CadError2("invalid_argument", 'model_id must look like "m-1a2b3c4d5e"', { field: "model_id" });
  }
  return value;
}
function assertRevisionId(value) {
  if (typeof value !== "string" || !REVISION_ID_PATTERN.test(value)) {
    throw new CadError2("invalid_argument", 'revision_id must look like "r-0002"', { field: "revision_id" });
  }
  return value;
}
function revisionIdOf(number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CadError2("internal", `invalid revision number ${String(number)}`);
  }
  return `r-${String(number).padStart(4, "0")}`;
}
function isInside(root, target) {
  const normalizedRoot = resolve2(root);
  const normalizedTarget = resolve2(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}
async function safePath(root, segments, options = {}) {
  const rootResolved = resolve2(root);
  const safeSegments = segments.map((segment, index) => assertSegment(segment, `path segment ${index}`));
  const target = resolve2(rootResolved, ...safeSegments);
  if (!isInside(rootResolved, target)) {
    throw new CadError2("path_escape", "resolved path escaped its root", { root: rootResolved, target });
  }
  if (options.createParent === true) {
    await mkdir(options.kind === "dir" ? target : resolve2(target, ".."), { recursive: true });
  }
  const rootReal = await realpath(rootResolved).catch(() => {
    throw new CadError2("not_found", `store directory does not exist: ${rootResolved}`);
  });
  let current = rootResolved;
  const remainder = relative(rootResolved, target).split(sep).filter((segment) => segment !== "");
  for (const segment of remainder) {
    current = join2(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) break;
    if (info.isSymbolicLink()) {
      throw new CadError2("path_escape", "path component is a symbolic link", { target: current });
    }
    if (segment !== remainder[remainder.length - 1] && !info.isDirectory()) {
      throw new CadError2("path_escape", "path component is not a directory", { target: current });
    }
  }
  const existing = await lstat(target).catch(() => null);
  if (existing !== null) {
    const targetReal = await realpath(target);
    if (!isInside(rootReal, targetReal)) {
      throw new CadError2("path_escape", "target escapes its root through a symbolic link", { target });
    }
  }
  return target;
}
function contentTypeForFileName(fileName) {
  const format = ARTIFACT_FILE_NAMES[fileName];
  if (format === void 0) return null;
  if (format === "glb") return "model/gltf-binary";
  if (format === "step") return "application/step";
  if (format === "stl") return "model/stl";
  if (format === "svg") return "image/svg+xml";
  return null;
}

// src/host/export.ts
import { copyFile, mkdir as mkdir2, realpath as realpath2, stat } from "node:fs/promises";
import { isAbsolute as isAbsolute3, join as join3, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
function isInside2(root, target) {
  return target === root || target.startsWith(`${root}${sep2}`);
}
function resolveWorkspaceDestination(workspaceRoot, outputPath) {
  if (typeof workspaceRoot !== "string" || workspaceRoot === "" || !isAbsolute3(workspaceRoot)) {
    throw new CadError2("invalid_argument", "the session workspace root is not an absolute path", { workspaceRoot });
  }
  if (typeof outputPath !== "string" || outputPath === "") {
    throw new CadError2("invalid_argument", "output_path must be a non-empty workspace-relative directory", { outputPath });
  }
  if (isAbsolute3(outputPath)) {
    throw new CadError2("invalid_argument", "output_path must be workspace-relative, not absolute", { outputPath });
  }
  if (outputPath.split(/[\\/]/u).includes("..")) {
    throw new CadError2("path_escape", 'output_path must not contain ".."', { outputPath });
  }
  const root = resolve3(workspaceRoot);
  const directory = resolve3(root, outputPath);
  if (!isInside2(root, directory)) {
    throw new CadError2("path_escape", "output_path escapes the session workspace", { outputPath });
  }
  return { root, directory };
}
async function prepareWorkspaceDirectory(workspaceRoot, outputPath) {
  const resolved = resolveWorkspaceDestination(workspaceRoot, outputPath);
  const rootInfo = await stat(resolved.root).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory()) {
    throw new CadError2("not_found", "the session workspace directory does not exist", { workspaceRoot: resolved.root });
  }
  const rootReal = await realpath2(resolved.root);
  await mkdir2(resolved.directory, { recursive: true });
  const directoryReal = await realpath2(resolved.directory);
  if (!isInside2(rootReal, directoryReal)) {
    throw new CadError2("path_escape", "the destination resolves outside the session workspace", { outputPath });
  }
  return { root: resolved.root, directory: resolved.directory };
}
async function copyArtifactsIntoWorkspace(input) {
  const { root, directory } = await prepareWorkspaceDirectory(input.workspaceRoot, input.outputPath);
  const written = [];
  for (const file of input.files) {
    if (file.fileName.includes("/") || file.fileName.includes("\\") || file.fileName.includes("..")) {
      throw new CadError2("path_escape", "artifact file name is not a bare file name", { fileName: file.fileName });
    }
    const destination = join3(directory, file.fileName);
    const exists = await stat(destination).then((info) => info.isFile()).catch(() => false);
    if (exists && input.overwrite !== true) {
      throw new CadError2("invalid_argument", `refusing to overwrite existing file ${file.fileName} without overwrite:true`, {
        file: relative2(root, destination)
      });
    }
    await copyFile(file.source, destination);
    written.push(relative2(root, destination));
  }
  return { directory, written };
}

// src/host/validate.ts
var NUMERIC_FIELDS = {
  length: "positive",
  width: "positive",
  height: "positive",
  diameter: "positive",
  radius: "positive",
  depth: "positive",
  distance: "positive",
  inset: "nonnegative",
  pitch_diameter: "positive"
};
var OP_FIELDS = {
  box: ["id", "op", "length", "width", "height", "center"],
  cylinder: ["id", "op", "diameter", "height", "center", "axis"],
  hole: ["id", "op", "diameter", "at", "through", "depth", "axis", "face"],
  hole_pattern: [
    "id",
    "op",
    "pattern",
    "diameter",
    "inset",
    "span",
    "through",
    "count",
    "spacing",
    "center",
    "pitch_diameter"
  ],
  fillet: ["id", "op", "radius", "target"],
  chamfer: ["id", "op", "distance", "target"],
  cut: ["id", "op", "shape"],
  union: ["id", "op", "shape"]
};
var ADDITIVE_OPS = /* @__PURE__ */ new Set(["box", "cylinder", "union"]);
var SHAPE_OPS = /* @__PURE__ */ new Set(["box", "cylinder"]);
var EDGE_TARGETS = /* @__PURE__ */ new Set(["vertical_edges", "top_edges", "bottom_edges", "all_edges"]);
var AXES = /* @__PURE__ */ new Set(["x", "y", "z"]);
var PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
var FEATURE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;
function reject(violations, code = "invalid_document") {
  const first = violations[0] ?? { path: "", message: "invalid document" };
  const details = {
    path: first.path,
    violations: violations.slice(0, 32).map((violation) => `${violation.path}: ${violation.message}`)
  };
  const summary = violations.length === 1 ? `${first.path}: ${first.message}` : `${first.path}: ${first.message} (${String(violations.length)} violations)`;
  throw new CadError2(code, summary, details);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function checkNumericField(raw, path, rule, parameters, violations) {
  if (typeof raw === "string") {
    if (!raw.startsWith("$") || raw.length < 2) {
      violations.push({ path, message: 'a numeric string must be a parameter reference "$name"' });
      return;
    }
    const name2 = raw.slice(1);
    if (!PARAMETER_NAME.test(name2)) {
      violations.push({ path, message: `"${name2}" is not a valid parameter name` });
      return;
    }
    if (!Object.hasOwn(parameters, name2)) {
      violations.push({ path, message: `unknown parameter reference "$${name2}"` });
      return;
    }
    checkNumberValue(parameters[name2], path, rule, violations);
    return;
  }
  if (!isFiniteNumber(raw)) {
    violations.push({ path, message: 'must be a finite number or a "$name" parameter reference' });
    return;
  }
  checkNumberValue(raw, path, rule, violations);
}
function checkNumberValue(value, path, rule, violations) {
  if (rule === "positive" && !(value > 0)) {
    violations.push({ path, message: `must be greater than 0, got ${String(value)}` });
  } else if (rule === "nonnegative" && !(value >= 0)) {
    violations.push({ path, message: `must be zero or greater, got ${String(value)}` });
  } else if (rule === "nonzero" && value === 0) {
    violations.push({ path, message: "must not be zero" });
  }
}
function checkTuple(raw, path, lengths, parameters, violations) {
  if (!Array.isArray(raw) || !lengths.includes(raw.length)) {
    violations.push({ path, message: `must be an array of ${lengths.join(" or ")} numbers` });
    return;
  }
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (typeof entry === "string") {
      if (!entry.startsWith("$") || entry.length < 2 || !PARAMETER_NAME.test(entry.slice(1))) {
        violations.push({ path: `${path}[${String(index)}]`, message: 'must be a number or a "$name" parameter reference' });
        continue;
      }
      if (!Object.hasOwn(parameters, entry.slice(1))) {
        violations.push({ path: `${path}[${String(index)}]`, message: `unknown parameter reference "${entry}"` });
      }
      continue;
    }
    if (!isFiniteNumber(entry)) violations.push({ path: `${path}[${String(index)}]`, message: 'must be a finite number or a "$name" reference' });
  }
}
function checkEnum(raw, path, allowed, violations) {
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    violations.push({ path, message: `must be one of ${allowed.join(" | ")}` });
  }
}
function validateFeature(raw, path, parameters, violations, options) {
  if (!isRecord(raw)) {
    violations.push({ path, message: "must be an object" });
    return;
  }
  const op = raw.op;
  if (typeof op !== "string") {
    violations.push({ path: `${path}.op`, message: "is required and must be a string" });
    return;
  }
  const allowed = OP_FIELDS[op];
  if (allowed === void 0) {
    violations.push({ path: `${path}.op`, message: `unknown feature op "${op}"` });
    return;
  }
  if (options.shapeOf !== void 0 && !SHAPE_OPS.has(op)) {
    violations.push({ path: `${path}.op`, message: `${options.shapeOf}.shape may only be box or cylinder` });
    return;
  }
  if (options.requireId) {
    if (typeof raw.id !== "string" || !FEATURE_ID.test(raw.id)) {
      violations.push({ path: `${path}.id`, message: "is required and must match ^[A-Za-z][A-Za-z0-9_-]{0,39}$" });
    }
  } else if (raw.id !== void 0 && (typeof raw.id !== "string" || !FEATURE_ID.test(raw.id))) {
    violations.push({ path: `${path}.id`, message: "must match ^[A-Za-z][A-Za-z0-9_-]{0,39}$" });
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      violations.push({ path: `${path}.${key}`, message: `is not a field of "${op}"` });
    }
  }
  for (const [key, rule] of Object.entries(NUMERIC_FIELDS)) {
    if (raw[key] !== void 0) checkNumericField(raw[key], `${path}.${key}`, rule, parameters, violations);
  }
  if (raw.center !== void 0) checkTuple(raw.center, `${path}.center`, [2, 3], parameters, violations);
  if (raw.at !== void 0) checkTuple(raw.at, `${path}.at`, [2], parameters, violations);
  if (raw.span !== void 0) checkTuple(raw.span, `${path}.span`, [2], parameters, violations);
  if (raw.spacing !== void 0) {
    checkTuple(raw.spacing, `${path}.spacing`, [2], parameters, violations);
    if (Array.isArray(raw.spacing)) {
      for (let index = 0; index < raw.spacing.length; index += 1) {
        const resolved = resolveNumber(raw.spacing[index], parameters);
        if (resolved !== null && resolved === 0) {
          violations.push({ path: `${path}.spacing[${String(index)}]`, message: "must not be zero" });
        }
      }
    }
  }
  if (raw.axis !== void 0) checkEnum(raw.axis, `${path}.axis`, [...AXES], violations);
  if (raw.face !== void 0) checkEnum(raw.face, `${path}.face`, ["top", "bottom"], violations);
  if (raw.target !== void 0) checkEnum(raw.target, `${path}.target`, [...EDGE_TARGETS], violations);
  if (raw.through !== void 0 && typeof raw.through !== "boolean") {
    violations.push({ path: `${path}.through`, message: "must be a boolean" });
  }
  if (op === "box") {
    for (const field of ["length", "width", "height"]) {
      if (raw[field] === void 0) violations.push({ path: `${path}.${field}`, message: 'is required for op "box"' });
    }
  } else if (op === "cylinder") {
    for (const field of ["diameter", "height"]) {
      if (raw[field] === void 0) violations.push({ path: `${path}.${field}`, message: 'is required for op "cylinder"' });
    }
  } else if (op === "hole") {
    if (raw.diameter === void 0) violations.push({ path: `${path}.diameter`, message: 'is required for op "hole"' });
    const through = raw.through === void 0 ? true : raw.through === true;
    if (!through && raw.depth === void 0) {
      violations.push({ path: `${path}.depth`, message: "is required when through is false" });
    }
  } else if (op === "hole_pattern") {
    if (raw.pattern === void 0) {
      violations.push({ path: `${path}.pattern`, message: 'is required for op "hole_pattern"' });
    }
    if (raw.diameter === void 0) violations.push({ path: `${path}.diameter`, message: 'is required for op "hole_pattern"' });
    if (raw.pattern === "rect_corners") {
      if (raw.inset === void 0) violations.push({ path: `${path}.inset`, message: 'is required for pattern "rect_corners"' });
    } else if (raw.pattern === "grid") {
      if (raw.count === void 0) {
        violations.push({ path: `${path}.count`, message: 'is required for pattern "grid" ([nx, ny])' });
      } else if (!Array.isArray(raw.count) || raw.count.length !== 2) {
        violations.push({ path: `${path}.count`, message: 'must be [nx, ny] for pattern "grid"' });
      } else {
        for (let index = 0; index < 2; index += 1) {
          const value = raw.count[index];
          if (!Number.isInteger(value) || value < 2 || value > 10) {
            violations.push({ path: `${path}.count[${String(index)}]`, message: "must be an integer between 2 and 10" });
          }
        }
      }
      if (raw.spacing === void 0) violations.push({ path: `${path}.spacing`, message: 'is required for pattern "grid"' });
    } else if (raw.pattern === "bolt_circle") {
      if (raw.count === void 0) {
        violations.push({ path: `${path}.count`, message: 'is required for pattern "bolt_circle"' });
      } else if (!Number.isInteger(raw.count) || raw.count < 3 || raw.count > 24) {
        violations.push({ path: `${path}.count`, message: "must be an integer between 3 and 24" });
      }
      if (raw.pitch_diameter === void 0) {
        violations.push({ path: `${path}.pitch_diameter`, message: 'is required for pattern "bolt_circle"' });
      }
    }
  } else if (op === "fillet") {
    if (raw.radius === void 0) violations.push({ path: `${path}.radius`, message: 'is required for op "fillet"' });
  } else if (op === "chamfer") {
    if (raw.distance === void 0) violations.push({ path: `${path}.distance`, message: 'is required for op "chamfer"' });
  } else if (op === "cut" || op === "union") {
    if (raw.shape === void 0) {
      violations.push({ path: `${path}.shape`, message: `is required for op "${op}"` });
    } else {
      validateFeature(raw.shape, `${path}.shape`, parameters, violations, { requireId: false, shapeOf: op });
    }
  }
}
function validateDocument(raw, config) {
  const violations = [];
  if (!isRecord(raw)) return reject([{ path: "document", message: "must be a JSON object" }]);
  const allowedTopLevel = /* @__PURE__ */ new Set(["schema", "name", "description", "units", "parameters", "features"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) violations.push({ path: key, message: "is not a document field" });
  }
  if (raw.schema !== void 0 && raw.schema !== DOCUMENT_SCHEMA2) {
    violations.push({ path: "schema", message: `must be "${DOCUMENT_SCHEMA2}"` });
  }
  if (raw.units !== void 0 && raw.units !== "mm") {
    violations.push({ path: "units", message: 'P0 accepts only "mm"' });
  }
  for (const field of ["name", "description"]) {
    if (raw[field] !== void 0 && (typeof raw[field] !== "string" || raw[field].length > config.limits.maxNameLength)) {
      violations.push({ path: field, message: `must be a string of at most ${String(config.limits.maxNameLength)} characters` });
    }
  }
  const parameters = {};
  if (raw.parameters !== void 0) {
    if (!isRecord(raw.parameters)) {
      violations.push({ path: "parameters", message: "must be an object of name \u2192 number" });
    } else {
      const names = Object.keys(raw.parameters);
      if (names.length > config.limits.maxParameters) {
        violations.push({ path: "parameters", message: `at most ${String(config.limits.maxParameters)} parameters are allowed` });
      }
      for (const name2 of names) {
        const value = raw.parameters[name2];
        if (!PARAMETER_NAME.test(name2)) {
          violations.push({ path: `parameters.${name2}`, message: "must match ^[A-Za-z][A-Za-z0-9_]{0,39}$" });
          continue;
        }
        if (!isFiniteNumber(value)) {
          violations.push({ path: `parameters.${name2}`, message: "must be a finite number" });
          continue;
        }
        parameters[name2] = value;
      }
    }
  }
  if (!Array.isArray(raw.features)) {
    violations.push({ path: "features", message: "is required and must be an array" });
    return reject(violations);
  }
  if (raw.features.length === 0) violations.push({ path: "features", message: "must contain at least one feature" });
  if (raw.features.length > config.limits.maxFeatures) {
    violations.push({ path: "features", message: `at most ${String(config.limits.maxFeatures)} features are allowed` });
  }
  const seen = /* @__PURE__ */ new Set();
  raw.features.forEach((feature2, index) => {
    validateFeature(feature2, `features[${String(index)}]`, parameters, violations, { requireId: true });
    if (isRecord(feature2) && typeof feature2.id === "string") {
      if (seen.has(feature2.id)) violations.push({ path: `features[${String(index)}].id`, message: `duplicate feature id "${feature2.id}"` });
      seen.add(feature2.id);
    }
  });
  if (raw.features.length > 0) {
    const first = raw.features[0];
    if (isRecord(first) && typeof first.op === "string" && !ADDITIVE_OPS.has(first.op)) {
      violations.push({ path: "features[0].op", message: "the first feature must create material (box, cylinder or union)" });
    }
  }
  if (violations.length > 0) return reject(violations);
  return {
    schema: DOCUMENT_SCHEMA2,
    units: "mm",
    ...typeof raw.name === "string" ? { name: raw.name } : {},
    ...typeof raw.description === "string" ? { description: raw.description } : {},
    parameters,
    features: raw.features
  };
}
function resolveNumber(value, parameters) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.startsWith("$")) {
    const resolved = parameters[value.slice(1)];
    return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null;
  }
  return null;
}
function estimateExtent(document2, parameters) {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  let minZ = 0;
  let maxZ = 0;
  let found = false;
  const expand = (cx, cy, cz, sx, sy, sz) => {
    found = true;
    minX = Math.min(minX, cx - sx / 2);
    maxX = Math.max(maxX, cx + sx / 2);
    minY = Math.min(minY, cy - sy / 2);
    maxY = Math.max(maxY, cy + sy / 2);
    minZ = Math.min(minZ, cz - sz / 2);
    maxZ = Math.max(maxZ, cz + sz / 2);
  };
  const applyPrimitive = (shape, op) => {
    const centerRaw = Array.isArray(shape.center) ? shape.center : [];
    const cx = isFiniteNumber(centerRaw[0]) ? centerRaw[0] : 0;
    const cy = isFiniteNumber(centerRaw[1]) ? centerRaw[1] : 0;
    const cz = isFiniteNumber(centerRaw[2]) ? centerRaw[2] : 0;
    const length = resolveNumber(shape.length, parameters);
    const width = resolveNumber(shape.width, parameters);
    const height = resolveNumber(shape.height, parameters);
    const diameter = resolveNumber(shape.diameter, parameters);
    if (op === "box" && length !== null && width !== null && height !== null) {
      expand(cx, cy, cz, length, width, height);
    } else if (op === "cylinder" && diameter !== null && height !== null) {
      const axis = shape.axis === "x" || shape.axis === "y" ? shape.axis : "z";
      if (axis === "z") expand(cx, cy, cz, diameter, diameter, height);
      else if (axis === "x") expand(cx, cy, cz, height, diameter, diameter);
      else expand(cx, cy, cz, diameter, height, diameter);
    }
  };
  for (const feature2 of document2.features) {
    if (typeof feature2.op !== "string") continue;
    if (feature2.op === "box" || feature2.op === "cylinder") {
      applyPrimitive(feature2, feature2.op);
    } else if (feature2.op === "union") {
      const shape = feature2.shape;
      if (isRecord(shape) && (shape.op === "box" || shape.op === "cylinder")) applyPrimitive(shape, shape.op);
    }
  }
  if (!found) return null;
  return { x: Math.abs(maxX - minX), y: Math.abs(maxY - minY), z: Math.abs(maxZ - minZ) };
}
function applyEdit(document2, edit, config) {
  const violations = [];
  const currentParameters = { ...document2.parameters ?? {} };
  const nextParameters = { ...currentParameters };
  if (edit.parameters !== void 0) {
    if (!isRecord(edit.parameters)) {
      violations.push({ path: "parameters", message: "must be an object of name \u2192 number" });
    } else {
      for (const [name2, value] of Object.entries(edit.parameters)) {
        if (!Object.hasOwn(currentParameters, name2)) {
          violations.push({ path: `parameters.${name2}`, message: `unknown parameter "${name2}"` });
          continue;
        }
        if (!isFiniteNumber(value)) {
          violations.push({ path: `parameters.${name2}`, message: "must be a finite number" });
          continue;
        }
        nextParameters[name2] = value;
      }
    }
  }
  if (violations.length > 0) reject(violations, "invalid_argument");
  let features = [...document2.features];
  if (Array.isArray(edit.removeFeatures) && edit.removeFeatures.length > 0) {
    const removals = new Set(edit.removeFeatures);
    for (const id of edit.removeFeatures) {
      if (typeof id !== "string" || id.length === 0) violations.push({ path: "remove_features", message: "entries must be feature ids" });
    }
    const existing = new Set(features.map((feature2) => feature2.id));
    for (const id of removals) {
      if (!existing.has(id)) violations.push({ path: "remove_features", message: `no feature with id "${id}"` });
    }
    features = features.filter((feature2) => !removals.has(feature2.id));
  }
  if (Array.isArray(edit.addFeatures) && edit.addFeatures.length > 0) {
    features = [...features, ...edit.addFeatures];
  }
  if (features.length === 0) violations.push({ path: "features", message: "a document needs at least one feature" });
  if (features.length > config.limits.maxFeatures) {
    violations.push({ path: "features", message: `at most ${String(config.limits.maxFeatures)} features are allowed` });
  }
  if (violations.length > 0) reject(violations, "invalid_argument");
  const candidate = {
    ...document2,
    parameters: nextParameters,
    features,
    ...edit.name !== void 0 ? { name: edit.name } : {},
    ...edit.description !== void 0 ? { description: edit.description } : {}
  };
  let normalized;
  try {
    normalized = validateDocument(candidate, config);
  } catch (error) {
    if (error instanceof Error && "details" in error) {
      const details = error.details ?? {};
      throw new CadError2("invalid_argument", error.message, details);
    }
    throw error;
  }
  checkFeasibility(normalized, violations);
  if (violations.length > 0) reject(violations, "invalid_argument");
  return normalized;
}
function checkFeasibility(document2, violations) {
  const parameters = { ...document2.parameters ?? {} };
  const extent = estimateExtent(document2, parameters);
  document2.features.forEach((feature2, index) => {
    const path = `features[${String(index)}]`;
    const op = feature2.op;
    const shape = isRecord(feature2.shape) ? feature2.shape : null;
    if (op === "hole") {
      const diameter = resolveNumber(feature2.diameter, parameters);
      if (diameter !== null && extent !== null) {
        const limit = feature2.axis === "x" ? extent.y : feature2.axis === "y" ? extent.x : Math.min(extent.x, extent.y);
        if (limit > 0 && diameter >= limit) {
          violations.push({ path: `${path}.diameter`, message: `\xD8${String(diameter)} mm does not fit in the part (${String(limit)} mm)` });
        }
      }
      if (feature2.through === false) {
        const depth = resolveNumber(feature2.depth, parameters);
        const height = extent === null ? null : feature2.axis === "x" ? extent.x : feature2.axis === "y" ? extent.y : extent.z;
        if (depth !== null && height !== null && depth > height) {
          violations.push({ path: `${path}.depth`, message: `depth ${String(depth)} mm exceeds the part (${String(height)} mm)` });
        }
      }
    } else if (op === "hole_pattern") {
      const diameter = resolveNumber(feature2.diameter, parameters);
      if (diameter === null) return;
      if (feature2.pattern === "rect_corners") {
        const inset = resolveNumber(feature2.inset, parameters);
        if (inset !== null && diameter > inset * 2) {
          violations.push({ path: `${path}.diameter`, message: `\xD8${String(diameter)} mm needs inset \u2265 ${String(diameter / 2)} mm` });
        }
        const span = Array.isArray(feature2.span) ? feature2.span : null;
        const spanX = span === null ? extent?.x ?? null : resolveNumber(span[0], parameters);
        const spanY = span === null ? extent?.y ?? null : resolveNumber(span[1], parameters);
        if (inset !== null && spanX !== null && spanY !== null && (inset * 2 >= spanX || inset * 2 >= spanY)) {
          violations.push({ path: `${path}.inset`, message: "two insets must leave room between the corner holes" });
        }
      } else if (feature2.pattern === "bolt_circle") {
        const pitch = resolveNumber(feature2.pitch_diameter, parameters);
        if (pitch !== null && pitch <= diameter) {
          violations.push({ path: `${path}.pitch_diameter`, message: "pitch diameter must exceed the hole diameter" });
        }
        if (pitch !== null && extent !== null && pitch / 2 + diameter / 2 > Math.min(extent.x, extent.y) / 2) {
          violations.push({ path: `${path}.pitch_diameter`, message: "bolt circle does not fit inside the part" });
        }
      }
    } else if ((op === "cut" || op === "union") && shape !== null) {
      if (op === "cut" && extent !== null && shape.op === "box") {
        const length = resolveNumber(shape.length, parameters);
        const width = resolveNumber(shape.width, parameters);
        if (length !== null && width !== null && (length > extent.x || width > extent.y)) {
          violations.push({ path: `${path}.shape`, message: "cut box is larger than the part" });
        }
      }
    }
  });
}

// src/host/store.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, stat as stat2, unlink } from "node:fs/promises";
import { mkdir as mkdir3 } from "node:fs/promises";
import { dirname as dirname2, join as join4 } from "node:path";
var MODEL_SCHEMA = "dsh.cad/model@1";
var REVISION_SCHEMA = "dsh.cad/revision@1";
var REQUESTS_VERSION = 1;
var MAX_REQUEST_RECORDS = 1e3;
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newModelId() {
  return `m-${randomBytes(5).toString("hex")}`;
}
function stableJson(value) {
  return JSON.stringify(value, (_key, inner) => {
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      const ordered = {};
      for (const key of Object.keys(inner).sort()) {
        ordered[key] = inner[key];
      }
      return ordered;
    }
    return inner;
  }, 2);
}
function normalizeRuntimeArtifact(raw, limits) {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw;
  const format = record.format;
  if (typeof format !== "string" || !Object.hasOwn(ARTIFACT_FORMAT_FILES, format)) return null;
  const fileName = typeof record.fileName === "string" && record.fileName !== "" ? record.fileName : ARTIFACT_FORMAT_FILES[format];
  if (fileName.length > limits.maxArtifactNameLength) return null;
  if (ARTIFACT_FILE_NAMES[fileName] !== format) return null;
  const bytes = record.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 134217728) return null;
  const sha256 = record.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) return null;
  return { format, fileName, bytes, sha256 };
}
function summarizeChecks(checks) {
  const counts = { pass: 0, fail: 0, warn: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}
function summarizeReport(report) {
  if (report === null) return null;
  const totalMs = typeof report.timings.totalMs === "number" && Number.isFinite(report.timings.totalMs) ? report.timings.totalMs : null;
  return {
    volume: report.volume,
    boundingBoxSize: report.boundingBox === null ? null : report.boundingBox.size,
    checks: summarizeChecks(report.checks),
    totalMs
  };
}
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function tupleOrNull(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const numbers = value.map((entry) => finiteOrNull(entry));
  if (numbers.some((entry) => entry === null)) return null;
  return numbers;
}
function sanitizeReport(raw, valid = true) {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw;
  const bboxRaw = record.boundingBox;
  const bbox = bboxRaw !== null && typeof bboxRaw === "object" ? (() => {
    const box = bboxRaw;
    const min = tupleOrNull(box.min);
    const max = tupleOrNull(box.max);
    const size = tupleOrNull(box.size);
    if (min === null || max === null || size === null) return null;
    return { min, max, size };
  })() : null;
  const topologyRaw = record.topology !== null && typeof record.topology === "object" ? record.topology : null;
  const topology = topologyRaw === null ? null : {
    faces: finiteOrNull(topologyRaw.faces) ?? 0,
    edges: finiteOrNull(topologyRaw.edges) ?? 0,
    vertices: finiteOrNull(topologyRaw.vertices) ?? 0,
    solids: finiteOrNull(topologyRaw.solids) ?? 0
  };
  const checks = Array.isArray(record.checks) ? record.checks.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const check = entry;
    const status = check.status;
    if (status !== "pass" && status !== "fail" && status !== "warn") return [];
    return [{
      id: typeof check.id === "string" ? check.id : "unknown",
      status,
      message: typeof check.message === "string" ? check.message : ""
    }];
  }) : [];
  const featureReportsRaw = Array.isArray(record.featureReports) ? record.featureReports : [];
  const featureReports = featureReportsRaw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const feature2 = entry;
    const status = feature2.status;
    if (status !== "pass" && status !== "fail" && status !== "warn") return [];
    return [{
      id: typeof feature2.id === "string" ? feature2.id : "unknown",
      op: typeof feature2.op === "string" ? feature2.op : "unknown",
      status,
      detail: typeof feature2.detail === "string" ? feature2.detail : ""
    }];
  });
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter((entry) => typeof entry === "string").slice(0, 64) : [];
  const timings = {};
  if (record.timings !== null && typeof record.timings === "object") {
    for (const [key, value] of Object.entries(record.timings)) {
      const number = finiteOrNull(value);
      if (number !== null) timings[key] = number;
    }
  }
  return {
    valid,
    volume: finiteOrNull(record.volume),
    surfaceArea: finiteOrNull(record.surfaceArea),
    boundingBox: bbox,
    bbox,
    centroid: tupleOrNull(record.centroid),
    topology,
    checks,
    featureReports,
    warnings,
    timings
  };
}
function sanitizeRevisionError(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw;
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  const details = record.details !== null && typeof record.details === "object" && !Array.isArray(record.details) ? record.details : void 0;
  return { code: record.code, message: record.message, ...details === void 0 ? {} : { details } };
}
var CadStore = class {
  /** Absolute store root (`<dataDir>`). */
  root;
  limits;
  log;
  locks = /* @__PURE__ */ new Map();
  /** `${modelId}:${number}` of revisions allocated but not yet settled on disk. */
  pendingAllocations = /* @__PURE__ */ new Set();
  requestCache = /* @__PURE__ */ new Map();
  readyPromise = null;
  constructor(options) {
    this.root = options.root;
    this.limits = options.limits;
    this.log = options.log ?? (() => void 0);
  }
  /** Create the store root once; every public method awaits this. */
  async ready() {
    this.readyPromise ??= mkdir3(this.root, { recursive: true }).then(() => void 0);
    await this.readyPromise;
  }
  /** Absolute path of the models root. */
  modelsRoot() {
    return join4(this.root, "models");
  }
  /** Absolute path of one model directory (validated id only). */
  modelDirectory(modelId2) {
    return join4(this.root, "models", assertModelId(modelId2));
  }
  /** Absolute path of one revision directory. */
  revisionDirectory(modelId2, revisionId2) {
    return join4(this.modelDirectory(modelId2), "revisions", assertRevisionId(revisionId2));
  }
  /** Absolute path of the preview cache directory of one revision. */
  previewDirectory(modelId2, revisionId2) {
    return join4(this.modelDirectory(modelId2), "previews", assertRevisionId(revisionId2));
  }
  /**
   * Serialize work per key (one model, or the global request index).
   * @param key - lock key.
   * @param task - work to run exclusively.
   * @returns the task result.
   */
  async withLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve4) => {
      release = resolve4;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous.catch(() => void 0);
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
  /** Write bytes atomically: tmp file → fsync → rename. */
  async writeAtomic(target, data) {
    const directory = dirname2(target);
    await mkdir3(directory, { recursive: true });
    const temporary = join4(directory, `.tmp-${randomUUID()}`);
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => void 0);
      throw error;
    }
  }
  /** Read and parse a JSON file, mapping ENOENT to null. */
  async readJson(path) {
    try {
      const text = await readFile(path, "utf8");
      return JSON.parse(text);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  // ---------------------------------------------------------------- requests
  /** Read the root-level request index (bounded; caps prune oldest). */
  async readRequestIndex() {
    const file = await this.readJson(join4(this.root, "requests.json"));
    if (file === null || file.version !== REQUESTS_VERSION || file.entries === null || typeof file.entries !== "object") {
      return { version: REQUESTS_VERSION, entries: {} };
    }
    return file;
  }
  /** Resolve a request id to the model+revision it created, or null. */
  async lookupRequest(requestId2) {
    const cached = this.requestCache.get(requestId2);
    if (cached !== void 0) return cached;
    await this.ready();
    const index = await this.readRequestIndex();
    const entry = index.entries[requestId2];
    if (entry === void 0) return null;
    this.requestCache.set(requestId2, entry);
    return entry;
  }
  /** Record one request id atomically (called inside the model lock). */
  async recordRequest(requestId2, entry) {
    this.requestCache.set(requestId2, entry);
    await this.withLock("requests", async () => {
      const index = await this.readRequestIndex();
      index.entries[requestId2] = entry;
      const keys = Object.keys(index.entries);
      if (keys.length > MAX_REQUEST_RECORDS) {
        keys.sort((left, right) => index.entries[left].at < index.entries[right].at ? -1 : 1);
        for (const key of keys.slice(0, keys.length - MAX_REQUEST_RECORDS)) {
          delete index.entries[key];
          this.requestCache.delete(key);
        }
      }
      await this.writeAtomic(join4(this.root, "requests.json"), JSON.stringify(index));
    });
  }
  // ------------------------------------------------------------------ models
  /** Read one model index, or throw `not_found`. */
  async readModel(modelId2) {
    await this.ready();
    const id = assertModelId(modelId2);
    const target = await safePath(this.root, ["models", id, "model.json"]);
    const index = await this.readJson(target);
    if (index === null) {
      throw new CadError2("not_found", `model ${id} does not exist`, { modelId: id });
    }
    return index;
  }
  /** Read one model index and its document for `revisionNumber` (default current). */
  async readDocument(modelId2, revisionNumber) {
    const index = await this.readModel(modelId2);
    const number = revisionNumber ?? (index.currentRevision > 0 ? index.currentRevision : index.latestRevision);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new CadError2("not_found", `model ${modelId2} has no revision`, { modelId: modelId2 });
    }
    const revisionId2 = revisionIdOf(number);
    const target = await safePath(this.root, ["models", index.id, "revisions", revisionId2, "document.json"]);
    const document2 = await this.readJson(target);
    if (document2 === null) {
      throw new CadError2("not_found", `revision ${revisionId2} of model ${modelId2} has no document`, { modelId: modelId2, revisionId: revisionId2 });
    }
    return { document: document2, number, revisionId: revisionId2 };
  }
  /** Read revision metadata (`revision.json`) and report. */
  async readRevision(modelId2, revisionId2) {
    const index = await this.readModel(modelId2);
    const id = assertRevisionId(revisionId2);
    const base = ["models", index.id, "revisions", id];
    const meta = await this.readJson(await safePath(this.root, [...base, "revision.json"]));
    if (meta === null) {
      const exists = index.revisions.some((revision2) => revision2.revisionId === id);
      throw new CadError2("not_found", exists ? `revision ${id} is not complete yet` : `revision ${id} does not exist`, { modelId: modelId2, revisionId: id });
    }
    const document2 = await this.readJson(await safePath(this.root, [...base, "document.json"]));
    const report = await this.readJson(await safePath(this.root, [...base, "report.json"]));
    if (document2 === null) {
      throw new CadError2("not_found", `revision ${id} of model ${modelId2} has no document`, { modelId: modelId2, revisionId: id });
    }
    return { meta, document: document2, report };
  }
  /** Every model index in the store (no ownership fence: single-user desktop). */
  async listModels() {
    await this.ready();
    const root = this.modelsRoot();
    await mkdir3(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const models = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        if (!/^m-[0-9a-f]{10}$/u.test(entry.name)) continue;
        models.push(await this.readModel(entry.name));
      } catch (error) {
        this.log(`store: skipping unreadable model ${entry.name}`, error);
      }
    }
    models.sort((left, right) => left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0);
    return models;
  }
  /** Write the model index atomically. */
  async writeModel(index) {
    const target = await safePath(this.root, ["models", index.id], { createParent: true, kind: "dir" });
    const path = join4(target, "model.json");
    await this.writeAtomic(path, `${stableJson(index)}
`);
  }
  /** Build the initial (empty) model index. */
  emptyIndex(modelId2, input) {
    const at = nowIso();
    return {
      schema: MODEL_SCHEMA,
      id: modelId2,
      modelId: modelId2,
      name: input.name,
      description: input.description,
      createdAt: at,
      updatedAt: at,
      currentRevision: 0,
      latestRevision: 0,
      nextRevision: 1,
      revisions: [],
      requests: {},
      metadata: {},
      ownerSession: input.ownerSession,
      owner: { sessionId: input.ownerSession }
    };
  }
  /**
   * Create a model and allocate its first (unbuilt) revision in one transaction.
   * @param input - model identity, document snapshot and idempotency key.
   * @returns the index plus the revision allocation.
   */
  async createModel(input) {
    await this.ready();
    return this.withLock("create", async () => {
      if (input.requestId !== null) {
        const existing = await this.lookupRequest(input.requestId);
        if (existing !== null) {
          const index2 = await this.readModel(existing.modelId);
          const revision2 = index2.revisions.find((entry) => entry.number === existing.number);
          const documentRead = await this.readDocument(existing.modelId, existing.number).catch(() => null);
          if (revision2 !== void 0 && documentRead !== null) {
            return {
              index: index2,
              duplicate: true,
              allocation: {
                number: revision2.number,
                revisionId: revision2.revisionId,
                document: documentRead.document,
                documentSha256: revision2.documentSha256,
                formats: revision2.artifacts.map((artifact) => artifact.format),
                duplicate: true
              }
            };
          }
        }
      }
      await mkdir3(this.modelsRoot(), { recursive: true });
      let modelId2 = newModelId();
      let created = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await mkdir3(join4(this.modelsRoot(), modelId2), { recursive: false });
          created = true;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          modelId2 = newModelId();
        }
      }
      if (!created) throw new CadError2("internal", "could not allocate a model id");
      const index = this.emptyIndex(modelId2, input);
      const allocation = await this.allocateLocked(index, {
        document: input.document,
        kind: "create",
        requestId: input.requestId,
        expectedRevision: 0,
        formats: input.formats
      });
      return { index: allocation.index, allocation: allocation.allocation, duplicate: false };
    });
  }
  /**
   * Allocate the next revision of an existing model and persist its document.
   * @param input - edit outcome and concurrency/idempotency keys.
   * @returns the updated index plus the allocation.
   */
  async allocateRevision(input) {
    const modelId2 = assertModelId(input.modelId);
    return this.withLock(`model:${modelId2}`, async () => {
      if (input.requestId !== null) {
        const existing = await this.lookupRequest(input.requestId);
        if (existing !== null) {
          const index2 = await this.readModel(modelId2);
          const revision2 = index2.revisions.find((entry) => entry.number === existing.number);
          const documentRead = await this.readDocument(modelId2, existing.number).catch(() => null);
          if (revision2 !== void 0 && documentRead !== null) {
            return {
              index: index2,
              duplicate: true,
              allocation: {
                number: revision2.number,
                revisionId: revision2.revisionId,
                document: documentRead.document,
                documentSha256: revision2.documentSha256,
                formats: revision2.artifacts.map((artifact) => artifact.format),
                duplicate: true
              }
            };
          }
          throw new CadError2("not_found", `request ${input.requestId} references a revision that no longer exists`, { modelId: modelId2, revisionId: existing.number });
        }
      }
      const index = await this.readModel(modelId2);
      const inFlight = [...this.pendingAllocations].find((key) => key.startsWith(`${modelId2}:`));
      if (inFlight !== void 0) {
        throw new CadError2("model_locked", `another write is still in flight for model ${modelId2}; inspect and retry`, {
          modelId: modelId2,
          pendingRevisionId: revisionIdOf(Number(inFlight.slice(modelId2.length + 1))),
          currentRevision: index.currentRevision,
          latestRevision: index.latestRevision
        });
      }
      const latest = index.revisions.find((entry) => entry.number === index.latestRevision);
      const allowed = /* @__PURE__ */ new Set([index.currentRevision]);
      if (latest !== void 0 && latest.status === "failed") allowed.add(latest.number);
      if (latest !== void 0 && latest.status === "unbuilt" && latest.number === input.expectedRevision) allowed.add(latest.number);
      if (!allowed.has(input.expectedRevision)) {
        const pending = latest !== void 0 && latest.status === "unbuilt";
        throw new CadError2(
          pending ? "model_locked" : "revision_conflict",
          pending ? `another write is still in flight for model ${modelId2} (revision ${latest.revisionId}); inspect and retry` : `expected revision ${String(input.expectedRevision)} but the model is at ${String(index.currentRevision)}`,
          {
            modelId: modelId2,
            expectedRevision: input.expectedRevision,
            currentRevision: index.currentRevision,
            latestRevision: index.latestRevision,
            ...pending ? { pendingRevisionId: latest.revisionId } : {}
          }
        );
      }
      return this.allocateLocked(index, input);
    });
  }
  /** Allocate a revision inside an already-held model lock. */
  async allocateLocked(index, input) {
    const number = index.nextRevision;
    const revisionId2 = revisionIdOf(number);
    const documentBytes = Buffer.from(`${stableJson({ ...input.document, schema: DOCUMENT_SCHEMA2 })}
`, "utf8");
    const documentSha256 = sha256Hex(documentBytes);
    const base = ["models", index.id, "revisions", revisionId2];
    const revisionDir = await safePath(this.root, base, { createParent: true, kind: "dir" });
    await this.writeAtomic(join4(revisionDir, "document.json"), documentBytes);
    const at = nowIso();
    const summary = {
      number,
      revisionId: revisionId2,
      status: "unbuilt",
      createdAt: at,
      builtAt: null,
      documentSha256,
      artifacts: [],
      errorCode: null,
      reportSummary: null
    };
    const next = {
      ...index,
      updatedAt: at,
      latestRevision: number,
      nextRevision: number + 1,
      revisions: [...index.revisions, summary],
      requests: input.requestId === null ? index.requests : { ...index.requests, [input.requestId]: { number, kind: input.kind, at } }
    };
    await this.writeModel(next);
    this.pendingAllocations.add(`${index.id}:${number}`);
    if (input.requestId !== null) {
      await this.recordRequest(input.requestId, { modelId: index.id, number, kind: input.kind, at });
    }
    return {
      index: next,
      duplicate: false,
      allocation: {
        number,
        revisionId: revisionId2,
        document: { ...input.document, schema: DOCUMENT_SCHEMA2 },
        documentSha256,
        formats: input.formats,
        duplicate: false
      }
    };
  }
  /**
   * Verify runtime-declared artifacts against the bytes actually written.
   *
   * A hostile or buggy runtime cannot poison the store: each declaration must
   * name one of the fixed artifact files of its format, live directly in the
   * revision directory as a regular non-symlink file, and match both its byte
   * size and sha256.
   * @param modelId - model id.
   * @param revisionId - revision id (already allocated, directory exists).
   * @param declared - runtime artifact declarations.
   * @returns verified artifact metadata, in the runtime's order.
   * @throws {CadError} `build_failed` when a declaration does not match its file.
   */
  async verifyArtifacts(modelId2, revisionId2, declared, maxArtifactBytes) {
    return this.verifyDeclaredArtifacts(["models", modelId2, "revisions", revisionId2], declared, maxArtifactBytes);
  }
  /**
   * Generic artifact verifier for any directory inside the store (revision
   * artifacts, derived export caches, preview caches).
   * @param baseSegments - directory segments under the store root.
   * @param declared - runtime artifact declarations.
   * @param maxArtifactBytes - per-file byte cap.
   * @returns verified artifact metadata in declaration order.
   */
  async verifyDeclaredArtifacts(baseSegments, declared, maxArtifactBytes) {
    if (!Array.isArray(declared)) return [];
    const verified = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of declared) {
      const artifact = normalizeRuntimeArtifact(entry, this.limits);
      if (artifact === null) {
        throw new CadError2("build_failed", "the runtime declared an artifact with an invalid shape", {
          artifact: entry
        });
      }
      if (seen.has(artifact.fileName)) {
        throw new CadError2("build_failed", `the runtime declared artifact ${artifact.fileName} twice`);
      }
      seen.add(artifact.fileName);
      if (artifact.bytes > maxArtifactBytes) {
        throw new CadError2("too_large", `artifact ${artifact.fileName} exceeds maxArtifactBytes (${String(maxArtifactBytes)})`, {
          fileName: artifact.fileName,
          bytes: artifact.bytes,
          maxArtifactBytes
        });
      }
      const target = await safePath(this.root, [...baseSegments, artifact.fileName]);
      const info = await stat2(target).catch(() => null);
      if (info === null || !info.isFile()) {
        throw new CadError2("build_failed", `the runtime declared ${artifact.fileName} but did not write a regular file there`, {
          fileName: artifact.fileName
        });
      }
      if (info.size !== artifact.bytes) {
        throw new CadError2("build_failed", `artifact ${artifact.fileName} is ${String(info.size)} bytes but the runtime declared ${String(artifact.bytes)}`, {
          fileName: artifact.fileName,
          bytes: info.size,
          declaredBytes: artifact.bytes
        });
      }
      const bytes = await readFile(target);
      const actual = sha256Hex(bytes);
      if (actual !== artifact.sha256) {
        throw new CadError2("build_failed", `artifact ${artifact.fileName} does not match its declared sha256`, {
          fileName: artifact.fileName,
          sha256: actual,
          declaredSha256: artifact.sha256
        });
      }
      const contentType = contentTypeForFileName(artifact.fileName) ?? "application/octet-stream";
      verified.push({ format: artifact.format, fileName: artifact.fileName, bytes: info.size, sha256: actual, contentType });
    }
    return verified;
  }
  /**
   * Persist the outcome of one build into its already-allocated revision and
   * move the current pointer when it succeeded.
   * @param input - revision identity plus the build outcome.
   * @returns the updated model index.
   */
  async completeBuild(input) {
    const modelId2 = assertModelId(input.modelId);
    return this.withLock(`model:${modelId2}`, async () => {
      const index = await this.readModel(modelId2);
      const summary = index.revisions.find((entry) => entry.number === input.number);
      if (summary === void 0) {
        throw new CadError2("internal", `revision ${input.revisionId} was never allocated`, { modelId: modelId2, revisionId: input.revisionId });
      }
      const completion = input.completion;
      const meta = {
        schema: REVISION_SCHEMA,
        modelId: modelId2,
        revisionId: input.revisionId,
        number: input.number,
        status: completion.status,
        createdAt: summary.createdAt,
        builtAt: nowIso(),
        buildRequestId: input.buildRequestId,
        buildKind: input.buildKind,
        documentSha256: input.documentSha256,
        formats: input.formats,
        durationMs: completion.durationMs,
        report: completion.report,
        error: completion.error,
        warnings: completion.warnings,
        artifacts: completion.artifacts,
        ownerSession: input.ownerSession,
        buildId: completion.buildId
      };
      const base = ["models", modelId2, "revisions", input.revisionId];
      await this.writeAtomic(join4(await safePath(this.root, base), "revision.json"), `${stableJson(meta)}
`);
      if (completion.report !== null) {
        await this.writeAtomic(join4(await safePath(this.root, base), "report.json"), `${stableJson(completion.report)}
`);
      }
      const nextSummary = {
        number: input.number,
        revisionId: input.revisionId,
        status: completion.status,
        createdAt: summary.createdAt,
        builtAt: meta.builtAt,
        documentSha256: input.documentSha256,
        artifacts: completion.artifacts,
        errorCode: completion.error === null ? null : completion.error.code,
        reportSummary: summarizeReport(completion.report)
      };
      const revisions = index.revisions.map((entry) => entry.number === input.number ? nextSummary : entry);
      const currentRevision = completion.status === "built" ? input.number : index.currentRevision;
      const next = {
        ...index,
        updatedAt: nowIso(),
        currentRevision,
        revisions
      };
      await this.writeModel(next);
      this.pendingAllocations.delete(`${modelId2}:${input.number}`);
      return next;
    });
  }
  /**
   * Persist an allocated revision without building it (`build:false`), so the
   * revision is readable and later rebuildable but never appears as current.
   * @param input - revision identity and document digest.
   * @returns the unchanged model index.
   */
  async markUnbuilt(input) {
    const modelId2 = assertModelId(input.modelId);
    return this.withLock(`model:${modelId2}`, async () => {
      const index = await this.readModel(modelId2);
      const summary = index.revisions.find((entry) => entry.number === input.number);
      if (summary === void 0) {
        throw new CadError2("internal", `revision ${input.revisionId} was never allocated`, { modelId: modelId2, revisionId: input.revisionId });
      }
      const meta = {
        schema: REVISION_SCHEMA,
        modelId: modelId2,
        revisionId: input.revisionId,
        number: input.number,
        status: "unbuilt",
        createdAt: summary.createdAt,
        builtAt: null,
        buildRequestId: input.buildRequestId,
        buildKind: input.buildKind,
        documentSha256: input.documentSha256,
        formats: input.formats,
        durationMs: null,
        report: null,
        error: null,
        warnings: [],
        artifacts: [],
        ownerSession: input.ownerSession,
        buildId: null
      };
      const base = ["models", modelId2, "revisions", input.revisionId];
      await this.writeAtomic(join4(await safePath(this.root, base), "revision.json"), `${stableJson(meta)}
`);
      this.pendingAllocations.delete(`${modelId2}:${input.number}`);
      return index;
    });
  }
  /** Release the in-flight write fence of one allocation (crash-safe cleanup). */
  releasePending(modelId2, number) {
    this.pendingAllocations.delete(`${modelId2}:${number}`);
  }
  /** Remove every file the runtime wrote in a revision directory except the document. */
  async clearRevisionArtifacts(modelId2, revisionId2, formats2) {
    for (const format of formats2) {
      const fileName = ARTIFACT_FORMAT_FILES[format];
      if (fileName === void 0) continue;
      const target = await safePath(this.root, ["models", assertModelId(modelId2), "revisions", assertRevisionId(revisionId2), fileName]).catch(() => null);
      if (target !== null) await unlink(target).catch(() => void 0);
    }
  }
  /** Write one derived preview into the non-authoritative preview cache. */
  async writePreview(modelId2, revisionId2, fileName, bytes) {
    assertSegment(fileName, "preview file name");
    if (fileName !== "preview.svg") {
      throw new CadError2("invalid_argument", "only preview.svg is produced by cad_render_preview", { fileName });
    }
    const directory = await safePath(this.root, ["models", assertModelId(modelId2), "previews", assertRevisionId(revisionId2)], { createParent: true, kind: "dir" });
    const target = join4(directory, fileName);
    await this.writeAtomic(target, bytes);
    return target;
  }
  /** Read verified artifact bytes for the API asset route. */
  async readArtifact(modelId2, revisionId2, fileName) {
    const contentType = contentTypeForFileName(fileName);
    if (contentType === null) {
      throw new CadError2("not_found", `unsupported artifact ${JSON.stringify(fileName)}`, { fileName });
    }
    const target = await safePath(this.root, ["models", assertModelId(modelId2), "revisions", assertRevisionId(revisionId2), fileName]);
    const bytes = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") {
        throw new CadError2("not_found", `artifact ${fileName} does not exist for revision ${revisionId2}`, { modelId: modelId2, revisionId: revisionId2, fileName });
      }
      throw error;
    });
    const info = await stat2(target).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new CadError2("not_found", `artifact ${fileName} is not a regular file`, { fileName });
    }
    return { bytes, contentType, sha256: sha256Hex(bytes) };
  }
  /** Read a derived preview file (same traversal protection as artifacts). */
  async readPreview(modelId2, revisionId2, fileName) {
    if (fileName !== "preview.svg") {
      throw new CadError2("not_found", `unsupported preview ${JSON.stringify(fileName)}`, { fileName });
    }
    const target = await safePath(this.root, ["models", assertModelId(modelId2), "previews", assertRevisionId(revisionId2), fileName]);
    const bytes = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") {
        throw new CadError2("not_found", `no cached preview for revision ${revisionId2}`, { modelId: modelId2, revisionId: revisionId2 });
      }
      throw error;
    });
    return { bytes, contentType: "image/svg+xml", sha256: sha256Hex(bytes) };
  }
  /**
   * Ensure a directory inside the store exists, with symlink-escape protection.
   * @param segments - validated segments under the store root.
   * @returns the absolute directory path.
   */
  async ensureStoreDirectory(segments) {
    await this.ready();
    return safePath(this.root, segments, { createParent: true, kind: "dir" });
  }
  /** Read a file inside the store, mapping ENOENT to `not_found`. */
  async readStoreFile(segments) {
    const target = await safePath(this.root, segments);
    return readFile(target).catch((error) => {
      if (error.code === "ENOENT") {
        throw new CadError2("not_found", "file does not exist in the CAD store", { segments });
      }
      throw error;
    });
  }
  /**
   * Update the mutable identity fields of a model (name/description).
   * @param modelId - model id.
   * @param identity - replacement name and description.
   * @returns the updated index.
   */
  async updateModelIdentity(modelId2, identity) {
    const id = assertModelId(modelId2);
    return this.withLock(`model:${id}`, async () => {
      const index = await this.readModel(id);
      const next = {
        ...index,
        name: identity.name,
        description: identity.description,
        updatedAt: nowIso()
      };
      await this.writeModel(next);
      return next;
    });
  }
  /** Number of models currently stored (health/diagnostics). */
  async countModels() {
    await this.ready();
    const entries = await readdir(this.modelsRoot(), { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && /^m-[0-9a-f]{10}$/u.test(entry.name)).length;
  }
  /** Absolute path inside the store, for diagnostics only. */
  debugPath(...segments) {
    const target = join4(this.root, ...segments);
    return isInside(this.root, target) ? target : this.root;
  }
};

// src/host/service.ts
var API_PREFIX = "/dsh-plugin-cad/api";
var ASSET_PREFIX = "/dsh-plugin-cad/assets";
var DEFAULT_FORMATS = ["step", "glb"];
function artifactRef(modelId2, revisionId2, meta) {
  return {
    artifactId: `${modelId2}:${revisionId2}:${meta.format}`,
    format: meta.format,
    fileName: meta.fileName,
    bytes: meta.bytes,
    sha256: meta.sha256,
    contentType: meta.contentType,
    url: `${ASSET_PREFIX}/models/${modelId2}/${revisionId2}/${meta.fileName}`
  };
}
function previewRef(modelId2, revisionId2, meta) {
  return {
    artifactId: `${modelId2}:${revisionId2}:${meta.format}`,
    format: meta.format,
    fileName: meta.fileName,
    bytes: meta.bytes,
    sha256: meta.sha256,
    contentType: meta.contentType,
    url: `${ASSET_PREFIX}/models/${modelId2}/previews/${revisionId2}/${meta.fileName}`
  };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clampLimit(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}
function latestStatusOf(index) {
  if (index.latestRevision === 0) return "empty";
  const summary = index.revisions.find((entry) => entry.number === index.latestRevision);
  return summary?.status ?? "empty";
}
var CadService = class {
  config;
  store;
  runtime;
  log;
  jobStats;
  modelQueues = /* @__PURE__ */ new Map();
  activeBuilds = 0;
  buildWaiters = [];
  constructor(options) {
    this.config = options.config;
    this.store = options.store;
    this.runtime = options.runtime;
    this.log = options.log ?? (() => void 0);
    this.jobStats = options.jobStats ?? (() => ({ active: 0 }));
  }
  /** Expose the runtime for the tools' status action and the API health route. */
  get runtimeSupervisor() {
    return this.runtime;
  }
  /** Expose the store for artifacts and diagnostics. */
  get modelStore() {
    return this.store;
  }
  // ------------------------------------------------------------------ health
  /** Health payload for `/api/health` and `cad_runtime_status`. */
  async health() {
    const [status, modelCount] = await Promise.all([
      Promise.resolve(this.runtime.status()),
      this.store.countModels().catch(() => 0)
    ]);
    return {
      ok: true,
      plugin: PLUGIN_ID,
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION2,
      runtime: status,
      store: {
        dataDir: this.config.dataDir,
        modelCount,
        writable: this.config.allowModelWrite,
        exportAllowed: this.config.allowExport
      },
      jobs: this.jobStats(),
      time: nowIso()
    };
  }
  /** Verbose runtime diagnostics (`cad_runtime_status {verbose:true}`). */
  runtimeDiagnostics() {
    return this.runtime.diagnostics();
  }
  /**
   * Probe or repair the runtime. `repair` never installs anything unless
   * `allowRuntimeInstall` is enabled explicitly (Lead decision, SPEC_P0 §8).
   * @param action - `status` (probe only) or `repair` (restart + re-resolve).
   */
  async runtimeStatus(action) {
    if (action === "status") {
      const health = await this.runtime.health();
      return { ok: true, ...this.healthSnapshot(health) };
    }
    const notes = this.runtime.reResolve();
    let repairError = null;
    try {
      await this.runtime.restart("cad_runtime_status repair");
    } catch (error) {
      repairError = error;
    }
    if (repairError === null) {
      const health = await this.runtime.health();
      return { ok: true, repaired: true, notes, ...this.healthSnapshot(health) };
    }
    return {
      ok: false,
      repaired: false,
      notes,
      ...this.healthSnapshot(await this.runtime.health()),
      error: {
        code: "runtime_unavailable",
        message: repairError instanceof Error ? repairError.message : String(repairError),
        details: {
          installCommand: "node python/setup-runtime.mjs",
          allowRuntimeInstall: this.config.allowRuntimeInstall,
          notes
        }
      }
    };
  }
  /** Flatten a runtime health probe into the status payload. */
  healthSnapshot(health) {
    const status = this.runtime.status();
    return {
      available: status.available && health.ok !== false,
      runtime: status,
      probe: isRecord2(health.health) ? health.health : null,
      error: health.ok === false ? health.error ?? status.lastError : null
    };
  }
  // ------------------------------------------------------------------ models
  /** Summaries for `cad_list_models` and `GET /api/models`. */
  async listModels(input = {}) {
    const limit = clampLimit(input.limit, 1, this.config.limits.maxModelsListed, 50);
    const includeFailed = input.includeFailed === true;
    const indexes = await this.store.listModels();
    const models = indexes.filter((index) => includeFailed || latestStatusOf(index) !== "failed").slice(0, limit).map((index) => this.modelSummary(index));
    return models;
  }
  /** Compact model summary (no document read). */
  modelSummary(index) {
    const current = index.revisions.find((entry) => entry.number === index.currentRevision);
    const latestStatus = latestStatusOf(index);
    return {
      modelId: index.id,
      name: index.name,
      description: index.description,
      units: "mm",
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      currentRevision: index.currentRevision,
      currentRevisionId: current?.revisionId ?? null,
      latestRevision: index.latestRevision,
      latestRevisionId: index.revisions.find((entry) => entry.number === index.latestRevision)?.revisionId ?? null,
      latestStatus,
      revisionCount: index.revisions.length,
      failing: latestStatus === "failed",
      report: current?.reportSummary ?? null,
      artifacts: (current?.artifacts ?? []).map((artifact) => artifactRef(index.id, current.revisionId, artifact))
    };
  }
  /** Resolve a revision id/number against an index. */
  resolveRevision(index, revision2) {
    if (typeof revision2 === "number" && Number.isFinite(revision2)) {
      const summary = index.revisions.find((entry) => entry.number === revision2);
      if (summary === void 0) throw new CadError2("not_found", `revision ${String(revision2)} does not exist`, { modelId: index.id });
      return summary;
    }
    if (typeof revision2 === "string" && revision2 !== "") {
      const summary = index.revisions.find((entry) => entry.revisionId === revision2);
      if (summary === void 0) throw new CadError2("not_found", `revision ${revision2} does not exist`, { modelId: index.id });
      return summary;
    }
    if (index.currentRevision > 0) {
      const current = index.revisions.find((entry) => entry.number === index.currentRevision);
      if (current !== void 0) return current;
    }
    const latest = index.revisions.find((entry) => entry.number === index.latestRevision);
    if (latest === void 0) throw new CadError2("not_found", `model ${index.id} has no revision`, { modelId: index.id });
    return latest;
  }
  /** Full revision view for the API and `cad_inspect_model`. */
  async revisionDetail(modelId2, revision2) {
    const index = await this.store.readModel(modelId2);
    const summary = this.resolveRevision(index, revision2);
    let meta = null;
    let document2 = null;
    let report = null;
    try {
      const read = await this.store.readRevision(modelId2, summary.revisionId);
      meta = read.meta;
      document2 = read.document;
      report = read.report;
    } catch (error) {
      if (!(error instanceof CadError2) || error.code !== "not_found" && error.code !== "revision_conflict") throw error;
      const documentRead = await this.store.readDocument(modelId2, summary.number).catch(() => null);
      document2 = documentRead?.document ?? null;
    }
    const artifacts = (meta?.artifacts ?? summary.artifacts).map((artifact) => artifactRef(index.id, summary.revisionId, artifact));
    return { index, summary, meta, document: document2, report: report ?? meta?.report ?? null, artifacts };
  }
  /** `cad_inspect_model` / `GET /api/models/:id`. */
  async inspectModel(input) {
    const detail = await this.revisionDetail(input.modelId, input.revision);
    const include = input.include === "document" || input.include === "full" ? input.include : "summary";
    const historyLimit = clampLimit(input.historyLimit, 1, this.config.limits.maxHistoryEntries, include === "full" ? 50 : 10);
    const history = [...detail.index.revisions].reverse().slice(0, historyLimit).map((summary) => this.revisionSummaryView(detail.index.id, summary));
    const meta = detail.meta;
    const revisionView = {
      revisionId: detail.summary.revisionId,
      number: detail.summary.number,
      status: detail.summary.status,
      createdAt: detail.summary.createdAt,
      builtAt: detail.summary.builtAt,
      documentSha256: detail.summary.documentSha256,
      buildKind: meta?.buildKind ?? null,
      buildRequestId: meta?.buildRequestId ?? null,
      durationMs: meta?.durationMs ?? null,
      formats: meta?.formats ?? detail.summary.artifacts.map((artifact) => artifact.format),
      report: detail.report,
      artifacts: detail.artifacts,
      warnings: meta?.warnings ?? detail.report?.warnings ?? [],
      error: meta?.error ?? null
    };
    const currentSummary = detail.index.revisions.find((entry) => entry.number === detail.index.currentRevision);
    const currentRefs = (currentSummary?.artifacts ?? []).map((artifact) => artifactRef(detail.index.id, currentSummary.revisionId, artifact));
    const glb = currentRefs.find((ref) => ref.format === "glb") ?? null;
    const step = currentRefs.find((ref) => ref.format === "step") ?? null;
    const payload = {
      ok: true,
      model: {
        modelId: detail.index.id,
        name: detail.index.name,
        description: detail.index.description,
        schema: DOCUMENT_SCHEMA2,
        units: "mm",
        createdAt: detail.index.createdAt,
        updatedAt: detail.index.updatedAt,
        currentRevision: detail.index.currentRevision,
        currentRevisionId: currentSummary?.revisionId ?? null,
        latestRevision: detail.index.latestRevision,
        latestRevisionId: detail.index.revisions.find((entry) => entry.number === detail.index.latestRevision)?.revisionId ?? null,
        latestStatus: latestStatusOf(detail.index),
        failing: latestStatusOf(detail.index) === "failed",
        revisionCount: detail.index.revisions.length,
        owner: detail.index.owner ?? { sessionId: detail.index.ownerSession ?? null },
        metadata: detail.index.metadata ?? {}
      },
      revision: revisionView,
      viewer: {
        glbUrl: glb?.url ?? null,
        stepUrl: step?.url ?? null,
        svgUrl: null,
        defaultView: "iso",
        units: "mm",
        upAxis: "z"
      },
      history
    };
    if (include !== "summary" && detail.document !== null) {
      payload.document = {
        schema: DOCUMENT_SCHEMA2,
        units: "mm",
        parameters: detail.document.parameters ?? {},
        features: detail.document.features,
        featureCount: detail.document.features.length,
        parameterNames: Object.keys(detail.document.parameters ?? {})
      };
    }
    return payload;
  }
  /** Compact revision projection used by `history` and `GET /revisions`. */
  revisionSummaryView(modelId2, summary) {
    return {
      revisionId: summary.revisionId,
      number: summary.number,
      status: summary.status,
      createdAt: summary.createdAt,
      builtAt: summary.builtAt,
      documentSha256: summary.documentSha256,
      errorCode: summary.errorCode,
      report: summary.reportSummary,
      artifacts: summary.artifacts.map((artifact) => artifactRef(modelId2, summary.revisionId, artifact))
    };
  }
  /** `GET /api/models/:id/revisions`. */
  async listRevisions(input) {
    const index = await this.store.readModel(input.modelId);
    const limit = clampLimit(input.limit, 1, this.config.limits.maxHistoryEntries, 50);
    return {
      ok: true,
      modelId: index.id,
      currentRevision: index.currentRevision,
      latestRevision: index.latestRevision,
      revisions: [...index.revisions].reverse().slice(0, limit).map((summary) => this.revisionSummaryView(index.id, summary))
    };
  }
  /** `GET /api/models/:id/artifacts`. */
  async modelArtifacts(input) {
    const detail = await this.revisionDetail(input.modelId, input.revision);
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      artifacts: detail.artifacts
    };
  }
  // ------------------------------------------------------------------ writes
  /** Throw unless writes are enabled by configuration. */
  requireWrite() {
    if (!this.config.allowModelWrite) {
      throw new CadError2("permission_denied", "this CAD plugin is configured read-only (allowModelWrite=false)");
    }
  }
  /** Normalize the requested build formats, defaulting to step+glb. */
  normalizeFormats(value) {
    if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_FORMATS];
    const formats2 = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !EXPORT_FORMATS2.includes(entry)) {
        throw new CadError2("invalid_argument", `formats must be a subset of ${EXPORT_FORMATS2.join(", ")}`, { formats: value });
      }
      if (!formats2.includes(entry)) formats2.push(entry);
    }
    return formats2;
  }
  /**
   * Validate a document and allocate the model + its first revision, without
   * building. The caller either builds synchronously (`runBuild`) or wraps the
   * build in a background job.
   * @param input - creation input from the tool.
   * @returns the prepared build.
   */
  async prepareCreate(input) {
    this.requireWrite();
    const document2 = validateDocument(input.document, this.config);
    const name2 = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim().slice(0, this.config.limits.maxNameLength) : document2.name ?? "Untitled CAD model";
    const description = typeof input.description === "string" ? input.description.slice(0, this.config.limits.maxNameLength) : document2.description ?? "";
    const formats2 = this.normalizeFormats(input.formats);
    const mutation = await this.store.createModel({
      name: name2,
      description,
      document: document2,
      ownerSession: input.ownerSession ?? null,
      requestId: input.requestId ?? null,
      formats: formats2
    });
    return {
      modelId: mutation.index.id,
      modelName: mutation.index.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: "create",
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: input.build !== false,
      formats: formats2,
      ownerSession: input.ownerSession ?? null,
      index: mutation.index
    };
  }
  /**
   * Apply an edit to the current document and allocate the next revision.
   * Parameter edits are validated here, before any runtime call.
   * @param input - modify-model input.
   * @returns the prepared build.
   */
  async prepareModify(input) {
    this.requireWrite();
    const index = await this.store.readModel(input.modelId);
    const expectedRevision = typeof input.expectedRevision === "number" && Number.isFinite(input.expectedRevision) ? Math.trunc(input.expectedRevision) : Number.NaN;
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new CadError2("invalid_argument", "expected_revision must be an integer", { field: "expected_revision" });
    }
    const current = await this.store.readDocument(index.id, index.currentRevision > 0 ? index.currentRevision : index.latestRevision);
    const edit = {};
    if (input.parameters !== void 0) {
      if (!isRecord2(input.parameters)) throw new CadError2("invalid_argument", "parameters must be an object", { field: "parameters" });
      edit.parameters = input.parameters;
      for (const [key, value] of Object.entries(edit.parameters)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new CadError2("invalid_argument", `parameter "${key}" must be a finite number`, { path: `parameters.${key}` });
        }
      }
    }
    if (input.addFeatures !== void 0) {
      if (!Array.isArray(input.addFeatures)) throw new CadError2("invalid_argument", "add_features must be an array", { field: "add_features" });
      edit.addFeatures = input.addFeatures;
    }
    if (input.removeFeatures !== void 0) {
      if (!Array.isArray(input.removeFeatures)) throw new CadError2("invalid_argument", "remove_features must be an array", { field: "remove_features" });
      edit.removeFeatures = input.removeFeatures;
    }
    if (typeof input.name === "string") edit.name = input.name.slice(0, this.config.limits.maxNameLength);
    if (typeof input.description === "string") edit.description = input.description.slice(0, this.config.limits.maxNameLength);
    const nextDocument = applyEdit(current.document, edit, this.config);
    const formats2 = this.normalizeFormats(input.formats);
    const mutation = await this.store.allocateRevision({
      modelId: index.id,
      document: nextDocument,
      kind: "modify",
      requestId: input.requestId ?? null,
      expectedRevision,
      formats: formats2
    });
    let nextIndex = mutation.index;
    if (edit.name !== void 0 && edit.name !== nextIndex.name || edit.description !== void 0 && edit.description !== nextIndex.description) {
      nextIndex = await this.store.updateModelIdentity(nextIndex.id, {
        name: edit.name ?? nextIndex.name,
        description: edit.description ?? nextIndex.description
      });
    }
    return {
      modelId: nextIndex.id,
      modelName: nextIndex.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: "modify",
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: input.build !== false,
      formats: formats2,
      ownerSession: input.ownerSession ?? null,
      index: nextIndex
    };
  }
  /**
   * Rebuild the current document as a new revision (no document change).
   * @param input - rebuild input.
   * @returns the prepared build.
   */
  async prepareRebuild(input) {
    this.requireWrite();
    const index = await this.store.readModel(input.modelId);
    const expectedRevision = typeof input.expectedRevision === "number" && Number.isFinite(input.expectedRevision) ? Math.trunc(input.expectedRevision) : Number.NaN;
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new CadError2("invalid_argument", "expected_revision must be an integer", { field: "expected_revision" });
    }
    const current = await this.store.readDocument(index.id, expectedRevision > 0 ? expectedRevision : index.latestRevision);
    const formats2 = this.normalizeFormats(input.formats);
    const mutation = await this.store.allocateRevision({
      modelId: index.id,
      document: current.document,
      kind: "rebuild",
      requestId: input.requestId ?? null,
      expectedRevision,
      formats: formats2
    });
    return {
      modelId: mutation.index.id,
      modelName: mutation.index.name,
      number: mutation.allocation.number,
      revisionId: mutation.allocation.revisionId,
      document: mutation.allocation.document,
      documentSha256: mutation.allocation.documentSha256,
      kind: "rebuild",
      requestId: input.requestId ?? null,
      duplicate: mutation.duplicate,
      build: true,
      formats: formats2,
      ownerSession: input.ownerSession ?? null,
      index: mutation.index
    };
  }
  /** Serialize work per model. */
  async withModelQueue(modelId2, task) {
    const previous = this.modelQueues.get(modelId2) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve4) => {
      release = resolve4;
    });
    const tail = previous.then(() => gate);
    this.modelQueues.set(modelId2, tail);
    await previous.catch(() => void 0);
    try {
      return await task();
    } finally {
      release();
      if (this.modelQueues.get(modelId2) === tail) this.modelQueues.delete(modelId2);
    }
  }
  /** Bound concurrent builds by `maxConcurrentBuilds`; a queued build can be cancelled. */
  async withBuildSlot(signal, task) {
    if (this.activeBuilds >= this.config.maxConcurrentBuilds) {
      await new Promise((resolve4, reject2) => {
        const waiter = () => {
          cleanup();
          resolve4();
        };
        const onAbort = () => {
          cleanup();
          reject2(new CadError2("cancelled", "the build was cancelled while queued"));
        };
        const cleanup = () => {
          const at = this.buildWaiters.indexOf(waiter);
          if (at !== -1) this.buildWaiters.splice(at, 1);
          signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted === true) {
          reject2(new CadError2("cancelled", "the build was cancelled while queued"));
          return;
        }
        this.buildWaiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.activeBuilds += 1;
    try {
      return await task();
    } finally {
      this.activeBuilds -= 1;
      const next = this.buildWaiters.shift();
      if (next !== void 0) next();
    }
  }
  /**
   * Persist a prepared-but-unsettled build as failed and release its write fence.
   * Idempotent: a revision that already has `revision.json` is left untouched.
   */
  async failPrepared(prepared, error) {
    const revisionError = this.revisionErrorFrom(error, "build_failed");
    try {
      const settled = await this.store.readRevision(prepared.modelId, prepared.revisionId).then(() => true).catch(() => false);
      if (!settled) {
        await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => void 0);
        await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion: {
            status: "failed",
            report: null,
            artifacts: [],
            error: revisionError,
            warnings: [],
            durationMs: null,
            buildId: null
          }
        });
      }
    } catch (storeError) {
      this.log("service: could not persist the abandoned revision", storeError);
    } finally {
      this.store.releasePending(prepared.modelId, prepared.number);
    }
  }
  /** Public form of `failPrepared` for a background start that was refused. */
  async discardPrepared(prepared, error) {
    await this.failPrepared(prepared, error);
  }
  /**
   * Execute one prepared build: call the runtime, verify artifacts, persist the
   * revision. A geometry failure persists a `failed` revision and keeps the
   * previous current revision; a transport failure persists it as failed too,
   * so nothing silently disappears.
   * @param prepared - allocation produced by a prepare step.
   * @param options - cancellation, progress.
   * @returns the model/revision payload.
   */
  async runBuild(prepared, options = {}) {
    if (prepared.duplicate) return this.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true });
    if (!prepared.build) {
      const index = await this.store.markUnbuilt({
        modelId: prepared.modelId,
        revisionId: prepared.revisionId,
        number: prepared.number,
        buildKind: prepared.kind,
        buildRequestId: prepared.requestId,
        documentSha256: prepared.documentSha256,
        formats: prepared.formats,
        ownerSession: prepared.ownerSession
      });
      prepared.index = index;
      const detail = await this.revisionDetail(prepared.modelId, prepared.revisionId);
      return {
        ok: true,
        modelId: prepared.modelId,
        modelName: prepared.modelName,
        revisionId: prepared.revisionId,
        revision: prepared.number,
        status: "unbuilt",
        duplicate: false,
        currentRevision: detail.index.currentRevision,
        latestRevision: detail.index.latestRevision,
        documentSha256: prepared.documentSha256,
        artifacts: [],
        report: null,
        warnings: [],
        error: null
      };
    }
    if (options.signal?.aborted === true) {
      const cancelled = new CadError2("cancelled", "the build was cancelled before it started");
      await this.failPrepared(prepared, cancelled);
      throw cancelled;
    }
    try {
      return await this.withBuildSlot(options.signal, () => this.withModelQueue(prepared.modelId, async () => {
        const started = Date.now();
        const requestId2 = options.runtimeRequestId ?? `rq-${randomUUID2()}`;
        const outputDir = this.store.revisionDirectory(prepared.modelId, prepared.revisionId);
        await mkdir4(outputDir, { recursive: true });
        let result;
        try {
          result = await this.runtime.build({
            requestId: requestId2,
            model: { id: prepared.modelId, revisionId: prepared.revisionId },
            document: prepared.document,
            outputDir,
            formats: prepared.formats,
            checks: this.config.checks.length > 0 ? this.config.checks : null,
            limits: {
              maxBoundingBoxMm: this.config.maxBoundingBoxMm,
              maxArtifactBytes: this.config.maxArtifactBytes,
              maxFeatures: this.config.limits.maxFeatures,
              maxParameters: this.config.limits.maxParameters
            },
            preview: prepared.formats.includes("svg") ? { view: "iso", width: 1200, height: 900 } : null
          }, {
            ...options.signal === void 0 ? {} : { signal: options.signal },
            ...options.onProgress === void 0 ? {} : { onProgress: options.onProgress },
            requestId: requestId2
          });
        } catch (error) {
          await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => void 0);
          const revisionError = this.revisionErrorFrom(error);
          await this.store.completeBuild({
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            number: prepared.number,
            buildKind: prepared.kind,
            buildRequestId: prepared.requestId,
            documentSha256: prepared.documentSha256,
            formats: prepared.formats,
            ownerSession: prepared.ownerSession,
            completion: {
              status: "failed",
              report: null,
              artifacts: [],
              error: revisionError,
              warnings: [],
              durationMs: Date.now() - started,
              buildId: null
            }
          }).catch((storeError) => this.log("service: could not persist the failed revision", storeError));
          throw error;
        }
        const durationMs = Date.now() - started;
        const report = result.report;
        const failure = result.status === "built" ? null : result.error ?? {
          code: "build_failed",
          message: "the CAD build did not produce a valid solid",
          details: { checks: report?.checks ?? [] }
        };
        if (failure !== null) {
          await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => void 0);
          const completion = {
            status: "failed",
            report,
            artifacts: [],
            error: failure,
            warnings: report?.warnings ?? [],
            durationMs,
            buildId: result.buildId
          };
          await this.store.completeBuild({
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            number: prepared.number,
            buildKind: prepared.kind,
            buildRequestId: prepared.requestId,
            documentSha256: prepared.documentSha256,
            formats: prepared.formats,
            ownerSession: prepared.ownerSession,
            completion
          });
          const code = failure.code === "invalid_geometry" || failure.code === "build_failed" || failure.code === "export_failed" ? failure.code : "build_failed";
          throw new CadError2(code, failure.message, failure.details ?? { checks: report?.checks ?? [] });
        }
        let artifacts;
        try {
          artifacts = await this.store.verifyArtifacts(prepared.modelId, prepared.revisionId, result.artifacts, this.config.maxArtifactBytes);
        } catch (error) {
          await this.store.clearRevisionArtifacts(prepared.modelId, prepared.revisionId, prepared.formats).catch(() => void 0);
          const revisionError = this.revisionErrorFrom(error, "build_failed");
          await this.store.completeBuild({
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            number: prepared.number,
            buildKind: prepared.kind,
            buildRequestId: prepared.requestId,
            documentSha256: prepared.documentSha256,
            formats: prepared.formats,
            ownerSession: prepared.ownerSession,
            completion: {
              status: "failed",
              report,
              artifacts: [],
              error: revisionError,
              warnings: report?.warnings ?? [],
              durationMs,
              buildId: result.buildId
            }
          });
          throw error;
        }
        const index = await this.store.completeBuild({
          modelId: prepared.modelId,
          revisionId: prepared.revisionId,
          number: prepared.number,
          buildKind: prepared.kind,
          buildRequestId: prepared.requestId,
          documentSha256: prepared.documentSha256,
          formats: prepared.formats,
          ownerSession: prepared.ownerSession,
          completion: {
            status: "built",
            report,
            artifacts,
            error: null,
            warnings: report?.warnings ?? [],
            durationMs,
            buildId: result.buildId
          }
        });
        prepared.index = index;
        this.log(`service: built ${prepared.modelId}/${prepared.revisionId} (${String(artifacts.length)} artifacts, ${String(durationMs)} ms)`);
        return this.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: false });
      }));
    } catch (error) {
      await this.failPrepared(prepared, error);
      throw error;
    } finally {
      this.store.releasePending(prepared.modelId, prepared.number);
    }
  }
  /** Map any thrown error into the revision error recorded on disk. */
  revisionErrorFrom(error, fallbackCode = "build_failed") {
    if (error instanceof CadError2) {
      return {
        code: error.code,
        message: error.message,
        ...error.details === void 0 ? {} : { details: error.details }
      };
    }
    return {
      code: fallbackCode,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  /**
   * Build the canonical tool/API payload for a revision that already exists.
   * @param modelId - model id.
   * @param revisionId - revision id.
   * @param options - `duplicate` marks a replayed request_id.
   */
  async payloadForRevision(modelId2, revisionId2, options = {}) {
    const detail = await this.revisionDetail(modelId2, revisionId2);
    const meta = detail.meta;
    return {
      ok: true,
      modelId: detail.index.id,
      modelName: detail.index.name,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      status: detail.summary.status,
      duplicate: options.duplicate === true,
      currentRevision: detail.index.currentRevision,
      latestRevision: detail.index.latestRevision,
      documentSha256: detail.summary.documentSha256,
      artifacts: detail.artifacts,
      report: detail.report,
      warnings: meta?.warnings ?? detail.report?.warnings ?? [],
      error: meta?.error ?? null,
      viewer: this.viewerBlock(detail.artifacts)
    };
  }
  /** Viewer URLs of one artifact set (glb/step/svg). */
  viewerBlock(artifacts) {
    const find = (format) => artifacts.find((artifact) => artifact.format === format)?.url ?? null;
    return {
      glbUrl: find("glb"),
      stepUrl: find("step"),
      stlUrl: find("stl"),
      svgUrl: find("svg"),
      defaultView: "iso",
      units: "mm",
      upAxis: "z"
    };
  }
  /** `GET /api/models/:id` payload (viewer contract, documented in api.ts). */
  async modelDetail(input) {
    const include = input.include === "summary" || input.include === "full" ? input.include : "document";
    const payload = await this.inspectModel({
      modelId: input.modelId,
      revision: input.revision,
      include,
      historyLimit: input.historyLimit ?? 20
    });
    const currentSummary = payload.model.currentRevisionId;
    if (currentSummary !== null) {
      const current = await this.revisionDetail(input.modelId, currentSummary);
      payload.viewer = this.viewerBlock(current.artifacts);
    } else {
      payload.viewer = { glbUrl: null, stepUrl: null, stlUrl: null, svgUrl: null, defaultView: "iso", units: "mm", upAxis: "z" };
    }
    return payload;
  }
  // ------------------------------------------------------------- validate/export
  /** `cad_validate_model`: structural + runtime geometry checks, no revision. */
  async validateModel(input) {
    let document2;
    let modelId2 = null;
    let revisionId2 = null;
    let number = null;
    if (input.document !== void 0) {
      document2 = validateDocument(input.document, this.config);
    } else {
      if (typeof input.modelId !== "string" || input.modelId === "") {
        throw new CadError2("invalid_argument", "cad_validate_model needs either document or (model_id + optional revision_id)");
      }
      const detail = await this.revisionDetail(input.modelId, input.revisionId);
      if (detail.document === null) {
        throw new CadError2("not_found", `revision ${detail.summary.revisionId} has no stored document`, { modelId: input.modelId });
      }
      document2 = detail.document;
      modelId2 = detail.index.id;
      revisionId2 = detail.summary.revisionId;
      number = detail.summary.number;
    }
    const checks = Array.isArray(input.checks) ? input.checks.filter((entry) => typeof entry === "string") : null;
    const result = await this.runtime.validateModel({
      document: document2,
      checks
    }, {
      ...input.signal === void 0 ? {} : { signal: input.signal },
      timeoutMs: this.config.buildTimeoutMs
    });
    return {
      ok: true,
      valid: result.valid,
      modelId: modelId2,
      revisionId: revisionId2,
      revision: number,
      checks: result.checks,
      report: result.report,
      documentSha256: null
    };
  }
  /**
   * `cad_export_model`: return artifact references and optionally copy the
   * bytes into the session workspace (workspace-relative, never overwriting
   * unless asked).
   * @param input - export request.
   * @returns exported files and their references.
   */
  async exportModel(input) {
    if (!this.config.allowExport) {
      throw new CadError2("permission_denied", "artifact export is disabled (allowExport=false)");
    }
    const detail = await this.revisionDetail(input.modelId, input.revisionId);
    const formats2 = this.normalizeFormats(input.formats);
    const present = new Map(detail.artifacts.map((artifact) => [artifact.format, artifact]));
    const missing = formats2.filter((format) => !present.has(format));
    let derived = [];
    if (missing.length > 0) {
      if (detail.document === null) {
        throw new CadError2("not_found", "the selected revision has no stored document to re-export", { modelId: input.modelId });
      }
      derived = await this.buildDerivedArtifacts(detail.index.id, detail.summary.revisionId, detail.document, missing);
    }
    const selected = [...present.values(), ...derived].filter((artifact) => formats2.includes(artifact.format));
    if (selected.length === 0) {
      throw new CadError2("export_failed", "none of the requested formats could be produced", { formats: formats2 });
    }
    const sources = [];
    for (const artifact of selected) {
      sources.push({ artifact, source: await this.artifactSourcePath(detail.index.id, detail.summary.revisionId, artifact) });
    }
    let written = [];
    let outputDirectory = null;
    if (typeof input.outputPath === "string" && input.outputPath !== "") {
      if (typeof input.workspaceRoot !== "string" || input.workspaceRoot === "") {
        throw new CadError2("permission_denied", "exporting into the workspace needs an available session workspace");
      }
      const copies = await copyArtifactsIntoWorkspace({
        workspaceRoot: input.workspaceRoot,
        outputPath: input.outputPath,
        files: sources.map((entry) => ({ source: entry.source, fileName: entry.artifact.fileName })),
        overwrite: input.overwrite === true
      });
      written = copies.written;
      outputDirectory = relative3(input.workspaceRoot, copies.directory);
    }
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      formats: formats2,
      exported: sources.map((entry) => ({
        format: entry.artifact.format,
        fileName: entry.artifact.fileName,
        bytes: entry.artifact.bytes,
        sha256: entry.artifact.sha256,
        contentType: entry.artifact.contentType,
        path: written.find((candidate) => candidate.endsWith(entry.artifact.fileName)) ?? null
      })),
      outputPath: outputDirectory,
      artifacts: selected
    };
  }
  /** Rebuild extra formats into a derived cache and return their references. */
  async buildDerivedArtifacts(modelId2, revisionId2, document2, formats2) {
    const directory = await this.store.ensureStoreDirectory(["models", modelId2, "exports", revisionId2]);
    const requestId2 = `rq-${randomUUID2()}`;
    const result = await this.runtime.build({
      requestId: requestId2,
      model: { id: modelId2, revisionId: revisionId2 },
      document: document2,
      outputDir: directory,
      formats: formats2,
      checks: null,
      limits: {
        maxBoundingBoxMm: this.config.maxBoundingBoxMm,
        maxArtifactBytes: this.config.maxArtifactBytes,
        maxFeatures: this.config.limits.maxFeatures,
        maxParameters: this.config.limits.maxParameters
      },
      preview: null
    }, {
      timeoutMs: this.config.buildTimeoutMs,
      requestId: requestId2
    });
    if (result.status !== "built") {
      const failure = result.error ?? { code: "export_failed", message: "the CAD runtime could not produce the requested formats" };
      throw new CadError2(failure.code === "export_failed" ? "export_failed" : "build_failed", failure.message, failure.details ?? { formats: formats2 });
    }
    const verified = await this.store.verifyDeclaredArtifacts(["models", modelId2, "exports", revisionId2], result.artifacts, this.config.maxArtifactBytes);
    return verified.filter((artifact) => formats2.includes(artifact.format)).map((artifact) => ({
      artifactId: `${modelId2}:${revisionId2}:${artifact.format}`,
      format: artifact.format,
      fileName: artifact.fileName,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      contentType: artifact.contentType,
      url: `${ASSET_PREFIX}/models/${modelId2}/${revisionId2}/${artifact.fileName}`
    }));
  }
  /** Absolute source path of one artifact (revision dir or derived cache). */
  async artifactSourcePath(modelId2, revisionId2, artifact) {
    const revisionPath = await safePath(this.store.root, ["models", modelId2, "revisions", revisionId2, artifact.fileName]).catch(() => null);
    if (revisionPath !== null && await stat3(revisionPath).then((info) => info.isFile()).catch(() => false)) return revisionPath;
    const derivedPath = await safePath(this.store.root, ["models", modelId2, "exports", revisionId2, artifact.fileName]).catch(() => null);
    if (derivedPath !== null && await stat3(derivedPath).then((info) => info.isFile()).catch(() => false)) return derivedPath;
    throw new CadError2("not_found", `artifact ${artifact.fileName} is not on disk`, { modelId: modelId2, revisionId: revisionId2, fileName: artifact.fileName });
  }
  /**
   * `cad_render_preview`: build only an SVG projection into the derived preview
   * cache. Never creates a revision, so a preview cannot corrupt history.
   */
  async renderPreview(input) {
    const detail = await this.revisionDetail(input.modelId, input.revisionId);
    if (detail.document === null) {
      throw new CadError2("not_found", "the selected revision has no stored document to render", { modelId: input.modelId });
    }
    const view = typeof input.view === "string" && ["iso", "front", "top", "right"].includes(input.view) ? input.view : "iso";
    const width = clampLimit(input.width, 200, 4e3, 1200);
    const height = clampLimit(input.height, 200, 4e3, 900);
    const directory = await this.store.ensureStoreDirectory(["models", detail.index.id, "previews", detail.summary.revisionId]);
    const requestId2 = `rq-${randomUUID2()}`;
    const result = await this.runtime.build({
      requestId: requestId2,
      model: { id: detail.index.id, revisionId: detail.summary.revisionId },
      document: detail.document,
      outputDir: directory,
      formats: ["svg"],
      checks: null,
      limits: {
        maxBoundingBoxMm: this.config.maxBoundingBoxMm,
        maxArtifactBytes: this.config.maxArtifactBytes,
        maxFeatures: this.config.limits.maxFeatures,
        maxParameters: this.config.limits.maxParameters
      },
      preview: { view, width, height }
    }, {
      timeoutMs: this.config.buildTimeoutMs,
      requestId: requestId2
    });
    if (result.status !== "built") {
      const failure = result.error ?? { code: "build_failed", message: "the CAD runtime could not render the preview" };
      throw new CadError2(failure.code === "export_failed" ? "export_failed" : "build_failed", failure.message, failure.details ?? { view });
    }
    const verified = await this.store.verifyDeclaredArtifacts(
      ["models", detail.index.id, "previews", detail.summary.revisionId],
      result.artifacts,
      this.config.maxArtifactBytes
    );
    const preview = verified.find((artifact) => artifact.format === "svg");
    if (preview === void 0) {
      throw new CadError2("export_failed", "the CAD runtime did not produce preview.svg", { view });
    }
    const ref = previewRef(detail.index.id, detail.summary.revisionId, preview);
    return {
      ok: true,
      modelId: detail.index.id,
      revisionId: detail.summary.revisionId,
      revision: detail.summary.number,
      view,
      width,
      height,
      format: "svg",
      artifact: ref,
      tempFile: null
    };
  }
  /** Resolve the parameter values actually used by a revision (tool convenience). */
  async resolvedParameters(modelId2, revision2) {
    const detail = await this.revisionDetail(modelId2, revision2);
    const parameters = detail.document?.parameters ?? {};
    const resolved = {};
    for (const [name2, value] of Object.entries(parameters)) {
      const number = resolveNumber(value, parameters);
      if (number !== null) resolved[name2] = number;
    }
    return resolved;
  }
  /** True when at least one model exists (used by the client's empty state). */
  async hasModels() {
    return await this.store.countModels() > 0;
  }
};

// src/host/api.ts
var DETAIL_QUERY_KEYS = /* @__PURE__ */ new Set(["revision", "history_limit", "include"]);
function isReadMethod(method) {
  return method === "GET" || method === "HEAD";
}
function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-length", String(body.length));
  res.end(body);
}
function sendMethodNotAllowed(res) {
  if (res.headersSent) return;
  res.setHeader("allow", "GET, HEAD");
  sendJson(res, 405, { error: { code: "invalid_argument", message: "this API is read-only (GET/HEAD only)" } });
}
function sendError(res, error) {
  if (isCadError2(error)) {
    sendJson(res, error.status ?? 500, {
      error: {
        code: error.code,
        message: error.message,
        ...error.details === void 0 ? {} : { details: error.details }
      }
    });
    return;
  }
  sendJson(res, 500, {
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : String(error)
    }
  });
}
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CadError2("not_found", "malformed URL path");
  }
}
function normalizeEtag(value) {
  return value.trim().replace(/^W\//u, "").replace(/^"|"$/gu, "");
}
var CadApi = class {
  service;
  admit;
  log;
  constructor(options) {
    this.service = options.service;
    this.admit = options.admit;
    this.log = options.log ?? (() => void 0);
  }
  /** Handle one `/api` request; owns the full response lifecycle. */
  async handleApi(req, res) {
    try {
      const rejection = this.admit(req);
      if (rejection !== void 0) {
        sendJson(res, rejection, { error: { code: "unauthorized", message: "this page is not authenticated for the Harness API" } });
        return;
      }
      const method = String(req.method ?? "GET").toUpperCase();
      if (!isReadMethod(method)) {
        sendMethodNotAllowed(res);
        return;
      }
      const url = new URL(req.url ?? "/", "http://dsh-plugin-cad.invalid");
      let path = url.pathname.slice(API_PREFIX.length);
      if (path === "") path = "/";
      const segments = path.split("/").filter((segment) => segment !== "").map(decodeSegment);
      const query = Object.fromEntries(url.searchParams.entries());
      const payload = await this.routeApi(segments, query);
      sendJson(res, 200, payload);
    } catch (error) {
      if (res.statusCode >= 500) this.log(`api: ${String(req.method)} ${String(req.url)} failed`, error);
      sendError(res, error);
    }
  }
  /** Route one API path. */
  async routeApi(segments, query) {
    if (segments.length === 1 && segments[0] === "health") {
      return this.service.health();
    }
    if (segments[0] !== "models") {
      throw new CadError2("not_found", `no route for /${segments.join("/")}`);
    }
    if (segments.length === 1) {
      const models = await this.service.listModels({
        limit: query.limit,
        includeFailed: query.include_failed === "true" || query.include_failed === "1"
      });
      return { ok: true, count: models.length, models };
    }
    const modelId2 = segments[1] ?? "";
    if (segments.length === 2) {
      return this.service.modelDetail({
        modelId: modelId2,
        revision: query.revision,
        historyLimit: query.history_limit,
        include: query.include
      });
    }
    const resource = segments[2] ?? "";
    if (resource === "revisions") {
      if (segments.length === 3) {
        return this.service.listRevisions({ modelId: modelId2, limit: query.limit });
      }
      if (segments.length === 4) {
        const detail = await this.service.revisionDetail(modelId2, segments[3]);
        const revisions = await this.service.listRevisions({ modelId: modelId2, limit: 100 });
        const summary = revisions.revisions.find((entry) => entry.revisionId === detail.summary.revisionId);
        const payload = await this.service.inspectModel({ modelId: modelId2, revision: segments[3], include: "summary" });
        return {
          ok: true,
          modelId: detail.index.id,
          revision: payload.revision,
          summary: summary ?? null
        };
      }
      throw new CadError2("not_found", "no such revisions route");
    }
    if (resource === "artifacts" && segments.length === 3) {
      return this.service.modelArtifacts({ modelId: modelId2, revision: query.revision });
    }
    throw new CadError2("not_found", `no route for /${segments.join("/")}`);
  }
  /**
   * Handle one asset request: fixed artifact names inside a revision directory,
   * or the derived preview cache. Every path segment is validated and the store
   * proves the resolved file stays inside its root (no `..`, no symlink escape).
   */
  async handleAsset(req, res) {
    try {
      const rejection = this.admit(req);
      if (rejection !== void 0) {
        sendJson(res, rejection, { error: { code: "unauthorized", message: "this page is not authenticated for the Harness API" } });
        return;
      }
      const method = String(req.method ?? "GET").toUpperCase();
      if (!isReadMethod(method)) {
        sendMethodNotAllowed(res);
        return;
      }
      const url = new URL(req.url ?? "/", "http://dsh-plugin-cad.invalid");
      let path = url.pathname.slice(ASSET_PREFIX.length);
      if (path.startsWith("/")) path = path.slice(1);
      const rawSegments = path.split("/");
      if (rawSegments.some((segment) => segment === "")) {
        throw new CadError2("not_found", "asset not found");
      }
      const segments = rawSegments.map(decodeSegment);
      if (segments[0] !== "models" || segments.length !== 4 && segments.length !== 5) {
        throw new CadError2("not_found", "asset not found");
      }
      const modelId2 = segments[1] ?? "";
      let file;
      let fileName;
      if (segments.length === 4) {
        const revisionId2 = segments[2] ?? "";
        fileName = segments[3] ?? "";
        file = await this.service.modelStore.readArtifact(modelId2, revisionId2, fileName);
      } else {
        if (segments[2] !== "previews") throw new CadError2("not_found", "asset not found");
        const revisionId2 = segments[3] ?? "";
        fileName = segments[4] ?? "";
        file = await this.service.modelStore.readPreview(modelId2, revisionId2, fileName);
      }
      const etag = `"${file.sha256}"`;
      const inm = req.headers["if-none-match"];
      if (typeof inm === "string" && inm.split(",").some((candidate) => normalizeEtag(candidate) === file.sha256)) {
        res.statusCode = 304;
        res.setHeader("etag", etag);
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", file.contentType);
      res.setHeader("content-length", String(file.bytes.length));
      res.setHeader("etag", etag);
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("x-content-type-options", "nosniff");
      if (url.searchParams.get("download") === "1") {
        res.setHeader("content-disposition", `attachment; filename="${modelId2}-${fileName}"`);
      }
      if (method === "HEAD") {
        res.end();
        return;
      }
      res.end(file.bytes);
    } catch (error) {
      if (isCadError2(error) && error.code === "not_found") {
        sendJson(res, 404, { error: { code: "not_found", message: error.message } });
        return;
      }
      if (isCadError2(error) && error.code === "path_escape") {
        sendJson(res, 403, { error: { code: "path_escape", message: error.message } });
        return;
      }
      this.log(`api: asset ${String(req.url)} failed`, error);
      sendError(res, error);
    }
  }
};
var DETAIL_QUERY = [...DETAIL_QUERY_KEYS];

// src/host/jobs.ts
var OUTPUT_LIMIT_BYTES = 16 * 1024;
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCadJobId(value) {
  return typeof value === "string" && /^cad-[A-Za-z0-9]+$/u.test(value);
}
function normalizeJobSnapshot(raw) {
  if (!isRecord3(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.status !== "string") return null;
  const startedAt = typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) ? raw.startedAt : null;
  if (startedAt === null) return null;
  const status = raw.status;
  if (!["running", "stopping", "completed", "killed", "failed"].includes(status)) return null;
  const normalizedStatus = status;
  const output = isRecord3(raw.output) ? {
    ...typeof raw.output.total === "number" ? { total: raw.output.total } : {},
    ...typeof raw.output.earliest === "number" ? { earliest: raw.output.earliest } : {},
    ...Array.isArray(raw.output.spillPaths) ? { spillPaths: raw.output.spillPaths.filter((entry) => typeof entry === "string") } : {}
  } : void 0;
  return {
    id: raw.id,
    kind: typeof raw.kind === "string" ? raw.kind : "cad",
    label: typeof raw.label === "string" ? raw.label : "",
    ...typeof raw.owner === "string" ? { owner: raw.owner } : {},
    status: normalizedStatus,
    ...typeof raw.detail === "string" ? { detail: raw.detail } : {},
    ...typeof raw.progress === "string" ? { progress: raw.progress } : {},
    startedAt,
    ...typeof raw.finishedAt === "number" && Number.isFinite(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {},
    ...typeof raw.reported === "boolean" ? { reported: raw.reported } : {},
    ...output === void 0 ? {} : { output }
  };
}
function chunksToText(chunks) {
  if (!Array.isArray(chunks)) return "";
  let text = "";
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }
    if (isRecord3(chunk) && typeof chunk.text === "string") text += chunk.text;
  }
  return text;
}
function normalizeJobRead(raw) {
  if (!isRecord3(raw)) return { text: "", snapshot: null, lossy: false, result: void 0 };
  const record = raw;
  const snapshot = normalizeJobSnapshot(record.job ?? record.snapshot);
  let text = typeof record.text === "string" ? record.text : "";
  if (text === "") text = chunksToText(record.chunks);
  return {
    text,
    snapshot,
    lossy: record.lossy === true,
    result: record.result
  };
}
var CadJobs = class {
  getRegistry;
  log;
  live = /* @__PURE__ */ new Map();
  constructor(options) {
    this.getRegistry = options.getRegistry ?? (() => options.registry ?? null);
    this.log = options.log ?? (() => void 0);
  }
  /** True when the composition provides `ctx.jobs`. */
  available() {
    return this.getRegistry() !== null;
  }
  /** Attach the controller the registry requires before `start`. */
  attach() {
    const registry = this.getRegistry();
    if (registry === null) return () => void 0;
    return registry.attachController("cad");
  }
  /** Number of CAD jobs still running (health payload). */
  activeCount() {
    return this.live.size;
  }
  /**
   * Start one background build through the native job registry.
   *
   * Output is pushed through the registry's `handle.append`, because the
   * shipped registry has no `readOutput` hook; the terminal `result` carries a
   * small JSON summary the agent can read once the job settles.
   *
   * @param spec - label, owning session id and the job body.
   * @returns the registry-issued id and a settlement promise.
   * @throws {Error} when `ctx.jobs` is not in this composition.
   */
  startBuild(spec) {
    const registry = this.getRegistry();
    if (registry === null) {
      throw new Error("background builds require the harness jobs service (ctx.jobs) in this composition");
    }
    let controller = null;
    let jobCancel = null;
    let cancelled = false;
    let settle = () => void 0;
    const done = new Promise((resolve4) => {
      settle = resolve4;
    });
    const jobId = registry.start({
      kind: "cad",
      label: spec.label,
      ...spec.owner === void 0 ? {} : { owner: spec.owner },
      ...spec.toolCall === void 0 ? {} : { toolCall: spec.toolCall },
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: (handle) => {
        controller = new AbortController();
        const signal = controller.signal;
        const append = (text) => {
          try {
            handle.append?.(text.endsWith("\n") ? text : `${text}
`);
          } catch (error) {
            this.log("jobs: could not append job output", error);
          }
        };
        const cancel = (reason) => {
          if (cancelled) return;
          cancelled = true;
          controller?.abort(new Error(reason ?? "cancelled"));
        };
        jobCancel = cancel;
        void (async () => {
          try {
            const value = await spec.run(signal, append);
            const summary = {
              modelId: typeof value.modelId === "string" ? value.modelId : null,
              revisionId: typeof value.revisionId === "string" ? value.revisionId : null,
              revision: typeof value.revision === "number" ? value.revision : null,
              status: typeof value.status === "string" ? value.status : null
            };
            const detail = [summary.modelId, summary.revisionId, summary.status].filter((entry) => entry !== null).join(" ");
            append(`done: ${JSON.stringify(summary)}`);
            settle({
              status: cancelled ? "killed" : "completed",
              ...detail === "" ? {} : { detail },
              result: summary
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            append(`failed: ${message}`);
            settle({
              status: cancelled ? "killed" : "failed",
              detail: message,
              result: { status: "failed", error: message }
            });
          }
        })();
        return { cancel, done };
      }
    });
    this.live.set(jobId, { done, cancel: (reason) => jobCancel?.(reason) });
    void done.finally(() => {
      this.live.delete(jobId);
    });
    this.log(`jobs: started ${jobId} (${spec.label})`);
    return { jobId, done };
  }
  /** Read one job snapshot (throws for unknown/foreign ids). */
  get(jobId, caller) {
    const registry = this.getRegistry();
    if (registry === null) throw new Error("the harness jobs service is not available");
    const snapshot = normalizeJobSnapshot(registry.get(jobId, caller));
    if (snapshot === null) throw new Error(`the job registry returned a malformed snapshot for ${jobId}`);
    return snapshot;
  }
  /** Read the next output delta for one job (consuming cursor, like the harness). */
  read(jobId, caller) {
    const registry = this.getRegistry();
    if (registry === null) throw new Error("the harness jobs service is not available");
    const read = normalizeJobRead(registry.read(jobId, caller));
    if (read.snapshot === null) {
      throw new Error(`the job registry returned a malformed read for ${jobId}`);
    }
    return read;
  }
  /** List visible CAD jobs, newest first. */
  list(caller, limit = 20) {
    const registry = this.getRegistry();
    if (registry === null) return [];
    const snapshots = registry.list(caller).flatMap((entry) => {
      const snapshot = normalizeJobSnapshot(entry);
      return snapshot === null ? [] : [snapshot];
    });
    return snapshots.filter((job) => job.kind === "cad").slice(-limit).reverse();
  }
  /** Cancel one job by id. */
  kill(jobId, caller, reason) {
    const registry = this.getRegistry();
    if (registry === null) throw new Error("the harness jobs service is not available");
    return registry.kill(jobId, caller, reason);
  }
  /**
   * Human-readable one-line status for a tool result. Total: an absent or
   * malformed snapshot yields `null` instead of throwing, so a settled job can
   * always be reported.
   */
  static describe(snapshot) {
    if (snapshot === null || snapshot === void 0) return null;
    const output = snapshot.output === void 0 ? void 0 : {
      ...snapshot.output.total === void 0 ? {} : { total: snapshot.output.total },
      ...snapshot.output.earliest === void 0 ? {} : { earliest: snapshot.output.earliest }
    };
    return {
      jobId: snapshot.id,
      kind: snapshot.kind,
      label: snapshot.label,
      status: snapshot.status,
      cancelled: snapshot.status === "killed",
      done: snapshot.status !== "running" && snapshot.status !== "stopping",
      detail: snapshot.detail ?? null,
      progress: snapshot.progress ?? null,
      startedAt: new Date(snapshot.startedAt).toISOString(),
      finishedAt: snapshot.finishedAt === void 0 ? null : new Date(snapshot.finishedAt).toISOString(),
      ...output === void 0 ? {} : { output }
    };
  }
};

// src/host/runtime.ts
import { spawn } from "node:child_process";
var MAX_CONSECUTIVE_START_FAILURES = 3;
var START_BACKOFF_MS = [500, 1e3, 2e3];
var MAX_STDERR_LINES = 200;
function delay(ms) {
  return new Promise((resolve4) => {
    const timer = setTimeout(resolve4, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rpcErrorToCadError(frame, method) {
  if (isRecord4(frame)) {
    const data = isRecord4(frame.data) ? frame.data : null;
    const code = data !== null && typeof data.code === "string" ? data.code : "internal";
    const message = typeof frame.message === "string" && frame.message !== "" ? frame.message : `${method} failed inside the CAD runtime`;
    const details = data !== null && isRecord4(data.details) ? data.details : void 0;
    const normalized = code === "internal_error" ? "internal" : code;
    return new CadError2(normalized, message, details);
  }
  return new CadError2("internal", `${method} failed inside the CAD runtime with a malformed error frame`);
}
var CadRuntime = class {
  config;
  pluginRoot;
  log;
  resolveOverride;
  commandOverride;
  child = null;
  state = "stopped";
  generation = 0;
  startPromise = null;
  pending = /* @__PURE__ */ new Map();
  nextId = 1;
  stdoutBuffer = "";
  stderrLines = [];
  malformedFrames = 0;
  restarts = 0;
  startFailures = 0;
  nextStartAllowedAt = 0;
  lastError = null;
  lastStartedAt = null;
  hello = null;
  resolved = null;
  disposed = false;
  shuttingDown = false;
  exitWaiters = [];
  constructor(options) {
    this.config = options.config;
    this.pluginRoot = options.pluginRoot ?? findPluginRoot();
    this.log = options.log ?? (() => void 0);
    this.resolveOverride = options.resolve ?? null;
    this.commandOverride = options.command ?? null;
  }
  /** Last resolved interpreter command (for diagnostics). */
  get command() {
    return this.commandOverride ?? this.resolved?.command ?? null;
  }
  /** True while the child is alive and the hello handshake succeeded. */
  get isReady() {
    return this.state === "ready";
  }
  /** Current child pid, for the orphan-prevention test and status output. */
  get pid() {
    return this.child?.pid ?? null;
  }
  /** Human-readable refusal text when no interpreter resolves. */
  unavailableMessage() {
    if (this.resolved !== null && this.resolved.command === null) {
      return repairHint(this.pluginRoot, this.resolved.notes);
    }
    return repairHint(this.pluginRoot, []);
  }
  /** Resolve the interpreter once, remembering the diagnostics. */
  resolveCommand() {
    if (this.commandOverride !== null) {
      return { command: this.commandOverride, notes: ["test command override"] };
    }
    if (this.resolveOverride !== null) {
      this.resolved ??= this.resolveOverride();
      return this.resolved;
    }
    this.resolved ??= resolveRuntimeCommand(
      this.config,
      defaultResolveDeps(this.pluginRoot, process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : `${process.env.HOME ?? ""}/.dsh`)
    );
    return this.resolved;
  }
  /** Re-resolve the interpreter (repair path); returns the diagnostic notes. */
  reResolve() {
    this.resolved = null;
    const resolution = this.resolveCommand();
    return resolution.notes;
  }
  /** Snapshot for `/api/health`, `cad_runtime_status` and logs. */
  status() {
    const command = this.command;
    const uptimeMs = this.lastStartedAt === null ? 0 : Date.now() - this.lastStartedAt;
    return {
      available: this.state === "ready",
      state: this.state,
      pid: this.child?.pid ?? null,
      executable: command?.executable ?? null,
      executableSource: command?.source ?? null,
      protocolVersion: this.hello?.protocolVersion ?? null,
      runtime: this.hello?.runtime ?? null,
      restarts: this.restarts,
      lastError: this.lastError,
      lastStartedAt: this.lastStartedAt === null ? null : new Date(this.lastStartedAt).toISOString(),
      uptimeMs: this.state === "ready" ? uptimeMs : 0,
      stderrTail: this.stderrLines.slice(-20)
    };
  }
  /** Full diagnostics (cad_runtime_status verbose). */
  diagnostics() {
    const status = this.status();
    return {
      ...status,
      protocolVersionExpected: PROTOCOL_VERSION2,
      pluginVersion: VERSION,
      capabilities: this.hello?.capabilities ?? null,
      stderrLines: this.stderrLines.slice(-80),
      resolveNotes: this.resolved?.notes ?? [],
      command: this.command === null ? null : { executable: this.command.executable, args: this.command.args, cwd: this.command.cwd, source: this.command.source }
    };
  }
  /** Append one stderr line to the bounded ring. */
  appendStderr(line) {
    const trimmed = line.replace(/[\r\n]+$/u, "");
    if (trimmed === "") return;
    this.stderrLines.push(trimmed);
    if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES);
  }
  /**
   * Start the runtime if it is not already running. Concurrent callers share one
   * start; a crashed runtime is restarted here (bounded backoff).
   * @throws {CadError} `runtime_unavailable` when no interpreter resolves or the
   *   backoff window is still closed.
   */
  async ensureStarted() {
    if (this.disposed) {
      throw new CadError2("runtime_unavailable", "the CAD runtime supervisor has been disposed");
    }
    if (this.state === "ready" && this.child !== null) return;
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }
  /** One start attempt: spawn, wire framing, hello handshake. */
  async startOnce() {
    if (Date.now() < this.nextStartAllowedAt) {
      throw new CadError2("runtime_unavailable", this.unavailableMessage(), {
        retryAfterMs: this.nextStartAllowedAt - Date.now(),
        lastError: this.lastError
      });
    }
    const resolution = this.resolveCommand();
    if (resolution.command === null) {
      this.state = "disabled";
      this.lastError = "no Python interpreter with build123d resolved";
      throw new CadError2("runtime_unavailable", repairHint(this.pluginRoot, resolution.notes), {
        notes: resolution.notes
      });
    }
    this.state = "starting";
    const generation = this.generation + 1;
    this.generation = generation;
    const command = resolution.command;
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // Own process group so disposal can signal every descendant. The child
        // also exits on stdin EOF, which covers a SIGKILLed harness process.
        detached: process.platform !== "win32"
      });
    } catch (error) {
      this.registerStartFailure(`could not spawn ${command.executable}`, error);
      throw new CadError2("runtime_unavailable", this.unavailableMessage(), { notes: resolution.notes });
    }
    this.child = child;
    this.stdoutBuffer = "";
    this.malformedFrames = 0;
    this.attachChild(child, generation);
    try {
      const hello = await this.sendHello(child);
      this.hello = hello;
      this.state = "ready";
      this.startFailures = 0;
      this.nextStartAllowedAt = 0;
      this.lastError = null;
      this.lastStartedAt = Date.now();
      if (this.restarts > 0) this.log(`runtime: restarted (${String(this.restarts)} total)`);
      else this.log(`runtime: ready (${command.executable}, source ${command.source}, pid ${String(child.pid)})`);
    } catch (error) {
      const mapped = error instanceof CadError2 && error.code === "protocol_version_mismatch" ? new CadError2("runtime_unavailable", error.message, error.details ?? {}) : error;
      this.registerStartFailure("runtime handshake failed", mapped);
      await this.killChild("handshake failed");
      throw mapped instanceof CadError2 ? mapped : new CadError2("runtime_unavailable", "the CAD runtime did not complete its handshake", { cause: String(mapped) });
    }
  }
  /** Wire one child instance's stdio and lifecycle. */
  attachChild(child, generation) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (generation !== this.generation) return;
      this.consumeStdout(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (generation !== this.generation) return;
      for (const line of chunk.split("\n")) this.appendStderr(line);
    });
    child.on("error", (error) => {
      this.appendStderr(`child error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (generation !== this.generation) return;
      this.onChildExit(code, signal);
    });
    child.stdin?.on("error", () => {
    });
  }
  /** Handle child exit: settle pending work and mark the supervisor crashed. */
  onChildExit(code, signal) {
    const detail = `CAD runtime exited (code ${String(code)}, signal ${String(signal)})`;
    this.appendStderr(detail);
    this.child = null;
    this.hello = null;
    const interrupted = [...this.pending.values()];
    this.pending.clear();
    if (!this.shuttingDown) {
      this.state = "crashed";
      this.lastError = detail;
      this.restarts += 1;
    } else {
      this.state = "stopped";
    }
    for (const pending of interrupted) {
      this.settlePending(pending, void 0, new CadError2("runtime_crashed", detail, {
        code: code ?? void 0,
        signal: signal ?? void 0
      }));
    }
    const waiters = this.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
  /** Record one failed start and arm the bounded backoff. */
  registerStartFailure(message, error) {
    this.startFailures += 1;
    this.lastError = `${message}: ${error instanceof Error ? error.message : String(error)}`;
    this.state = "crashed";
    const backoff = START_BACKOFF_MS[Math.min(this.startFailures - 1, START_BACKOFF_MS.length - 1)] ?? 0;
    this.nextStartAllowedAt = Date.now() + backoff;
    this.log(`runtime: ${this.lastError}${this.startFailures >= MAX_CONSECUTIVE_START_FAILURES ? " (giving up until next attempt)" : ""}`);
  }
  /** Consume stdout text and dispatch whole frames. */
  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_FRAME_BYTES2 * 2 && !this.stdoutBuffer.includes("\n")) {
      this.appendStderr("protocol error: oversized frame without a newline; killing the runtime");
      void this.killChild("oversized frame");
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() !== "") this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }
  /** Dispatch one JSON-RPC frame (reply or notification). */
  handleLine(line) {
    if (line.length > MAX_FRAME_BYTES2) {
      this.appendStderr("protocol error: frame exceeds MAX_FRAME_BYTES; killing the runtime");
      void this.killChild("oversized frame");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.malformedFrames += 1;
      this.appendStderr(`protocol warning: non-JSON line from runtime (${String(line.length)} bytes)`);
      if (this.malformedFrames > 5) {
        this.appendStderr("protocol error: too many malformed frames; killing the runtime");
        void this.killChild("malformed frames");
      }
      return;
    }
    this.malformedFrames = 0;
    if (!isRecord4(frame)) return;
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (pending === void 0) return;
      this.pending.delete(frame.id);
      if (isRecord4(frame.error)) {
        this.settlePending(pending, void 0, rpcErrorToCadError(frame.error, pending.method));
      } else {
        this.settlePending(pending, frame.result ?? null);
      }
      return;
    }
    const method = frame.method;
    if (typeof method !== "string") return;
    const params = isRecord4(frame.params) ? frame.params : {};
    if (method === "build.progress") {
      const requestId2 = typeof params.requestId === "string" ? params.requestId : null;
      const pending = requestId2 === null ? void 0 : [...this.pending.values()].find((entry) => entry.requestId === requestId2);
      const line2 = typeof params.message === "string" && params.message !== "" ? `${typeof params.phase === "string" ? params.phase : "build"} ${typeof params.percent === "number" ? `${String(params.percent)}% ` : ""}${params.message}`.trim() : null;
      if (line2 !== null) {
        this.appendStderr(`progress: ${line2}`);
        pending?.onProgress?.(line2);
      }
      return;
    }
    if (method === "runtime.log") {
      const level = typeof params.level === "string" ? params.level : "info";
      const message = typeof params.message === "string" ? params.message : "";
      this.appendStderr(`[${level}] ${message}`);
      if (level === "error") this.log(`runtime: ${message}`);
    }
  }
  /** Register and write one request frame. */
  writeRequest(method, params, options) {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new CadError2("runtime_crashed", "the CAD runtime is not running");
    }
    const id = this.nextId;
    this.nextId += 1;
    let markSettled;
    const settledPromise = new Promise((resolve4) => {
      markSettled = resolve4;
    });
    const pending = {
      id,
      method,
      requestId: options.requestId ?? null,
      resolve: () => void 0,
      reject: () => void 0,
      timer: null,
      settled: false,
      settledPromise,
      markSettled,
      ...options.onProgress === void 0 ? {} : { onProgress: options.onProgress }
    };
    const promise = new Promise((resolve4, reject2) => {
      pending.resolve = resolve4;
      pending.reject = reject2;
    });
    this.pending.set(id, pending);
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== void 0 && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        void this.onRequestTimeout(pending, timeoutMs);
      }, timeoutMs);
      if (typeof pending.timer.unref === "function") pending.timer.unref();
    }
    const abort = options.signal;
    if (abort !== void 0) {
      if (abort.aborted) {
        queueMicrotask(() => {
          void this.cancelPending(pending, abort.reason);
        });
      } else {
        const listener = () => {
          void this.cancelPending(pending, abort.reason);
        };
        abort.addEventListener("abort", listener, { once: true });
        const originalSettle = pending.markSettled;
        pending.markSettled = () => {
          abort.removeEventListener("abort", listener);
          originalSettle();
        };
      }
    }
    const frame = { jsonrpc: "2.0", id, method, params };
    try {
      child.stdin.write(`${JSON.stringify(frame)}
`);
    } catch (error) {
      this.pending.delete(id);
      this.settlePending(pending, void 0, new CadError2("runtime_crashed", "could not write to the CAD runtime", {
        cause: error instanceof Error ? error.message : String(error)
      }));
    }
    pendingResult.set(pending, promise);
    return pending;
  }
  /** Resolve or reject one pending request exactly once. */
  settlePending(pending, value, error) {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.markSettled();
    if (error !== void 0) pending.reject(error);
    else pending.resolve(value ?? null);
  }
  /** Run one request and return its result. */
  async request(method, params, options = {}) {
    await this.ensureStarted();
    const pending = this.writeRequest(method, params, options);
    const promise = pendingResult.get(pending);
    if (promise === void 0) throw new CadError2("internal", "request bookkeeping failed");
    return promise;
  }
  /** Timeout path: kill+respawn the runtime so a wedged call cannot persist. */
  async onRequestTimeout(pending, timeoutMs) {
    if (pending.settled) return;
    this.pending.delete(pending.id);
    if (pending.method !== METHODS2.shutdown) {
      await this.killChild(`request ${pending.method} timed out`);
    }
    this.settlePending(pending, void 0, new CadError2("timeout", `${pending.method} did not finish within ${String(timeoutMs)} ms`, {
      method: pending.method,
      timeoutMs,
      hint: "the CAD runtime was restarted; retry the call"
    }));
  }
  /** Cancellation path: cooperative cancel, then bounded quiescence. */
  async cancelPending(pending, reason) {
    if (pending.settled || this.disposed) return;
    const text = reason instanceof Error && reason.message !== "" ? reason.message : "cancelled by the caller";
    this.sendCancelFrame(pending.requestId ?? String(pending.id), text);
    const settled = await Promise.race([
      pending.settledPromise.then(() => true),
      delay(this.config.cancelGraceMs).then(() => false)
    ]);
    if (!settled) {
      this.pending.delete(pending.id);
      await this.killChild(`request ${pending.method} did not settle after job.cancel`);
    }
    this.settlePending(pending, void 0, new CadError2("cancelled", text, { method: pending.method }));
  }
  /** Write a fire-and-forget `job.cancel` frame (its reply is ignored). */
  sendCancelFrame(requestId2, reason) {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) return;
    const id = this.nextId;
    this.nextId += 1;
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: METHODS2.cancel,
        params: { requestId: requestId2, reason }
      })}
`);
    } catch {
    }
  }
  /** Send hello on a freshly spawned child and check the protocol version. */
  async sendHello(child) {
    const pending = this.writeRequest(METHODS2.hello, {
      protocolVersion: PROTOCOL_VERSION2,
      host: { name: "dsh-plugin-cad", version: VERSION }
    }, { timeoutMs: this.config.runtimeStartTimeoutMs });
    const promise = pendingResult.get(pending);
    if (promise === void 0) throw new CadError2("internal", "hello bookkeeping failed");
    const result = await promise;
    if (child !== this.child) throw new CadError2("runtime_crashed", "the CAD runtime exited during its handshake");
    if (!isRecord4(result)) throw new CadError2("runtime_unavailable", "the CAD runtime returned a malformed hello");
    const protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    if (protocolVersion !== PROTOCOL_VERSION2) {
      throw new CadError2("runtime_unavailable", `the CAD runtime speaks protocol ${JSON.stringify(protocolVersion)} but this host requires ${PROTOCOL_VERSION2}`, {
        expected: PROTOCOL_VERSION2,
        received: protocolVersion,
        runtime: result.runtime ?? null
      });
    }
    return {
      protocolVersion,
      runtime: isRecord4(result.runtime) ? result.runtime : null,
      capabilities: isRecord4(result.capabilities) ? result.capabilities : null
    };
  }
  /** Probe an already-running runtime (`cad_runtime_status`, `/api/health`). */
  async health() {
    if (this.state !== "ready" || this.child === null) {
      return { ok: false, ...this.status() };
    }
    try {
      const result = await this.request(METHODS2.health, {}, { timeoutMs: this.config.healthTimeoutMs });
      if (!isRecord4(result)) return { ok: true, ...this.status() };
      return { ok: result.ok !== false, ...this.status(), health: result };
    } catch (error) {
      return {
        ok: false,
        ...this.status(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  /**
   * `model.build` with the host's timeout and cancellation semantics.
   * @param params - document, output directory, formats, limits, preview.
   * @param options - signal, progress sink, request id.
   */
  async build(params, options = {}) {
    const requestId2 = options.requestId ?? (typeof params.requestId === "string" ? params.requestId : void 0);
    const result = await this.request(METHODS2.build, params, {
      ...options,
      ...requestId2 === void 0 ? {} : { requestId: requestId2 },
      timeoutMs: options.timeoutMs ?? this.config.buildTimeoutMs
    });
    if (options.signal?.aborted === true) {
      throw new CadError2("cancelled", "the build was cancelled by the caller", { method: METHODS2.build });
    }
    const parsed = this.parseBuildResult(result);
    if (parsed.status === "failed" && parsed.error?.code === "cancelled") {
      throw new CadError2("cancelled", parsed.error.message, parsed.error.details ?? { method: METHODS2.build });
    }
    return parsed;
  }
  /** Parse and sanitize one `model.build` result frame. */
  parseBuildResult(raw) {
    if (!isRecord4(raw)) {
      throw new CadError2("internal", "the CAD runtime returned a malformed build result");
    }
    const status = raw.status === "built" ? "built" : "failed";
    const report = sanitizeReport(raw.report, status === "built");
    const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
    const error = sanitizeRevisionError(raw.error);
    return {
      ok: raw.ok !== false,
      buildId: typeof raw.buildId === "string" ? raw.buildId : null,
      status,
      report,
      artifacts,
      error
    };
  }
  /** `model.validate`: extra geometry checks without writing files. */
  async validateModel(params, options = {}) {
    const requestId2 = options.requestId ?? (typeof params.requestId === "string" ? params.requestId : void 0);
    const result = await this.request(METHODS2.validate, params, {
      ...options,
      ...requestId2 === void 0 ? {} : { requestId: requestId2 },
      timeoutMs: options.timeoutMs ?? this.config.buildTimeoutMs
    });
    if (options.signal?.aborted === true) {
      throw new CadError2("cancelled", "the validation was cancelled by the caller", { method: METHODS2.validate });
    }
    if (!isRecord4(result)) throw new CadError2("internal", "the CAD runtime returned a malformed validate result");
    const checks = Array.isArray(result.checks) ? result.checks.flatMap((entry) => {
      if (!isRecord4(entry)) return [];
      const status = entry.status;
      if (status !== "pass" && status !== "fail" && status !== "warn") return [];
      return [{
        id: typeof entry.id === "string" ? entry.id : "unknown",
        status,
        message: typeof entry.message === "string" ? entry.message : ""
      }];
    }) : [];
    return {
      ok: result.ok !== false,
      valid: result.valid === true,
      checks,
      report: sanitizeReport(result.report, result.valid === true)
    };
  }
  /** Kill the child if needed and start a fresh one (repair / post-crash). */
  async restart(reason = "requested") {
    await this.killChild(reason);
    this.startFailures = 0;
    this.nextStartAllowedAt = 0;
    this.lastError = null;
    await this.ensureStarted();
    return this.status();
  }
  /** Signal the whole child process group, falling back to the child handle. */
  signalChild(signal) {
    const child = this.child;
    if (child === null || child.pid === void 0) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
      }
    }
    try {
      child.kill(signal);
    } catch {
    }
  }
  /** Resolve once the current child exits or the timeout elapses. */
  waitForExit(timeoutMs) {
    if (this.child === null) return Promise.resolve(true);
    return new Promise((resolve4) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve4(value);
      };
      this.exitWaiters.push(() => finish(true));
      const timer = setTimeout(() => finish(this.child === null), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
  /**
   * Bounded teardown: graceful stdin EOF → runtime.shutdown → SIGTERM → SIGKILL.
   * Always resolves; never throws.
   * @param reason - diagnostic reason recorded in the stderr ring.
   */
  async killChild(reason = "dispose") {
    const child = this.child;
    if (child === null) {
      this.state = "stopped";
      this.hello = null;
      return;
    }
    this.shuttingDown = true;
    this.appendStderr(`supervisor: stopping runtime (${reason})`);
    if (this.state === "ready" && child.stdin !== null && !child.stdin.destroyed) {
      try {
        const pending = this.writeRequest(METHODS2.shutdown, { reason }, { timeoutMs: this.config.shutdownGraceMs });
        const promise = pendingResult.get(pending);
        if (promise !== void 0) await promise.catch(() => void 0);
      } catch {
      }
    }
    try {
      child.stdin?.end();
    } catch {
    }
    if (!await this.waitForExit(this.config.shutdownGraceMs)) {
      this.signalChild("SIGTERM");
      if (!await this.waitForExit(this.config.terminateGraceMs)) {
        this.signalChild("SIGKILL");
        await this.waitForExit(this.config.killWaitMs);
      }
    }
    if (this.child === child) {
      this.child = null;
      this.hello = null;
      const interrupted = [...this.pending.values()];
      this.pending.clear();
      for (const pending of interrupted) {
        this.settlePending(pending, void 0, new CadError2("runtime_crashed", "the CAD runtime was stopped"));
      }
    }
    this.state = "stopped";
    this.shuttingDown = false;
    this.lastStartedAt = null;
  }
  /** Effect disposer body: never leaves a child process behind. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.killChild("plugin disposed");
  }
};
var pendingResult = /* @__PURE__ */ new WeakMap();

// src/host/tools.ts
var OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "false when the call failed; see error." }
  },
  required: ["ok"]
};
function lossless(value, depth = 0) {
  if (depth > 16) return null;
  if (value === void 0 || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => lossless(entry, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === void 0) continue;
      result[key] = lossless(entry, depth + 1);
    }
    return result;
  }
  return null;
}
function errorEnvelope(error, signal) {
  if (signal?.aborted === true) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "the call was cancelled by the caller",
        details: { reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled") }
      }
    };
  }
  if (isCadError2(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...error.details === void 0 ? {} : { details: error.details }
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}
function toolCallOf(exec) {
  if (exec.callId === void 0) return void 0;
  return {
    callId: exec.callId,
    ...exec.rootCallId === void 0 ? {} : { rootCallId: exec.rootCallId }
  };
}
function isAborted(signal) {
  return signal?.aborted === true;
}
function workspaceRootOf(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : null;
}
function ownerSessionOf(exec) {
  const id = exec.agent?.id;
  return typeof id === "string" ? id : null;
}
function sessionIdOf(exec) {
  return ownerSessionOf(exec) ?? void 0;
}
function jobCall(call) {
  try {
    return call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown job|no such job/u.test(message)) {
      throw new CadError2("not_found", message);
    }
    if (/belongs to another session|foreign|not authorized/u.test(message)) {
      throw new CadError2("permission_denied", message);
    }
    throw new CadError2("internal", `the harness job registry failed: ${message}`, {
      registryError: message,
      registryErrorName: error instanceof Error ? error.name : typeof error
    });
  }
}
function optionalString(args, key) {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : void 0;
}
function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new CadError2("invalid_argument", `"${key}" must be a non-empty string`, { field: key });
  }
  return value;
}
function requireInteger(args, key) {
  const value = args[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CadError2("invalid_argument", `"${key}" must be an integer`, { field: key });
  }
  return value;
}
var DESCRIPTIONS = {
  cad_create_model: 'Create a persistent parametric CAD model and build real B-rep geometry. Pass a declarative document ({schema:"dsh.cad/document@1", units:"mm", parameters:{name:number}, features:[{id,op,...}]}); lengths are millimetres, +Z is up, and numeric fields may reference a parameter as "$name" so the part stays editable. Feature ops: box, cylinder, hole, hole_pattern (rect_corners|grid|bolt_circle), fillet, chamfer, cut, union. Returns a model_id, a revision_id, a geometry report (volume, bbox, topology, checks) and artifact references (STEP + GLB by default) \u2014 never the bytes. Invalid documents are rejected before any build with details.path. Use cad_list_models / cad_inspect_model first if a model may already exist. Set background:true for heavy parts: the call returns a harness job_id immediately and you can poll it with cad_get_job_status.',
  cad_modify_model: "Edit an existing model and create the next immutable revision. The normal edit is `parameters` (merge values into the document parameters) \u2014 this re-runs the same features with new dimensions. Also accepts add_features, remove_features, name and description. Requires expected_revision (the current revision you read): a mismatch is rejected with revision_conflict and details.currentRevision, so inspect again rather than guessing. Parameter edits are validated BEFORE the build: an unknown parameter, a non-positive dimension or a hole that does not fit the part returns invalid_argument with details.path and creates no revision. Failed geometry keeps the previous revision current and records the failed revision with its report. background:true returns a job_id.",
  cad_inspect_model: 'Read one model revision: metadata, parameters/features, the geometry report (volume, bbox, topology, per-check verdicts) and artifact references. Use this before cad_modify_model to get the expected_revision and to learn the parameter names. include:"summary" (default) omits the document, "document" adds parameters/features, "full" adds the revision history. Read-only.',
  cad_validate_model: "Run structural document validation plus the full geometry validation suite against a stored revision or a supplied document, WITHOUT creating a revision or touching files. Returns valid, per-check verdicts and the geometry report. Use it to test a risky edit or a hand-written document before committing it with cad_modify_model. Read-only (the runtime may need to build in memory).",
  cad_export_model: "Export a revision in STEP/GLB/STL. Returns artifact references; with output_path (a WORKSPACE-RELATIVE directory) it also copies the files into the session workspace and reports their paths. Existing files are never overwritten unless overwrite:true, and output_path may not leave the workspace. Formats missing from the revision are rebuilt into a derived cache, not a new revision. Tool results never inline file bytes.",
  cad_render_preview: "Render a technical SVG projection (hidden-line removed) of a revision for a quick visual check, choosing view iso|front|top|right and an optional pixel width/height. The SVG is cached as a derived preview and referenced by URL; it never creates a revision. Read-only with respect to model history.",
  cad_list_models: "List the CAD models in the store, newest first, with id, name, current/latest revision, build status and artifact references. Use this FIRST to discover existing models before cad_create_model or cad_inspect_model. Read-only; every model in the store is visible regardless of which session created it.",
  cad_get_job_status: 'Inspect or cancel a background CAD build started with background:true. Give job_id (e.g. "cad-3f2a\u2026") to get its status and progress output, or omit it to list the recent CAD jobs. action:"cancel" requests cancellation through the native harness job registry. Read-only unless action is cancel.',
  cad_runtime_status: 'Report the Python CAD runtime status (interpreter, protocol version, capabilities, uptime, last error, recent stderr) and whether it is available. action:"repair" restarts the supervised runtime and re-resolves the interpreter; unless config allowRuntimeInstall=true it does not install anything and returns the exact manual setup command instead. Use verbose:true for diagnostics.'
};
function buildToolEntries(deps) {
  const { service, jobs, config } = deps;
  const buildTimeout = config.buildTimeoutMs + 3e4;
  return [
    {
      name: "cad_create_model",
      description: DESCRIPTIONS.cad_create_model,
      parameters: TOOL_SCHEMAS2.cad_create_model,
      title: "Create CAD model",
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const requestId2 = optionalString(args, "request_id");
        const background = args.background === true;
        const build = args.build !== false;
        requireJobsForBackground(jobs, background && build);
        const prepared = await service.prepareCreate({
          name: args.name,
          description: args.description,
          document: args.document,
          build,
          requestId: requestId2 ?? null,
          ownerSession: ownerSessionOf(exec)
        });
        if (prepared.duplicate) {
          const payload = await service.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true });
          return payload;
        }
        if (background && build) {
          return await startBackgroundBuild(jobs, {
            service,
            prepared,
            label: `CAD create ${prepared.modelId} ${prepared.revisionId}`,
            owner: ownerSessionOf(exec) ?? void 0,
            toolCall: toolCallOf(exec),
            run: (signal, progress) => service.runBuild(prepared, { signal, onProgress: progress }),
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            revision: prepared.number
          });
        }
        return service.runBuild(prepared, {
          ...exec.signal === void 0 ? {} : { signal: exec.signal }
        });
      }
    },
    {
      name: "cad_modify_model",
      description: DESCRIPTIONS.cad_modify_model,
      parameters: TOOL_SCHEMAS2.cad_modify_model,
      title: "Modify CAD model",
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const expectedRevision = requireInteger(args, "expected_revision");
        const background = args.background === true;
        const build = args.build !== false;
        requireJobsForBackground(jobs, background && build);
        const prepared = await service.prepareModify({
          modelId: requireString(args, "model_id"),
          expectedRevision,
          parameters: args.parameters,
          addFeatures: args.add_features,
          removeFeatures: args.remove_features,
          name: args.name,
          description: args.description,
          build,
          requestId: optionalString(args, "request_id") ?? null,
          ownerSession: ownerSessionOf(exec)
        });
        if (prepared.duplicate) {
          return service.payloadForRevision(prepared.modelId, prepared.revisionId, { duplicate: true });
        }
        if (background && build) {
          return await startBackgroundBuild(jobs, {
            service,
            prepared,
            label: `CAD modify ${prepared.modelId} ${prepared.revisionId}`,
            owner: ownerSessionOf(exec) ?? void 0,
            toolCall: toolCallOf(exec),
            run: (signal, progress) => service.runBuild(prepared, { signal, onProgress: progress }),
            modelId: prepared.modelId,
            revisionId: prepared.revisionId,
            revision: prepared.number
          });
        }
        return service.runBuild(prepared, {
          ...exec.signal === void 0 ? {} : { signal: exec.signal }
        });
      }
    },
    {
      name: "cad_inspect_model",
      description: DESCRIPTIONS.cad_inspect_model,
      parameters: TOOL_SCHEMAS2.cad_inspect_model,
      title: "Inspect CAD model",
      timeoutMs: 2e4,
      async run(args) {
        const payload = await service.inspectModel({
          modelId: requireString(args, "model_id"),
          revision: args.revision_id,
          include: args.include,
          historyLimit: args.history_limit
        });
        return payload;
      }
    },
    {
      name: "cad_validate_model",
      description: DESCRIPTIONS.cad_validate_model,
      parameters: TOOL_SCHEMAS2.cad_validate_model,
      title: "Validate CAD document",
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const modelId2 = optionalString(args, "model_id");
        const document2 = args.document;
        if (modelId2 === void 0 && document2 === void 0) {
          throw new CadError2("invalid_argument", "pass either model_id (+ optional revision_id) or document");
        }
        return service.validateModel({
          modelId: modelId2,
          revisionId: args.revision_id,
          document: document2,
          checks: args.checks,
          ...exec.signal === void 0 ? {} : { signal: exec.signal }
        });
      }
    },
    {
      name: "cad_export_model",
      description: DESCRIPTIONS.cad_export_model,
      parameters: TOOL_SCHEMAS2.cad_export_model,
      title: "Export CAD artifacts",
      timeoutMs: buildTimeout,
      async run(args, exec) {
        const workspaceRoot = workspaceRootOf(exec);
        return service.exportModel({
          modelId: requireString(args, "model_id"),
          revisionId: args.revision_id,
          formats: args.formats,
          outputPath: optionalString(args, "output_path"),
          overwrite: args.overwrite === true,
          workspaceRoot
        });
      }
    },
    {
      name: "cad_render_preview",
      description: DESCRIPTIONS.cad_render_preview,
      parameters: TOOL_SCHEMAS2.cad_render_preview,
      title: "Render CAD preview",
      timeoutMs: buildTimeout,
      async run(args) {
        return service.renderPreview({
          modelId: requireString(args, "model_id"),
          revisionId: args.revision_id,
          view: args.view,
          width: args.width,
          height: args.height
        });
      }
    },
    {
      name: "cad_list_models",
      description: DESCRIPTIONS.cad_list_models,
      parameters: TOOL_SCHEMAS2.cad_list_models,
      title: "List CAD models",
      timeoutMs: 15e3,
      async run(args) {
        const models = await service.listModels({
          limit: args.limit,
          includeFailed: args.include_failed
        });
        return {
          ok: true,
          count: models.length,
          models: models.map((model) => {
            const artifacts = Array.isArray(model.artifacts) ? model.artifacts : [];
            const glb = artifacts.find((artifact) => artifact.format === "glb") ?? null;
            return {
              ...model,
              glbUrl: glb?.url ?? null
            };
          })
        };
      }
    },
    {
      name: "cad_get_job_status",
      description: DESCRIPTIONS.cad_get_job_status,
      parameters: TOOL_SCHEMAS2.cad_get_job_status,
      title: "CAD job status",
      timeoutMs: 1e4,
      async run(args, exec) {
        const action = args.action === "cancel" ? "cancel" : "status";
        const limit = typeof args.limit === "number" ? Math.trunc(args.limit) : 20;
        const jobId = optionalString(args, "job_id");
        if (jobId !== void 0) {
          if (!isCadJobId(jobId)) {
            throw new CadError2("invalid_argument", 'job_id must look like "cad-\u2026" (see cad_get_job_status without job_id)', { field: "job_id" });
          }
          if (action === "cancel") {
            if (!jobs.available()) throw new CadError2("internal", "this composition has no background job service");
            const caller = sessionIdOf(exec);
            const result = jobCall(() => jobs.kill(jobId, caller, "cancelled by cad_get_job_status"));
            const snapshot = jobCall(() => jobs.get(jobId, caller));
            return {
              ok: true,
              jobId,
              cancelled: result,
              job: CadJobs.describe(snapshot),
              output: "",
              result: null
            };
          }
          if (!jobs.available()) throw new CadError2("internal", "this composition has no background job service");
          const read = jobCall(() => jobs.read(jobId, sessionIdOf(exec)));
          return {
            ok: true,
            jobId,
            job: CadJobs.describe(read.snapshot),
            output: read.text,
            lossy: read.lossy,
            result: lossless(read.result ?? null)
          };
        }
        const list = jobs.available() ? jobCall(() => jobs.list(sessionIdOf(exec), limit)) : [];
        return {
          ok: true,
          jobs: list.map((snapshot) => CadJobs.describe(snapshot)).filter((entry) => entry !== null),
          available: jobs.available()
        };
      }
    },
    {
      name: "cad_runtime_status",
      description: DESCRIPTIONS.cad_runtime_status,
      parameters: TOOL_SCHEMAS2.cad_runtime_status,
      title: "CAD runtime status",
      timeoutMs: config.runtimeStartTimeoutMs + 1e4,
      async run(args) {
        const action = args.action === "repair" ? "repair" : "status";
        const payload = await service.runtimeStatus(action);
        if (args.verbose === true) {
          return { ...payload, diagnostics: lossless(service.runtimeDiagnostics()) };
        }
        return payload;
      }
    }
  ];
}
function requireJobsForBackground(jobs, background) {
  if (background && !jobs.available()) {
    throw new CadError2("invalid_argument", "background builds are unavailable in this composition; call again without background:true", {
      hint: "the harness jobs service (ctx.jobs) is not loaded"
    });
  }
}
async function startBackgroundBuild(jobs, spec) {
  if (!jobs.available()) {
    throw new CadError2("invalid_argument", "background builds are unavailable in this composition; call again without background:true", {
      hint: "the harness jobs service (ctx.jobs) is not loaded",
      modelId: spec.modelId,
      revisionId: spec.revisionId,
      status: "unbuilt"
    });
  }
  try {
    const started = jobs.startBuild({
      label: spec.label,
      ...spec.owner === void 0 ? {} : { owner: spec.owner },
      ...spec.toolCall === void 0 ? {} : { toolCall: spec.toolCall },
      run: spec.run
    });
    return {
      ok: true,
      background: true,
      jobId: started.jobId,
      modelId: spec.modelId,
      revisionId: spec.revisionId,
      revision: spec.revision,
      status: "building",
      next: "poll cad_get_job_status({job_id}) then cad_inspect_model"
    };
  } catch (error) {
    await spec.service.discardPrepared(spec.prepared, error).catch(() => void 0);
    throw error;
  }
}
function registerTools(tools, deps) {
  if (typeof tools.register !== "function") return [];
  const entries = buildToolEntries(deps);
  const names = entries.map((entry) => entry.name);
  if (names.length !== TOOL_NAMES2.length || TOOL_NAMES2.some((name2, index) => names[index] !== name2)) {
    throw new Error(`tool registration order drifted from src/contracts/tools.js: got ${names.join(", ")}`);
  }
  const disposers = [];
  for (const entry of entries) {
    disposers.push(tools.register({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      presentCall: (args) => ({
        card: "generic",
        title: entry.title,
        kind: "other",
        rawInput: args
      }),
      ...entry.timeoutMs === void 0 ? {} : { timeoutMs: entry.timeoutMs },
      async execute(args, exec) {
        const record = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {};
        if (isAborted(exec.signal)) return errorEnvelope(new CadError2("cancelled", "the call was cancelled before it started"), exec.signal);
        try {
          const payload = await entry.run(record, exec);
          if (isAborted(exec.signal)) return lossless(errorEnvelope(new CadError2("cancelled", "the call was cancelled"), exec.signal));
          return lossless({ ok: true, ...payload });
        } catch (error) {
          return lossless(errorEnvelope(error, exec.signal));
        }
      }
    }));
  }
  return disposers;
}

// src/host/index.ts
var name = PLUGIN_ID;
var version = VERSION;
var inject = ["tools"];
function apply(ctx, rawConfig = {}) {
  const pluginRoot = findPluginRoot(import.meta.url);
  const config = normalizeConfig(rawConfig, { pluginRoot });
  const log = (message, error) => {
    const suffix = error === void 0 ? "" : ` ${error instanceof Error ? error.message : String(error)}`;
    if (error !== void 0) ctx.logger?.warn?.(`${PLUGIN_ID}: ${message}${suffix}`);
    else ctx.logger?.info?.(`${PLUGIN_ID}: ${message}${suffix}`);
  };
  const store = new CadStore({ root: config.dataDir, limits: config.limits, log });
  store.ready().then(
    () => log(`ready \u2014 model store at ${config.dataDir}`),
    (error) => log("could not create the model store directory", error)
  );
  const runtime = new CadRuntime({ config, pluginRoot, log });
  const jobs = new CadJobs({
    getRegistry: () => ctx.get?.("jobs") ?? ctx.jobs ?? null,
    log
  });
  const service = new CadService({
    config,
    store,
    runtime,
    log,
    jobStats: () => ({ active: jobs.activeCount() })
  });
  ctx.effect?.(() => jobs.attach(), `${PLUGIN_ID}: jobs controller`);
  const disposeService = ctx.provide?.("cadService", service);
  if (typeof disposeService === "function") {
    ctx.effect?.(() => disposeService, `${PLUGIN_ID}: service`);
  }
  const toolDisposers = ctx.tools === void 0 ? [] : registerTools(ctx.tools, { service, jobs, config, log });
  ctx.effect?.(() => () => {
    for (const dispose of toolDisposers) dispose();
  }, `${PLUGIN_ID}: tools`);
  const admit = (req) => {
    const connection = ctx.get?.("connection");
    return connection?.requestRejection?.(req);
  };
  const api = new CadApi({ service, admit, log });
  ctx.inject?.(["webServer"], (webContext) => {
    const webServer = webContext.webServer;
    if (typeof webServer?.register !== "function") {
      log("web carrier present but webServer.register is unavailable; viewer API not served");
      return;
    }
    webContext.effect?.(() => webServer.register({
      kind: "prefix",
      path: API_PREFIX,
      handler: (req, res) => api.handleApi(req, res)
    }), `${PLUGIN_ID}: ${API_PREFIX}`);
    webContext.effect?.(() => webServer.register({
      kind: "prefix",
      path: ASSET_PREFIX,
      handler: (req, res) => api.handleAsset(req, res)
    }), `${PLUGIN_ID}: ${ASSET_PREFIX}`);
  });
  ctx.effect?.(() => () => runtime.dispose(), `${PLUGIN_ID}: python runtime`);
  log(`activated \u2014 ${String(toolDisposers.length)} tools, store ${config.dataDir}, runtime ${runtime.command?.executable ?? "unresolved"}`);
}
export {
  apply,
  inject,
  name,
  version
};
//# sourceMappingURL=index.js.map
