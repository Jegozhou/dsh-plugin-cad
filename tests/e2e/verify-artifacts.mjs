/**
 * Independent artifact verifier for dsh-plugin-cad E2E acceptance.
 *
 * Deliberately shares **no code** with the plugin or the Python runtime: it
 * parses the exported files itself, so a passing result means the file is real,
 * not that our own writer says it is.
 *
 *  - STEP: ISO-10303-21 conformance scan (header/footer, entity graph integrity,
 *    reference resolution) plus the engineering content we actually care about
 *    (manifold solid bodies, cylindrical surfaces with the requested radii).
 *  - GLB:  glTF 2.0 binary container check (magic/version/length, JSON + BIN
 *    chunk lengths), asset version, mesh primitives, triangle count, and the
 *    bounding box reconstructed from the POSITION accessors.
 *
 * Usage:
 *   node tests/e2e/verify-artifacts.mjs <model.step> [model.glb]
 *   node tests/e2e/verify-artifacts.mjs --json <model.step> [model.glb]
 *
 * Exit code 0 when every requested check passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * Parse an ISO-10303-21 (STEP part 21) exchange file structurally.
 * @param {string} text - file content.
 */
export function parseStep(text) {
  const result = {
    isPart21: false,
    schema: null,
    description: null,
    fileName: null,
    entityCount: 0,
    types: {},
    orphanReferences: [],
    danglingReferences: [],
    cylindricalRadii: [],
    manifoldSolidBreps: 0,
    advancedFaces: 0,
  }
  const trimmed = text.trim()
  result.isPart21 = /^ISO-10303-21;/.test(trimmed) && /END-ISO-10303-21;\s*$/.test(trimmed)
  if (!result.isPart21) return result

  const header = /HEADER;([\s\S]*?)ENDSEC;/.exec(text)?.[1] ?? ''
  result.schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(header)?.[1] ?? null
  result.description = /FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/i.exec(header)?.[1] ?? null
  result.fileName = /FILE_NAME\s*\(\s*'([^']*)'/i.exec(header)?.[1] ?? null

  const data = /DATA;([\s\S]*?)ENDSEC;/.exec(text)?.[1] ?? ''
  // Entity records: #id = TYPE ( args ) ;  — args may contain nested parens and
  // strings, so scan with depth tracking instead of a blind global regex.
  const records = []
  let index = 0
  while (index < data.length) {
    const start = data.indexOf('=', index)
    if (start < 0) break
    const hash = data.lastIndexOf('#', start)
    if (hash < 0) { index = start + 1; continue }
    const id = Number(data.slice(hash + 1, start).trim())
    let cursor = start + 1
    while (cursor < data.length && /\s/.test(data[cursor])) cursor += 1
    if (!Number.isFinite(id)) { index = start + 1; continue }
    // Two record forms: a simple instance `#1=POINT(...)` and a *complex*
    // instance `#5=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`,
    // whose "type" is the parenthesised group itself. Both define the id and
    // both may be referenced, so both must be recorded or every reference to a
    // complex instance looks dangling.
    const complex = data[cursor] === '('
    const open = complex ? cursor : data.indexOf('(', cursor)
    if (open < 0) break
    const type = complex ? 'COMPLEX_INSTANCE' : (/^[A-Za-z0-9_]+/.exec(data.slice(cursor))?.[0] ?? 'UNKNOWN')
    let depth = 0
    let end = open
    let inString = false
    for (; end < data.length; end += 1) {
      const ch = data[end]
      if (ch === "'" ) inString = !inString
      if (inString) continue
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { end += 1; break }
      }
    }
    const args = data.slice(open + 1, end - 1)
    records.push({ id, type, args })
    result.types[type] = (result.types[type] ?? 0) + 1
    // Count the component types of a complex instance too: they are the types
    // an engineer searches for.
    if (complex) {
      for (const match of args.matchAll(/([A-Z][A-Z0-9_]+)\s*\(/g)) {
        const name = match[1]
        if (name === 'COMPLEX_INSTANCE') continue
        result.types[name] = (result.types[name] ?? 0) + 1
        if (name === 'MANIFOLD_SOLID_BREP') result.manifoldSolidBreps += 1
        if (name === 'ADVANCED_FACE') result.advancedFaces += 1
      }
    }
    index = end
  }

  result.entityCount = records.length
  result.manifoldSolidBreps = result.types.MANIFOLD_SOLID_BREP ?? 0
  result.advancedFaces = result.types.ADVANCED_FACE ?? 0

  const ids = new Set(records.map(record => record.id))
  const referenced = new Set()
  for (const record of records) {
    for (const match of record.args.matchAll(/#(\d+)/g)) {
      const ref = Number(match[1])
      referenced.add(ref)
      if (!ids.has(ref)) result.danglingReferences.push({ from: record.id, to: ref, type: record.type })
    }
  }
  result.orphanReferences = [...ids].filter(id => !referenced.has(id)).slice(0, 20)

  for (const record of records) {
    if (record.type !== 'CYLINDRICAL_SURFACE') continue
    const numbers = record.args.split(',').map(part => Number(part.trim()))
    const radius = numbers.filter(Number.isFinite).pop()
    if (Number.isFinite(radius)) result.cylindricalRadii.push(radius)
  }
  result.cylindricalRadii.sort((a, b) => a - b)
  return result
}

/**
 * Parse a binary glTF (.glb) container and summarise its geometry.
 * @param {Buffer} buffer - file bytes.
 */
export function parseGlb(buffer) {
  const result = {
    valid: false,
    magic: buffer.readUInt32LE(0),
    version: buffer.readUInt32LE(4),
    declaredLength: buffer.readUInt32LE(8),
    fileLength: buffer.length,
    assetVersion: null,
    generator: null,
    meshCount: 0,
    primitiveCount: 0,
    triangleCount: 0,
    positionAccessorCount: 0,
    boundingBox: null,
    chunkTypes: [],
    errors: [],
  }
  if (result.magic !== 0x46546c67) result.errors.push('bad magic (expected glTF)')
  if (result.version !== 2) result.errors.push(`unsupported container version ${result.version}`)
  if (result.declaredLength !== buffer.length) result.errors.push(`declared length ${result.declaredLength} != file length ${buffer.length}`)

  let json = null
  let binLength = 0
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    offset += 8
    const data = buffer.subarray(offset, offset + length)
    offset += length
    if (type === 0x4e4f534a) {
      result.chunkTypes.push('JSON')
      json = JSON.parse(data.toString('utf8').replace(/\u0000+$/u, ''))
    } else if (type === 0x004e4942) {
      result.chunkTypes.push('BIN')
      binLength = data.length
    } else {
      result.chunkTypes.push('0x' + type.toString(16))
    }
  }
  if (!json) { result.errors.push('missing JSON chunk'); return result }

  result.assetVersion = json.asset?.version ?? null
  result.generator = json.asset?.generator ?? null
  if (result.assetVersion !== '2.0') result.errors.push(`asset.version is ${result.assetVersion}, expected 2.0`)
  result.meshCount = Array.isArray(json.meshes) ? json.meshes.length : 0
  result.primitiveCount = (json.meshes ?? []).reduce((sum, mesh) => sum + (mesh.primitives?.length ?? 0), 0)

  const accessors = json.accessors ?? []
  let triangles = 0
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4
      if (mode !== 4) continue
      const count = primitive.indices === undefined
        ? accessors[primitive.attributes?.POSITION]?.count ?? 0
        : accessors[primitive.indices]?.count ?? 0
      triangles += Math.floor(count / 3)
    }
  }
  result.triangleCount = triangles
  result.positionAccessorCount = accessors.filter(accessor => Array.isArray(accessor.min) && Array.isArray(accessor.max) && accessor.type === 'VEC3').length

  const positions = accessors.filter(accessor => accessor.type === 'VEC3' && Array.isArray(accessor.min) && Array.isArray(accessor.max))
  if (positions.length > 0) {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const accessor of positions) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], accessor.min[axis])
        max[axis] = Math.max(max[axis], accessor.max[axis])
      }
    }
    result.boundingBox = {
      min: min.map(value => round(value)),
      max: max.map(value => round(value)),
      size: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])],
    }
  }
  const buffers = json.buffers ?? []
  if (buffers.length > 0 && (buffers[0].byteLength ?? 0) > binLength) {
    result.errors.push(`buffer[0].byteLength ${buffers[0].byteLength} exceeds BIN chunk ${binLength}`)
  }
  if (!result.chunkTypes.includes('BIN')) result.errors.push('missing BIN chunk')
  result.valid = result.errors.length === 0
  return result
}

/** Round to 3 decimals for readable evidence. */
function round(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * Acceptance checks for the bracket part from docs/research/SPEC_P0.md.
 * @param {ReturnType<typeof parseStep>} step - parsed STEP.
 * @param {ReturnType<typeof parseGlb>|null} glb - parsed GLB.
 * @param {{length:number,width:number,height:number,centerDiameter:number,cornerDiameter:number,cornerCount:number}} expected - nominal dimensions.
 */
export function verifyBracket(step, glb, expected) {
  const checks = []
  const check = (id, ok, detail) => checks.push({ id, status: ok ? 'pass' : 'fail', detail })

  check('step_part21', step.isPart21, `schema=${step.schema} description=${step.description}`)
  check('step_entities', step.entityCount > 100, `${step.entityCount} entities`)
  check('step_references_resolve', step.danglingReferences.length === 0, `${step.danglingReferences.length} dangling references`)
  check('step_solid_body', step.manifoldSolidBreps >= 1, `${step.manifoldSolidBreps} MANIFOLD_SOLID_BREP`)
  check('step_faces', step.advancedFaces >= 6, `${step.advancedFaces} ADVANCED_FACE`)

  const radii = step.cylindricalRadii
  const hasCenter = radii.some(radius => Math.abs(radius - expected.centerDiameter / 2) <= 0.001)
  const cornerHits = radii.filter(radius => Math.abs(radius - expected.cornerDiameter / 2) <= 0.001).length
  check('step_center_hole_radius', hasCenter, `radii=[${radii.join(', ')}] expected ${expected.centerDiameter / 2}`)
  check('step_corner_hole_radii', cornerHits >= expected.cornerCount, `${cornerHits} cylindrical faces of radius ${expected.cornerDiameter / 2}`)

  if (glb) {
    check('glb_container', glb.valid, glb.errors.join('; ') || 'glTF 2.0 container ok')
    check('glb_asset_version', glb.assetVersion === '2.0', `asset.version=${glb.assetVersion}`)
    check('glb_triangles', glb.triangleCount > 100, `${glb.triangleCount} triangles, ${glb.primitiveCount} primitives`)
    if (glb.boundingBox) {
      const expectedSize = [expected.length, expected.width, expected.height]
      const actual = [...glb.boundingBox.size].sort((a, b) => a - b)
      const nominal = [...expectedSize].sort((a, b) => a - b)
      const ok = actual.every((value, index) => Math.abs(value - nominal[index]) <= 0.05)
      check('glb_bounding_box', ok, `actual=${glb.boundingBox.size.join(' x ')} nominal=${expectedSize.join(' x ')} (sorted compare)`)
    } else {
      check('glb_bounding_box', false, 'no POSITION accessor min/max')
    }
  }
  const failed = checks.filter(entry => entry.status === 'fail')
  return { ok: failed.length === 0, checks, failed: failed.map(entry => entry.id) }
}

// ---------------------------------------------------------------- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const jsonOutput = process.argv.includes('--json')
  const files = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
  if (files.length === 0) {
    console.error('usage: node tests/e2e/verify-artifacts.mjs [--json] <model.step> [model.glb]')
    process.exit(2)
  }
  const stepText = readFileSync(files[0], 'utf8')
  const step = parseStep(stepText)
  const glb = files[1] ? parseGlb(readFileSync(files[1])) : null
  const expected = { length: 80, width: 60, height: 8, centerDiameter: 20, cornerDiameter: 6, cornerCount: 4 }
  const verdict = verifyBracket(step, glb, expected)
  const report = { step: { file: basename(files[0]), ...step, textLength: stepText.length }, glb, verdict }
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`STEP ${files[0]}: part21=${step.isPart21} schema=${step.schema} entities=${step.entityCount} solids=${step.manifoldSolidBreps} faces=${step.advancedFaces}`)
    console.log(`  cylindrical radii: ${step.cylindricalRadii.map(value => value.toFixed(3)).join(', ')}`)
    console.log(`  dangling references: ${step.danglingReferences.length}`)
    if (glb) {
      console.log(`GLB  ${files[1]}: valid=${glb.valid} asset=${glb.assetVersion} meshes=${glb.meshCount} primitives=${glb.primitiveCount} triangles=${glb.triangleCount}`)
      console.log(`  bbox: ${glb.boundingBox ? glb.boundingBox.size.join(' x ') : 'n/a'}  generator=${glb.generator}`)
    }
    for (const entry of verdict.checks) console.log(`  [${entry.status.toUpperCase()}] ${entry.id}: ${entry.detail}`)
    console.log(verdict.ok ? 'VERDICT: PASS' : `VERDICT: FAIL (${verdict.failed.join(', ')})`)
  }
  process.exit(verdict.ok ? 0 : 1)
}
