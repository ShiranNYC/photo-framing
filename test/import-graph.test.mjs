import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeImportGraph, stripJsonComments } from '../scripts/lib/import-graph.mjs'
import { makeProject, writeFile } from './helpers.mjs'

test('closure follows aliases, index files, export-from, side-effect, css @import, dynamic import and require', () => {
  const root = makeProject({
    'tsconfig.json': '{ /* c */ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"], }, }, }',
    'src/a.ts': `import x from '@lib/x'\nexport * from './barrel'\nimport './side.css'\nconst m = () => import('./lazy')\nconst r = require('./cjs.js')\nimport React from 'react'\nimport nope from './does-not-exist'`,
    'lib/x.ts': `import { y } from '@lib/deep'\nexport default y`,
    'lib/deep/index.tsx': `export const y = 1`,
    'src/barrel/index.ts': `export { z } from './z'`,
    'src/barrel/z.ts': `export const z = 1`,
    'src/side.css': `@import "./more.css";\n@import 'tailwindcss';`,
    'src/more.css': `a{}`,
    'src/lazy.tsx': `export default 1`,
    'src/cjs.js': `module.exports = 1`,
    'node_modules/react/index.js': `x`,
  })
  const got = [...makeImportGraph(root).closure(['src/a.ts'])].sort()
  assert.deepEqual(got, ['lib/deep/index.tsx', 'lib/x.ts', 'src/a.ts', 'src/barrel/index.ts', 'src/barrel/z.ts', 'src/cjs.js', 'src/lazy.tsx', 'src/more.css', 'src/side.css'])
})

test('a file under node_modules is never followed, even through an alias', () => {
  const root = makeProject({
    'tsconfig.json': '{ "compilerOptions": { "paths": { "pkg/*": ["node_modules/pkg/*"] } } }',
    'src/a.ts': `import 'pkg/index'`,
    'node_modules/pkg/index.js': '1',
  })
  assert.deepEqual([...makeImportGraph(root).closure(['src/a.ts'])], ['src/a.ts'])
})

test('cycles terminate', () => {
  const root = makeProject({ 'a.ts': `import './b'`, 'b.ts': `import './c'`, 'c.ts': `import './a'\nimport './c'` })
  assert.deepEqual([...makeImportGraph(root).closure(['a.ts'])].sort(), ['a.ts', 'b.ts', 'c.ts'])
})

test('@/ maps to src/ with no tsconfig at all', () => {
  const root = makeProject({ 'src/a.ts': `import '@/b'`, 'src/b.ts': '1' })
  assert.deepEqual([...makeImportGraph(root).closure(['src/a.ts'])].sort(), ['src/a.ts', 'src/b.ts'])
})

test('a .js specifier resolves to the .ts source next to it', () => {
  const root = makeProject({ 'a.ts': `import './b.js'`, 'b.ts': '1' })
  assert.deepEqual([...makeImportGraph(root).closure(['a.ts'])].sort(), ['a.ts', 'b.ts'])
})

test('the parse cache notices an edited file', () => {
  const root = makeProject({ 'a.ts': `import './b'`, 'b.ts': '1', 'c.ts': '1' })
  const g = makeImportGraph(root)
  assert.deepEqual([...g.closure(['a.ts'])].sort(), ['a.ts', 'b.ts'])
  writeFile(root, { 'a.ts': `import './b'\nimport './c'  // longer, so the size signature changes` })
  assert.deepEqual([...g.closure(['a.ts'])].sort(), ['a.ts', 'b.ts', 'c.ts'])
})

test('stripJsonComments keeps strings that look like comments', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{ "u": "http://x", /* c */ "a": [1,], // t\n }')), { u: 'http://x', a: [1] })
})
