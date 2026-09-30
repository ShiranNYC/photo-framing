#!/usr/bin/env node
/**
 * Deploy gate: every route changed since the deployed commit must carry a page-review
 * stamp whose contentHash matches its current content. Wire this into your deploy script
 * BEFORE anything is built or shipped (see README "Wire the gate into a deploy script").
 *
 *   node node_modules/photo-framing/scripts/page-review-gate.mjs [--deployed-sha <sha>]
 *
 * --deployed-sha should come from wherever your deploy records what commit is live (e.g.
 * a .deployed-sha file your deploy script writes to the server after a successful deploy).
 * Without it (first deploy after this gate is wired up, the deploy target unreachable, or a
 * sha this clone does not have) the gate falls back to the merge-base with the remote's main
 * branch and says so.
 *
 * Changed files that map to no route (shared components, globals, lib, docs) are printed
 * under "not covered by page review:" every run; they are never silently dropped. With
 * routes.trackImports "deep" a shared file maps to every route that imports it, directly or
 * transitively. Files reaching only routes.exclude'd routes are printed under "excluded by
 * config", and one line names the exclusion every run. Escape
 * hatch: PHOTO_FRAMING_SKIP="<reason>" passes the gate, prints the reason loudly, and
 * appends it to .photo-framing/skips.log.
 *
 * Also fails if the AUTO_FOCUS registry (config.focusRegistry.autoPath, if you use one) does
 * not match what .photo-framing/faces.json would generate right now: fix with
 * `node node_modules/photo-framing/scripts/generate-image-focus.mjs`. Covered by the same
 * PHOTO_FRAMING_SKIP escape hatch.
 *
 * Exit: 0 pass (or logged skip), 1 blocked, 2 could not determine what changed.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { loadConfig } from './lib/config.mjs'
import { makeLib } from './lib/page-review-lib.mjs'
import { autoFocusPath, GENERATE_CMD, generate as generateAutoFocus } from './lib/image-focus-gen.mjs'

const config = loadConfig()
const { REPO, REVIEW_DIR, SKIP_LOG_PATH, contentHash, mapChangedFiles, readStamps, routeModel, excludeInfo } = makeLib(config)

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

const i = process.argv.indexOf('--deployed-sha')
const claimed = i > -1 ? (process.argv[i + 1] || '').trim() : ''

let base = null
if (claimed && git('cat-file', '-e', `${claimed}^{commit}`) !== null) {
  base = claimed
  console.log(`  base: deployed commit ${claimed.slice(0, 10)} (from --deployed-sha)`)
} else {
  const remotes = (git('remote') || '').split('\n').filter(Boolean).sort((a, b) => (b === 'origin') - (a === 'origin'))
  const remote = remotes.find((r) => git('rev-parse', '--verify', '-q', `${r}/main`)) || null
  const mb = remote ? git('merge-base', 'HEAD', `${remote}/main`) : null
  if (!mb) {
    console.log('PAGE REVIEW GATE: cannot determine what changed (no deployed sha, no remote main). BLOCKED.')
    process.exit(2)
  }
  base = mb
  const why = claimed
    ? `the deployed sha ${claimed.slice(0, 10)} is not in this clone (deployed from another desk and not pushed?)`
    : 'no deployed sha recorded or readable'
  console.log(`  base: FALLBACK to merge-base with ${remote}/main (${mb.slice(0, 10)}) because ${why}.`)
  console.log('        Routes changed on the deploy target but not in this clone are NOT seen by this comparison.')
}

const changed = [
  ...new Set([
    ...(git('diff', '--name-only', base) || '').split('\n'),
    ...(git('ls-files', '--others', '--exclude-standard') || '').split('\n'),
  ]),
].filter(Boolean)

const model = routeModel()
const stamps = readStamps()
const { routes, uncovered, excluded } = mapChangedFiles(changed, model, stamps)

// One line, every run, whenever config excludes anything: nothing is dropped silently.
{
  const ex = excludeInfo()
  if (ex.prefixes.length) console.log(`  excluded by config (routes.exclude): ${ex.routes.length} route(s) under ${ex.prefixes.join(', ')}`)
}

const blocked = []
console.log(`  ${changed.length} changed file(s) since base, ${routes.size} route(s) affected`)
for (const [key, why] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
  const route = model.find((r) => r.key === key)
  const stamp = stamps[key]
  const hash = contentHash(route, stamp?.renderedMedia || [])
  const state = !stamp ? 'MISSING' : stamp.contentHash !== hash ? 'STALE' : 'ok'
  if (state !== 'ok') blocked.push(key)
  const when = stamp ? ` (stamped ${new Date(stamp.reviewedAt).toISOString()})` : ''
  console.log(`  ${state.padEnd(7)} ${key}${state === 'ok' ? when : ''}   <- ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` +${why.length - 3}` : ''}`)
}

if (excluded.length) {
  console.log('\n  excluded by config (not gated):')
  for (const u of excluded) console.log(`    ${u.file}   (only reaches ${u.routes.join(', ')})`)
}

if (uncovered.length) {
  console.log('\n  not covered by page review:')
  for (const u of uncovered) console.log(`    ${u.file}   (${u.why})`)
  console.log('  (changes above can alter pages without triggering a review; check them by hand)')
}

console.log('\n  A stamp proves screenshots and machine checks ran on this exact content. It does not prove anyone looked.')

// AUTO_FOCUS freshness: regenerate in memory from the current faces.json (+ the frozen
// legacy list) and compare byte-for-byte against the committed file. A stale generated file
// would silently ship a crop that does not match what faces.json now knows, or miss a newly
// eligible image -- so this is a hard fail, never a warn, same as a missing stamp. Skipped
// entirely if this project has no focusRegistry.autoPath configured... it always does (it
// defaults to one), so this always runs; projects that never use focusFor() simply never
// see AUTO_FOCUS imported anywhere, which is harmless.
console.log('\n  AUTO_FOCUS registry freshness (generated from .photo-framing/faces.json)')
const expectedAutoFocus = generateAutoFocus(config, { write: false })
const autoFocusFile = autoFocusPath(config)
const actualAutoFocus = existsSync(autoFocusFile) ? readFileSync(autoFocusFile, 'utf8') : null
const autoFocusStale = expectedAutoFocus !== null && expectedAutoFocus !== actualAutoFocus
console.log(autoFocusStale ? `  STALE: ${relative(REPO, autoFocusFile)} does not match faces.json. Run: ${GENERATE_CMD}` : '  ok')

if (!blocked.length && !autoFocusStale) {
  console.log('PAGE REVIEW GATE: pass')
  process.exit(0)
}

const cmdParts = []
if (blocked.length) cmdParts.push(`node node_modules/photo-framing/scripts/page-review.mjs -- ${blocked.map((k) => (/[\[\]]/.test(k) ? `'${k}'` : k)).join(' ')}`)
if (autoFocusStale) cmdParts.push(GENERATE_CMD)
const cmd = cmdParts.join(' && ')
const skip = (process.env.PHOTO_FRAMING_SKIP || '').trim()
if (skip) {
  const who = git('config', 'user.name') || process.env.USER || 'unknown'
  const what = [blocked.length ? `unreviewed: ${blocked.join(' ')}` : null, autoFocusStale ? 'stale: AUTO_FOCUS registry' : null].filter(Boolean).join('; ')
  const line = `${new Date().toISOString()}\t${who}\tHEAD ${git('rev-parse', '--short', 'HEAD')}\t${what}\treason: ${skip}\n`
  mkdirSync(REVIEW_DIR, { recursive: true })
  appendFileSync(SKIP_LOG_PATH, line)
  console.log('\n  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  console.log(`  PAGE REVIEW SKIPPED: ${what}`)
  console.log(`  reason: ${skip}`)
  console.log(`  logged to ${relative(REPO, SKIP_LOG_PATH)} (commit it). Owed: ${cmd}`)
  console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  process.exit(0)
}

console.log(
  `\nPAGE REVIEW GATE: BLOCKED.${blocked.length ? ` ${blocked.length} changed route(s) have no current review stamp.` : ''}` +
    `${autoFocusStale ? ' AUTO_FOCUS registry is out of date vs faces.json.' : ''}`,
)
console.log(`  Run:  ${cmd}`)
if (blocked.length) console.log('  Then open the contact sheets it prints, commit .photo-framing/stamps.json, and deploy again.')
process.exit(1)
