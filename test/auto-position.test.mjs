import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoPosition } from '../scripts/lib/image-focus-gen.mjs'

const y = (pos) => Number(pos.split(' ')[1].replace('%', ''))

test('a face at the very top of the photo anchors at 0% so hair is never cut', () => {
  // extended box reaches the photo top (clamped to 0)
  assert.equal(y(autoPosition([{ x: 0.06, y: 0.1, w: 0.63, h: 0.58 }])), 0)
})

test('the hidden top strip never reaches the extended face box in a box showing 60% of the height', () => {
  const faces = [{ x: 0.36, y: 0.1367, w: 0.37, h: 0.353 }]
  const top = 0.1367 - 0.35 * 0.353
  const hidden = (y(autoPosition(faces)) / 100) * (1 - 0.6)
  assert.ok(hidden <= top + 1e-9, `hidden ${hidden} exceeds top ${top}`)
})

test('a face well below the top keeps the quarter-down anchor', () => {
  const faces = [{ x: 0.4, y: 0.5, w: 0.1, h: 0.1 }]
  const top = 0.5 - 0.035
  const bottom = 0.6
  assert.equal(y(autoPosition(faces)), Math.round((top + (bottom - top) * 0.25) * 1000) / 10)
})

test('a stricter minVisible lowers the cap further', () => {
  const faces = [{ x: 0.36, y: 0.2, w: 0.3, h: 0.2 }]
  assert.ok(y(autoPosition(faces, 0.8)) <= y(autoPosition(faces, 0.6)))
})
