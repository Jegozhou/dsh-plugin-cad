import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, estimateExtent, resolveNumber, validateDocument } from '../../src/host/validate.ts'
import { CadError } from '../../src/host/contracts.ts'
import { bracketDocument, testConfig } from './helpers.mjs'

const config = testConfig({ dataDir: '/tmp/unused-validate' })

/** Assert a CadError with a code and an optional details.path. */
function expectCadError(fn, code, path) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof CadError, `expected CadError, got ${String(thrown)}`)
  assert.equal(thrown.code, code)
  if (path !== undefined) assert.equal(thrown.details?.path, path, `details.path was ${String(thrown.details?.path)}`)
  return thrown
}

test('the acceptance bracket document validates and is normalized', () => {
  const document = validateDocument(bracketDocument(), config)
  assert.equal(document.schema, 'dsh.cad/document@1')
  assert.equal(document.units, 'mm')
  assert.equal(document.parameters.length, 80)
  assert.equal(document.features.length, 3)
})

test('unknown feature op, field, parameter reference and duplicate id are rejected with a path', () => {
  expectCadError(() => validateDocument({ features: [{ id: 'a', op: 'pyramid' }] }, config), 'invalid_document', 'features[0].op')
  expectCadError(() => validateDocument({ features: [{ id: 'a', op: 'box', length: 1, width: 1, height: 1, radius: 2 }] }, config), 'invalid_document', 'features[0].radius')
  expectCadError(() => validateDocument({
    parameters: { size: 10 },
    features: [{ id: 'a', op: 'box', length: '$missing', width: 1, height: 1 }],
  }, config), 'invalid_document', 'features[0].length')
  expectCadError(() => validateDocument({
    features: [
      { id: 'base', op: 'box', length: 1, width: 1, height: 1 },
      { id: 'base', op: 'hole', diameter: 1, through: true },
    ],
  }, config), 'invalid_document', 'features[1].id')
})

test('the first feature must create material; empty and oversized documents are rejected', () => {
  expectCadError(() => validateDocument({ features: [] }, config), 'invalid_document', 'features')
  expectCadError(() => validateDocument({ features: [{ id: 'h', op: 'hole', diameter: 5 }] }, config), 'invalid_document', 'features[0].op')
  const many = Array.from({ length: 65 }, (_, index) => ({ id: `f${String(index)}`, op: 'box', length: 1, width: 1, height: 1 }))
  expectCadError(() => validateDocument({ features: many }, config), 'invalid_document', 'features')
})

test('numeric rules: finite, positive where required, parameter references allowed in tuples', () => {
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: -1, width: 1, height: 1 }] }, config), 'invalid_document', 'features[0].length')
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: 'x', width: 1, height: 1 }] }, config), 'invalid_document', 'features[0].length')
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: 1, width: 1, height: 1, center: [1] }] }, config), 'invalid_document', 'features[0].center')
  // "$name" inside span is the documented style and must be accepted.
  const valid = validateDocument(bracketDocument(), config)
  assert.deepEqual(valid.features[2].span, ['$length', '$width'])
})

test('hole/pattern specific rules', () => {
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: 10, width: 10, height: 2 }, { id: 'h', op: 'hole', diameter: 3, through: false }] }, config), 'invalid_document', 'features[1].depth')
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: 10, width: 10, height: 2 }, { id: 'p', op: 'hole_pattern', pattern: 'grid', diameter: 2 }] }, config), 'invalid_document', 'features[1].count')
  expectCadError(() => validateDocument({ features: [{ id: 'b', op: 'box', length: 10, width: 10, height: 2 }, { id: 'p', op: 'hole_pattern', pattern: 'bolt_circle', diameter: 2, count: 2 }] }, config), 'invalid_document', 'features[1].count')
})

test('parameter edits merge and produce the next document', () => {
  const document = validateDocument(bracketDocument(), config)
  const next = applyEdit(document, { parameters: { length: 100, width: 70 } }, config)
  assert.equal(next.parameters.length, 100)
  assert.equal(next.parameters.width, 70)
  assert.equal(next.parameters.thickness, 8)
})

test('an invalid parameter edit is invalid_argument and would create no revision', () => {
  const document = validateDocument(bracketDocument(), config)
  expectCadError(() => applyEdit(document, { parameters: { missing: 4 } }, config), 'invalid_argument', 'parameters.missing')
  expectCadError(() => applyEdit(document, { parameters: { thickness: -2 } }, config), 'invalid_argument', 'features[0].height')
  expectCadError(() => applyEdit(document, { parameters: { thickness: 0 } }, config), 'invalid_argument', 'features[0].height')
  expectCadError(() => applyEdit(document, { parameters: { center_d: 200 } }, config), 'invalid_argument', 'features[1].diameter')
})

test('feature edits: add, remove, rename and structural rejection', () => {
  const document = validateDocument(bracketDocument(), config)
  const added = applyEdit(document, {
    addFeatures: [{ id: 'fillet_all', op: 'fillet', radius: 2, target: 'vertical_edges' }],
    name: 'Bracket with fillets',
  }, config)
  assert.equal(added.features.length, 4)
  assert.equal(added.name, 'Bracket with fillets')

  const removed = applyEdit(document, { removeFeatures: ['corner_holes'] }, config)
  assert.equal(removed.features.length, 2)

  expectCadError(() => applyEdit(document, { removeFeatures: ['nope'] }, config), 'invalid_argument')
  expectCadError(() => applyEdit(document, { addFeatures: [{ id: 'weird', op: 'torus' }] }, config), 'invalid_argument')
})

test('resolveNumber and estimateExtent understand references', () => {
  const document = validateDocument(bracketDocument(), config)
  assert.equal(resolveNumber('$length', document.parameters), 80)
  assert.equal(resolveNumber(12, document.parameters), 12)
  assert.equal(resolveNumber('$nope', document.parameters), null)
  const extent = estimateExtent(document, document.parameters)
  assert.deepEqual(extent, { x: 80, y: 60, z: 8 })
})
