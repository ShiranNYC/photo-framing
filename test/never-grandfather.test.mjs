import { test } from 'node:test'
import assert from 'node:assert/strict'
import { neverMatcher } from '../scripts/lib/never-grandfather.mjs'

test('an exact entry matches only that path, trailing slash ignored', () => {
  const m = neverMatcher(['/artists'])
  assert.equal(m('/artists'), true)
  assert.equal(m('/artists/'), true)
  assert.equal(m('/artists/jane'), false)
  assert.equal(m('/artist'), false)
})

test('a [param] entry matches exactly one segment, including pages added later', () => {
  const m = neverMatcher(['/artists/[slug]'])
  assert.equal(m('/artists/jane'), true)
  assert.equal(m('/artists/brand-new-person'), true)
  assert.equal(m('/artists'), false)
  assert.equal(m('/artists/jane/edit'), false)
  assert.equal(m('/other/jane'), false)
})

test('no entries matches nothing', () => {
  assert.equal(neverMatcher([])('/anything'), false)
  assert.equal(neverMatcher(undefined)('/'), false)
})
