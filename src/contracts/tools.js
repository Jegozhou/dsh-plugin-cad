/**
 * Agent-facing tool contracts for dsh-plugin-cad.
 *
 * These JSON Schemas are the *only* surface a model sees. They are object-rooted
 * (the harness requires that), strict (`additionalProperties: false`) and
 * independent of the implementation — the Host maps them onto the CAD service,
 * it does not derive them from it.
 *
 * Every tool returns the same lossless-JSON envelope:
 *
 *   success → { ok: true,  ...payload }
 *   failure → { ok: false, error: { code, message, details? } }
 *
 * Payloads contain *references* to artifacts (id, format, bytes, sha256, url),
 * never artifact bytes and never whole model documents unless the caller asked
 * for `include: "document"`.
 *
 * @module contracts/tools
 */

/** Stable tool names, in registration order. */
export const TOOL_NAMES = Object.freeze([
  'cad_create_model',
  'cad_modify_model',
  'cad_inspect_model',
  'cad_validate_model',
  'cad_export_model',
  'cad_render_preview',
  'cad_list_models',
  'cad_get_job_status',
  'cad_runtime_status',
])

const modelId = {
  type: 'string',
  description: 'Model id returned by cad_create_model (form "m-1a2b3c4d5e").',
}

const revisionId = {
  type: 'string',
  description: 'Immutable revision id (form "r-0003"). Defaults to the current revision.',
}

const revision = {
  type: 'integer',
  minimum: 0,
  description: 'Current revision number the caller expects. A mismatch is rejected with revision_conflict.',
}

const requestId = {
  type: 'string',
  description: 'Optional idempotency key; replaying the same value returns the revision already created instead of creating a second one.',
}

/** One feature. Shape is validated strictly by the service; the schema is the model-facing contract. */
const feature = {
  type: 'object',
  description:
    'One ordered modelling feature. op ∈ box | cylinder | hole | hole_pattern | fillet | chamfer | cut | union. '
    + 'Numeric fields accept a number or a parameter reference string "$name". See docs/research/SPEC_P0.md §3.1.',
  properties: {
    id: { type: 'string', description: 'Unique feature id, e.g. "base" or "center_hole".' },
    op: {
      type: 'string',
      enum: ['box', 'cylinder', 'hole', 'hole_pattern', 'fillet', 'chamfer', 'cut', 'union'],
    },
    length: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    diameter: { type: 'number' },
    radius: { type: 'number' },
    depth: { type: 'number' },
    distance: { type: 'number' },
    inset: { type: 'number' },
    through: { type: 'boolean' },
    axis: { type: 'string', enum: ['x', 'y', 'z'] },
    target: {
      type: 'string',
      enum: ['vertical_edges', 'top_edges', 'bottom_edges', 'all_edges'],
    },
    pattern: { type: 'string', enum: ['rect_corners', 'grid', 'bolt_circle'] },
    count: {
      description: 'grid: [nx, ny]; bolt_circle: hole count.',
      anyOf: [{ type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, { type: 'integer' }],
    },
    spacing: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    span: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    pitch_diameter: { type: 'number' },
    at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 },
    face: { type: 'string', enum: ['top', 'bottom'] },
  },
  required: ['id', 'op'],
  additionalProperties: false,
}

/** A CAD document: parameters + ordered features. */
const document = {
  type: 'object',
  description:
    'Declarative CAD document: {schema, units:"mm", parameters:{name:number}, features:[...]}. '
    + 'Prefer parameters over hard-coded numbers so the model can be edited by changing values.',
  properties: {
    schema: { type: 'string', enum: ['dsh.cad/document@1'] },
    name: { type: 'string' },
    description: { type: 'string' },
    units: { type: 'string', enum: ['mm'] },
    parameters: {
      type: 'object',
      description: 'Named scalar parameters referenced from features as "$name".',
      additionalProperties: { type: 'number' },
    },
    features: { type: 'array', items: feature, minItems: 1, maxItems: 64 },
  },
  required: ['features'],
  additionalProperties: false,
}

const formats = {
  type: 'array',
  description: 'Engineering formats to export. Defaults to ["step","glb"].',
  items: { type: 'string', enum: ['step', 'glb', 'stl'] },
  minItems: 1,
  maxItems: 3,
}

const buildOptions = {
  background: {
    type: 'boolean',
    description:
      'Run the build as a native Harness background job and return a job_id immediately. Use for heavy models; otherwise the call returns the finished revision.',
  },
  build: { type: 'boolean', description: 'Build geometry now (default true). Set false to store the document only.' },
}

/** Tool input schemas keyed by tool name. */
export const TOOL_SCHEMAS = Object.freeze({
  cad_create_model: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human readable model name.' },
      description: { type: 'string' },
      document,
      ...buildOptions,
      request_id: requestId,
    },
    required: ['document'],
    additionalProperties: false,
  },

  cad_modify_model: {
    type: 'object',
    properties: {
      model_id: modelId,
      expected_revision: revision,
      parameters: {
        type: 'object',
        description: 'Values to merge into document.parameters. This is the normal parameter edit.',
        additionalProperties: { type: 'number' },
      },
      add_features: { type: 'array', items: feature, description: 'Features appended in order.' },
      remove_features: {
        type: 'array',
        items: { type: 'string' },
        description: 'Feature ids removed from the document (dependants are not rewritten automatically).',
      },
      name: { type: 'string' },
      description: { type: 'string' },
      ...buildOptions,
      request_id: requestId,
    },
    required: ['model_id', 'expected_revision'],
    additionalProperties: false,
  },

  cad_inspect_model: {
    type: 'object',
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      include: {
        type: 'string',
        enum: ['summary', 'document', 'full'],
        description: 'summary (default): metadata + geometry report; document: adds parameters/features; full: adds revision history.',
      },
      history_limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['model_id'],
    additionalProperties: false,
  },

  cad_validate_model: {
    type: 'object',
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      document,
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of check ids to run; omit for all.',
      },
    },
    additionalProperties: false,
  },

  cad_export_model: {
    type: 'object',
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      formats,
      output_path: {
        type: 'string',
        description:
          'Optional workspace-relative directory to copy the artifacts into. Must stay inside the session workspace. Existing files are never overwritten unless overwrite is true.',
      },
      overwrite: { type: 'boolean' },
    },
    required: ['model_id'],
    additionalProperties: false,
  },

  cad_render_preview: {
    type: 'object',
    properties: {
      model_id: modelId,
      revision_id: revisionId,
      view: { type: 'string', enum: ['iso', 'front', 'top', 'right'], description: 'Default iso.' },
      width: { type: 'integer', minimum: 200, maximum: 4000, description: 'SVG width in px, default 1200.' },
      height: { type: 'integer', minimum: 200, maximum: 4000 },
      format: { type: 'string', enum: ['svg'], description: 'P0 renders SVG technical projection (hidden-line removed).' },
    },
    required: ['model_id'],
    additionalProperties: false,
  },

  cad_list_models: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      include_failed: { type: 'boolean', description: 'Include models whose latest revision failed to build.' },
    },
    additionalProperties: false,
  },

  cad_get_job_status: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Harness job id (form "cad-1"). Omit to list recent CAD jobs.' },
      action: { type: 'string', enum: ['status', 'cancel'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },

  cad_runtime_status: {
    type: 'object',
    properties: {
      verbose: { type: 'boolean' },
      action: {
        type: 'string',
        enum: ['status', 'repair'],
        description:
          'status (default) probes the Python CAD runtime; repair runs the documented, non-interactive runtime installer and is a write/execute operation.',
      },
    },
    additionalProperties: false,
  },
})
