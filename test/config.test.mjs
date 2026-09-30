import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../scripts/lib/config.mjs'

test('defaults reproduce v0.1.0 behaviour', () => {
  const c = normalizeConfig({}, '/x')
  assert.equal(c.routes.trackImports, 'one-hop')
  assert.deepEqual(c.routes.exclude, [])
  assert.equal(c.media.trackRendered, false)
})

test('deep mode turns rendered-media tracking on unless told otherwise', () => {
  assert.equal(normalizeConfig({ routes: { trackImports: 'deep' } }, '/x').media.trackRendered, true)
  assert.equal(normalizeConfig({ routes: { trackImports: 'deep' }, media: { trackRendered: false } }, '/x').media.trackRendered, false)
  assert.equal(normalizeConfig({ media: { trackRendered: true } }, '/x').media.trackRendered, true)
})

test('an unknown trackImports value is a hard error', () => {
  assert.throws(() => normalizeConfig({ routes: { trackImports: 'shallow' } }, '/x'), /trackImports must be one of "one-hop", "deep"/)
})

test('routes.exclude must be an array of "/"-prefixed strings, never "/" alone', () => {
  assert.throws(() => normalizeConfig({ routes: { exclude: 'admin' } }, '/x'), /routes.exclude/)
  assert.throws(() => normalizeConfig({ routes: { exclude: ['admin'] } }, '/x'), /routes.exclude/)
  assert.throws(() => normalizeConfig({ routes: { exclude: ['/'] } }, '/x'), /routes.exclude/)
  assert.deepEqual(normalizeConfig({ routes: { exclude: ['/admin/', '/admin'] } }, '/x').routes.exclude, ['/admin'])
})

test('media.trackRendered must be boolean', () => {
  assert.throws(() => normalizeConfig({ media: { trackRendered: 'yes' } }, '/x'), /trackRendered/)
})
