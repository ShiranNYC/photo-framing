import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, libFor, makeProject, writeFile, SHARED_APP } from './helpers.mjs'

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'page-review-gate.mjs')

/** Project + git repo with the config, stamped routes (hash from the lib, rendered list from `rendered`). */
function stampedProject(rawConfig, rendered = {}) {
  const root = makeProject({ ...SHARED_APP, 'photo-framing.config.json': JSON.stringify(rawConfig) })
  git(root, 'init', '-q')
  const { lib } = libFor(root, rawConfig)
  const stamps = {}
  for (const r of lib.routeModel()) {
    const list = rendered[r.key]
    stamps[r.key] = { route: r.key, contentHash: lib.contentHash(r, list || []), reviewedAt: new Date().toISOString(), ...(list ? { renderedMedia: list } : {}) }
  }
  mkdirSync(join(root, '.photo-framing'), { recursive: true })
  writeFileSync(join(root, '.photo-framing', 'stamps.json'), JSON.stringify(stamps))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return { root, sha: git(root, 'rev-parse', 'HEAD') }
}

const gate = (root, sha) => spawnSync(process.execPath, [GATE, '--deployed-sha', sha], { cwd: root, encoding: 'utf8' })

test('gate CLI: a shared component edit blocks every dependent route as STALE (deep)', () => {
  const cfg = { routes: { trackImports: 'deep' } }
  const { root, sha } = stampedProject(cfg)
  writeFile(root, { 'src/components/Img.tsx': `export const Img = () => <p>changed</p>` })
  const r = gate(root, sha)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  for (const k of ['/', '/about', '/portal']) assert.match(r.stdout, new RegExp(`STALE\\s+${k}\\s`))
  assert.doesNotMatch(r.stdout, /STALE\s+\/portal\/tools/)
})

test('gate CLI: the same edit in default one-hop mode is "not covered", exactly as v0.1.0', () => {
  const { root, sha } = stampedProject({})
  writeFile(root, { 'src/components/Img.tsx': `export const Img = () => <p>changed</p>` })
  const r = gate(root, sha)
  assert.match(r.stdout, /not covered by page review:[\s\S]*src\/components\/Img\.tsx/)
  assert.doesNotMatch(r.stdout, /excluded by config/)
})

test('gate CLI: a changed rendered photo blocks the routes whose stamp lists it, read from the stamp', () => {
  const cfg = { routes: { trackImports: 'deep' } }
  const { root, sha } = stampedProject(cfg, { '/': ['public/images/hero.webp'], '/about': ['public/images/team.webp'] })
  writeFile(root, { 'public/images/hero.webp': 'new-hero-bytes' })
  const r = gate(root, sha)
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /STALE\s+\/\s/)
  assert.doesNotMatch(r.stdout, /STALE\s+\/about/)
})

test('gate CLI: exclusion is named every run, and excluded-only changes get their own heading', () => {
  const cfg = { routes: { trackImports: 'deep', exclude: ['/portal'] } }
  const { root, sha } = stampedProject(cfg)
  writeFile(root, { 'src/app/portal/tools/Tool.tsx': `export const Tool = () => 1` })
  const r = gate(root, sha)
  assert.match(r.stdout, /excluded by config \(routes\.exclude\): 2 route\(s\) under \/portal/)
  assert.match(r.stdout, /excluded by config \(not gated\):\s+src\/app\/portal\/tools\/Tool\.tsx\s+\(only reaches \/portal\/tools\)/)
  assert.doesNotMatch(r.stdout, /not covered by page review:[\s\S]*Tool\.tsx/)
})
