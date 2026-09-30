#!/usr/bin/env node
/**
 * Page review: screenshots + machine checks for changed pages, and the stamp the
 * deploy gate requires.
 *
 * Ported from an existing page-review engine's scripts/page-review.mjs into
 * a portable package. Every project-specific fact -- base URL, where routes live, where
 * images live, viewports, thresholds -- now comes from photo-framing.config.json (see
 * scripts/lib/config.mjs); the checks and behavior below are otherwise unchanged.
 *
 * WHY THIS EXISTS: a page can ship "done" with no visual check: a portrait photo in a
 * landscape desktop hero (face under the title, frame full of ceiling), a poster reusing
 * that photo with the head cut off, a mismatched gallery leaving a black void. "Verify in
 * the browser" as a sentence in a CLAUDE.md or a PR checklist is not a mechanism. This
 * script is the mechanism; wire scripts/page-review-gate.mjs into your deploy script so it
 * refuses to ship a changed route without a stamp from this one.
 *
 * WHAT A STAMP PROVES: screenshots were taken and the machine checks passed on exactly this
 * content. It does NOT prove a person or model looked at the screenshots. Open the contact
 * sheets.
 *
 * Usage:
 *   node node_modules/photo-framing/scripts/page-review.mjs -- /some/route [/other/route] ['/games/[slug]']
 *     Default: builds the current tree, serves it locally, reviews, stamps.
 *   node node_modules/photo-framing/scripts/page-review.mjs -- --base https://example.com /some/route
 *     Checks a live site. Never stamps (live is not this tree).
 *   Flags: --threshold 0.6   --all | --sitemap (every sitemap route)
 *          --no-shots (skip screenshots, checks only; never stamps)
 *          --json <file>     --concurrency N
 *
 * Ratchet baseline (.photo-framing/baseline.json, committed):
 *   every finding is keyed by (url path, viewport, check, image file). A finding whose
 *   key is in the baseline is printed as GRANDFATHERED, counted, and does not fail; any
 *   other finding fails. A changed image file on a route is a new key, so it fails.
 *   Baseline entries for reviewed routes that were not found again are printed as
 *   STALE (fixed); the list only shrinks.
 *     --write-baseline   replace the baseline entries of every route+viewport reviewed
 *                        in this run with this run's findings, and regenerate
 *                        .photo-framing/crop-worst.md + its shots. To rebuild it all:
 *                        node .../page-review.mjs -- --all --base https://example.com --write-baseline
 *     --prune-baseline   drop STALE entries only.
 *     --baseline-add CHECK  add this run's findings of one check (e.g. FACE_CLIPPED) to the
 *                        baseline, leaving every other entry alone. For a new check shipping
 *                        onto a site that already has findings, so the owner decides them.
 *
 * FACE_CLIPPED: needs .photo-framing/faces.json from scripts/detect-faces.py (offline OpenCV
 * YuNet; see scripts/lib/face-clip.mjs for the geometry). A content image this run shows
 * that faces.json does not cover (new, or changed since it was scanned) is NEVER passed
 * silently: page-review auto-runs detect-faces.py --only on exactly those images, reloads
 * faces.json, and re-judges them. If the scan cannot run (no venv, a python error, or an
 * image it could not fetch), the route FAILS with NOT_FACE_CHECKED naming the images and the
 * fix command; it is never grandfathered and never gets a stamp. It also regenerates the
 * AUTO_FOCUS registry (config.focusRegistry.autoPath, scripts/generate-image-focus.mjs) so a
 * new image with a prominent face gets an automatic crop in the same pass.
 *     --face-report      write .photo-framing/face-report.json (committed) grouped by image,
 *                        with a suggested object-position, and copy the evidence shots to
 *                        .photo-framing/face-shots/ (gitignored).
 *     --try-position '<image path>=<css object-position>'  (repeatable) what-if: apply that
 *                        object-position to the image on the page before measuring. Never
 *                        stamps, never writes the baseline or the face report.
 *   PAGE_ERROR is never grandfathered. Routes in the baseline's "neverGrandfather"
 *   list are never baselined or grandfathered (pages owed a fix, not an exemption).
 * Browser: PHOTO_FRAMING_CHROME, else CHROME_PATH, else common Linux/macOS Chrome paths.
 * Exit: 0 all pass, 1 findings, 2 could not run (no browser, build/server failure).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { chromium } from 'playwright-core'
import { loadConfig } from './lib/config.mjs'
import { makeLib } from './lib/page-review-lib.mjs'
import { autoFocusPath, generate as generateAutoFocus } from './lib/image-focus-gen.mjs'
import { neverMatcher } from './lib/never-grandfather.mjs'
import {
  FACE_RULE, BACKDROP_RULE, BACKDROP_MAX_OPACITY, BACKDROP_OVERLAY_ALPHA, BACKDROP_MIN_WIDTH, BACKDROP_SECTION_FILL,
  loadFaces, coverView, clipOf, toBox, extend, positionRange, axisPercent,
} from './lib/face-clip.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const {
  REPO, REVIEW_DIR, STAMPS_PATH, BASELINE_PATH, CROP_WORST_PATH, CROP_WORST_SHOTS, FACES_VENV,
  contentHash, isDynamicKey, keyForUrlPath, planFromUrlPaths, keyMatcher, readStamps, routeModel, excludeInfo, isExcludedPath, resolveRenderedMedia,
} = makeLib(config)

const HONESTY =
  'A stamp proves screenshots were taken and the machine checks passed on this exact content.\n' +
  'It does NOT prove anyone looked. Open the contact sheets before calling the page done.'

// ---------- args ----------
const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i === -1) return dflt
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}
const flag = (name) => {
  const i = argv.indexOf(name)
  if (i === -1) return false
  argv.splice(i, 1)
  return true
}
const BASE_ARG = opt('--base', null)
// Where local runs read remote-hosted media from (see the route handler in reviewPage).
const MEDIA_ORIGIN = (process.env.PHOTO_FRAMING_MEDIA_ORIGIN || config.media.remoteOrigin || config.baseUrl || '').replace(/\/$/, '') || null
const UPLOAD_PREFIXES = config.media.remoteUploadPrefixes || []
const THRESHOLD = Number(opt('--threshold', String(config.threshold)))
const JSON_OUT = opt('--json', null)
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', '1')))
const ALL_SITEMAP = [flag('--sitemap'), flag('--all')].some(Boolean)
const WRITE_BASELINE = flag('--write-baseline')
const PRUNE_BASELINE = flag('--prune-baseline')
const NO_SHOTS = flag('--no-shots')
const BASELINE_ADD = opt('--baseline-add', null)
const FACE_REPORT = flag('--face-report')
const TRY_POSITION = {}
for (let v; (v = opt('--try-position', null)) !== null; ) {
  const i = v.indexOf('=')
  if (i < 1) die(`--try-position needs '<image path>=<object-position>', got ${v}`)
  TRY_POSITION[v.slice(0, i)] = v.slice(i + 1)
}
const WHAT_IF = Object.keys(TRY_POSITION).length > 0
if (WHAT_IF && (WRITE_BASELINE || PRUNE_BASELINE || BASELINE_ADD || FACE_REPORT))
  die('--try-position is a what-if run: it cannot write the baseline or the face report')
const requested = argv.filter((a) => !a.startsWith('--'))
const unknown = argv.filter((a) => a.startsWith('--'))
if (unknown.length) die(`unknown flag(s): ${unknown.join(' ')}`)
if (!requested.length && !ALL_SITEMAP) die('usage: node page-review.mjs -- <route> [<route>...]  (see header of scripts/page-review.mjs)')

function die(msg, code = 2) {
  console.error(`\npage-review: ${msg}`)
  process.exit(code)
}

// ---------- browser ----------
function resolveChrome() {
  const candidates = [
    process.env.PHOTO_FRAMING_CHROME,
    process.env.CHROME_PATH,
    ...(config.chrome.extraCandidates || []),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) {
    die(
      `NO BROWSER FOUND. Looked for: ${candidates.join(', ')}.\n` +
        'Nothing was reviewed. Set PHOTO_FRAMING_CHROME to a Chrome/Chromium binary, or config.chrome.extraCandidates.',
    )
  }
  return hit
}

// ---------- local dev server ----------
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
    s.on('error', rej)
  })

async function startLocal() {
  console.log(`[page-review] building the current tree (${config.devServer.buildCommand}) ...`)
  const [buildCmd, ...buildArgs] = config.devServer.buildCommand.split(' ')
  const b = spawnSync(buildCmd, buildArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (b.status !== 0) {
    console.error((b.stdout || '').slice(-3000), (b.stderr || '').slice(-3000))
    die('BUILD FAILED, nothing reviewed.')
  }
  const port = await freePort()
  const [startCmd, ...startArgsRaw] = config.devServer.startCommand.split(' ')
  const startArgs = startArgsRaw.map((a) => a.replace('{port}', String(port)))
  const child = spawn(startCmd, startArgs, {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(3000) })
      if (r.status < 500) return { base, stop: () => { try { process.kill(-child.pid, 'SIGTERM') } catch {} } }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  console.error(log.slice(-3000))
  die('LOCAL SERVER never answered on ' + base)
}

// ---------- in-page measurement ----------
/** Runs in the browser. Returns every visible content image with what the checks need. */
function measureImages({ tryPos, BAND_MIN_WIDTH, BAND_FILL }) {
  const main = document.querySelector('main') || document.body
  const EXCLUDE = 'header, nav, footer, [role="dialog"], [aria-modal="true"]'
  const imgs = [...main.querySelectorAll('img')].filter((img) => !img.closest(EXCLUDE))
  const underlying = (src) => {
    try {
      const u = new URL(src, location.href)
      if (u.pathname.startsWith('/_next/image')) return decodeURIComponent(u.searchParams.get('url') || src)
      return u.origin === location.origin ? u.pathname : u.href
    } catch {
      return src
    }
  }
  const label = (img) => {
    const sec = img.closest('section')
    const h = sec?.querySelector('h1, h2, h3')
    return (h?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || null
  }
  const flexish = (el) => {
    const d = getComputedStyle(el).display
    return d.includes('grid') || d.includes('flex')
  }
  const out = imgs.map((img, i) => {
    img.dataset.prIdx = String(i)
    const want = tryPos && tryPos[underlying(img.currentSrc || img.src)]
    if (want) img.style.objectPosition = want
    const r = img.getBoundingClientRect()
    const cs = getComputedStyle(img)
    // A carousel/slideshow slide (data-carousel-slide="true") is judged in its slide box
    // even while it is the inactive, opacity:0 slide: with reduced motion stopping the
    // auto-advance (see browser.newContext above) only slide 1 is ever the one actually
    // shown on screen, so without this override every other slide's photo would never be
    // visited by CROP/FACE_CLIPPED at all.
    const carouselSlide = img.dataset.carouselSlide === 'true'
    // on the page horizontally too: carousel slides parked off to the side are not "in view"
    const visible =
      r.width > 1 &&
      r.height > 1 &&
      r.right > 1 &&
      r.left < innerWidth - 1 &&
      (carouselSlide ||
        (img.checkVisibility ? img.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true))
    // decorative/background/parallax layer the reader does not "look at" as content
    // (the rule is DECORATIVE_RULE, printed in the run header; keep the two in step)
    let bg =
      !carouselSlide &&
      (img.closest('[aria-hidden="true"]') !== null ||
        (img.hasAttribute('alt') && img.getAttribute('alt').trim() === ''))
    for (let a = img; a && a !== main && !bg; a = a.parentElement) {
      if (getComputedStyle(a).pointerEvents === 'none') bg = true
    }
    const okEl = img.closest('[data-crop-ok]')
    const galleryOkEl = img.closest('[data-gallery-ok]')
    // grid/flex ancestors up to 6 levels, recorded as (ancestor id, direct child id)
    const chain = []
    let child = img
    for (let a = img.parentElement, n = 0; a && a !== main && n < 6; a = a.parentElement, n++) {
      if (flexish(a)) {
        a.dataset.prGrp ??= String(Math.random()).slice(2, 10)
        chain.push(a.dataset.prGrp)
      }
      child = a
    }
    return {
      i,
      file: underlying(img.currentSrc || img.src),
      alt: (img.getAttribute('alt') || '').slice(0, 80),
      section: label(img),
      box: { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      nat: { w: img.naturalWidth, h: img.naturalHeight },
      complete: img.complete,
      fit: cs.objectFit,
      objPos: cs.objectPosition,
      visible,
      bg,
      cropOk: okEl ? okEl.getAttribute('data-crop-ok') || '(empty reason)' : null,
      galleryOk: galleryOkEl ? galleryOkEl.getAttribute('data-gallery-ok') || '(empty reason)' : null,
      chain,
    }
  })
  // Backdrop probe (BACKDROP_RULE in scripts/lib/face-clip.mjs): only wide images below the
  // first viewport, so heroes and ordinary cards never pay for the scroll.
  const alphaOf = (c) => {
    if (!c || c === 'transparent') return 0
    const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)$/)
    if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1)
    const m = c.match(/^rgba\(([^)]*)\)$/)
    if (m) return parseFloat(m[1].split(',')[3])
    return 1
  }
  const layerAlpha = (el) => {
    const cs = getComputedStyle(el)
    let a = alphaOf(cs.backgroundColor)
    for (const g of cs.backgroundImage.match(/(?:rgba?|oklab|oklch|lab|lch|hsla?|color)\([^()]*\)|transparent/g) || []) a = Math.max(a, alphaOf(g))
    let op = 1
    for (let x = el; x; x = x.parentElement) op *= parseFloat(getComputedStyle(x).opacity)
    return a * op
  }
  for (const m of out) {
    const img = imgs[m.i]
    if (!m.visible || m.box.w < innerWidth * BAND_MIN_WIDTH || m.box.y < innerHeight) continue
    // a band backdrop fills its section; a full-width card on a phone does not
    const sec = img.closest('section')?.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    if (!sec || ir.width * ir.height < BAND_FILL * sec.width * sec.height) continue
    let op = 1
    for (let x = img; x; x = x.parentElement) {
      const cs = getComputedStyle(x)
      op *= parseFloat(cs.opacity)
      const b = cs.filter.match(/brightness\(([\d.]+)(%?)\)/)
      if (b) op *= parseFloat(b[1]) / (b[2] ? 100 : 1)
    }
    img.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = img.getBoundingClientRect()
    let heading = false, action = false
    // text painted over the image: a heading or link/button (not the image's own ancestor)
    // whose centre lies inside the image and whose hit-test stack has the image underneath it
    for (const el of main.querySelectorAll('h1, h2, h3, h4, h5, h6, a, button')) {
      if (el.contains(img)) continue
      const isHeading = /^H[1-6]$/.test(el.tagName)
      if (isHeading ? heading : action) continue
      const e = el.getBoundingClientRect()
      const px = e.left + e.width / 2, py = e.top + e.height / 2
      if (!e.width || px < r.left || px > r.right || py < r.top || py > r.bottom || py < 0 || py > innerHeight) continue
      const stack = document.elementsFromPoint(px, py)
      const at = stack.indexOf(img)
      if (at > 0 && stack.slice(0, at).some((x) => el.contains(x) || x.contains(el))) {
        if (isHeading) heading = true
        else action = true
      }
    }
    // overlay: every layer painted above the image's centre, combined
    const cy = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2))
    const stack = document.elementsFromPoint(r.left + r.width / 2, cy)
    const at = stack.indexOf(img)
    const above = at > 0 ? stack.slice(0, at).filter((el) => !el.contains(img)) : []
    const overlay = 1 - above.reduce((keep, el) => keep * (1 - layerAlpha(el)), 1)
    m.backdrop = { opacity: Number(op.toFixed(2)), overlay: Number(overlay.toFixed(2)), heading, action }
  }
  return out
}

// ---------- checks (node side) ----------
function checks(imgs, vpName, faceUsages = [], notes = [], unscannedHits = []) {
  const findings = []
  const content = imgs.filter((m) => m.visible)
  const f = (type, m, detail, extra = {}) =>
    findings.push({ type, viewport: vpName, file: m.file, keyFile: m.file, idx: m.i, section: m.section, detail, box: m.box, nat: m.nat, ...extra })

  for (const m of content) {
    if (!m.nat.w) f('IMAGE_LOADS', m, 'naturalWidth is 0 after scrolling into view')
  }
  for (const m of content) {
    if (!m.nat.w || m.fit !== 'cover' || m.cropOk || m.bg) continue
    const boxAR = m.box.w / m.box.h
    const natAR = m.nat.w / m.nat.h
    const vis = Math.min(boxAR / natAR, natAR / boxAR)
    m.visibleFraction = vis
    if (vis < THRESHOLD)
      f(
        'CROP',
        m,
        `visible ${vis.toFixed(2)} < ${THRESHOLD} (box ${m.box.w}x${m.box.h} AR ${boxAR.toFixed(2)}, photo ${m.nat.w}x${m.nat.h} AR ${natAR.toFixed(2)}). If a human checked this crop, mark it data-crop-ok="<reason>"`,
        { fraction: Number(vis.toFixed(3)) },
      )
  }
  // FACE_CLIPPED (+ report-only EDGE_BYSTANDER, BACKDROP_CANDIDATE): same exemptions as CROP
  // (data-crop-ok, decorative). Rule text: FACE_RULE and BACKDROP_RULE.
  for (const m of content) {
    if (!FACES || !m.nat.w || m.fit !== 'cover' || m.cropOk || m.bg) continue
    const faces = FACES.lookup(m.file)
    if (!faces) {
      unscannedHits.push({ file: m.file, viewport: vpName })
      continue
    }
    const bd = m.backdrop
    if (bd && bd.heading && bd.action && (bd.opacity < BACKDROP_MAX_OPACITY || bd.overlay >= BACKDROP_OVERLAY_ALPHA)) {
      notes.push({
        type: 'BACKDROP_CANDIDATE', viewport: vpName, file: m.file, idx: m.i, section: m.section, box: m.box, nat: m.nat, objPos: m.objPos,
        detail: `dimmed backdrop behind CTA text (opacity ${bd.opacity}, overlay alpha ${bd.overlay}): mark decorative`,
        backdrop: bd, mainFaces: faces.main.length,
        overlay: [...faces.main, ...faces.bystanders].map((face) => { const v = coverView(m.box, m.nat, m.objPos); return [toBox(v, face), toBox(v, extend(face)), false, 'backdrop'] }),
      })
      continue
    }
    if (!faces.main.length && !faces.bystanders.length) continue
    const view = coverView(m.box, m.nat, m.objPos)
    const judge = (list) => list.map((face) => ({ face, clip: clipOf(view, m.box, face) }))
    const mainC = judge(faces.main), byC = judge(faces.bystanders)
    const visibleOf = (c) => (c.clip ? c.clip.faceVisible : 1)
    const worstMain = mainC.length ? Math.min(...mainC.map(visibleOf)) : null
    faceUsages.push({ viewport: vpName, file: m.file, box: m.box, nat: m.nat, objPos: m.objPos, section: m.section, worstMain })
    const overlay = [
      ...mainC.map((c) => [toBox(view, c.face), toBox(view, extend(c.face)), !!c.clip]),
      ...byC.map((c) => [toBox(view, c.face), toBox(view, extend(c.face)), !!c.clip, 'bystander']),
    ]
    const sidesOf = (bad) => {
      const sides = {}
      for (const { clip } of bad) for (const sd of clip.sides) sides[sd.side] = Math.max(sides[sd.side] || 0, sd.share)
      return sides
    }
    const pctTxt = (sides) => Object.entries(sides).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ') || 'face'
    const badMain = mainC.filter((c) => c.clip)
    if (badMain.length) {
      const sides = sidesOf(badMain)
      f(
        'FACE_CLIPPED',
        m,
        `${badMain.length}/${mainC.length} main-subject face(s) cut: ${pctTxt(sides)} of face+hair, worst main face ${Math.round(worstMain * 100)}% visible (box ${m.box.w}x${m.box.h}, object-position ${m.objPos}). Human-checked? mark it data-crop-ok="<reason>"`,
        { sides, worstVisible: worstMain, mainFaces: mainC.length, objPos: m.objPos, overlay },
      )
      continue
    }
    const badBy = byC.filter((c) => c.clip)
    if (badBy.length) {
      const sides = sidesOf(badBy)
      notes.push({
        type: 'EDGE_BYSTANDER', viewport: vpName, file: m.file, idx: m.i, section: m.section, box: m.box, nat: m.nat, objPos: m.objPos,
        detail: `${badBy.length} bystander face(s) cut at the frame edge (${pctTxt(sides)}); ${mainC.length} main face(s) fully in frame`,
        sides, worstVisible: Math.min(...badBy.map(visibleOf)), worstMain, mainFaces: mainC.length, overlay,
      })
    }
  }
  const byFile = new Map()
  for (const m of content.filter((x) => !x.bg)) {
    if (!byFile.has(m.file)) byFile.set(m.file, [])
    byFile.get(m.file).push(m)
  }
  for (const [file, list] of byFile) {
    if (list.length > 1)
      f('DUPLICATE_IMAGE', list[0], `used ${list.length}x in content: ${list.map((x) => x.section || x.alt || '?').join(' | ')}`)
  }
  // GALLERY_MISMATCH: siblings in one grid/flex parent, side by side in a row, shown at their
  // natural aspect, whose aspect ratios differ by more than 1.5x AND whose rendered heights
  // differ by more than 1.5x (the uneven-heights void). A justified strip (equal heights,
  // natural widths) differs in aspect but leaves no void, so it passes.
  const painted = (m) => {
    const boxAR = m.box.w / m.box.h
    const natAR = m.nat.w / m.nat.h
    if (m.fit === 'contain' || m.fit === 'scale-down' || m.fit === 'none') return natAR
    return boxAR
  }
  const natural = (m) => {
    if (!m.nat.w) return false
    const natAR = m.nat.w / m.nat.h
    return Math.abs(Math.log(painted(m) / natAR)) < Math.log(1.15)
  }
  const pool = content.filter((m) => !m.bg && !m.galleryOk && m.box.w >= 100 && m.box.h >= 100 && natural(m))
  const groupCount = new Map()
  for (const m of pool) for (const g of new Set(m.chain)) groupCount.set(g, (groupCount.get(g) || 0) + 1)
  const groups = new Map()
  for (const m of pool) {
    const g = m.chain.find((id) => groupCount.get(id) >= 2)
    if (!g) continue
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(m)
  }
  for (const list of groups.values()) {
    const bad = new Set()
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b]
        const overlapY = Math.min(A.box.y + A.box.h, B.box.y + B.box.h) - Math.max(A.box.y, B.box.y)
        if (overlapY <= 0) continue // stacked, not side by side
        const r = painted(A) / painted(B)
        const hr = A.box.h / B.box.h
        if (Math.max(r, 1 / r) > 1.5 && Math.max(hr, 1 / hr) > 1.5) {
          bad.add(A)
          bad.add(B)
        }
      }
    if (bad.size) {
      const arr = [...bad]
      f(
        'GALLERY_MISMATCH',
        arr[0],
        `row of ${arr.length} images at natural aspect with ratios ${arr.map((x) => painted(x).toFixed(2)).join(', ')} (heights ${arr.map((x) => x.box.h).join('/')}px): uneven row leaves dead space. Files: ${arr.map((x) => x.file.split('/').pop()).join(', ')}. Deliberate? mark the grid data-gallery-ok="<reason>"`,
        { keyFile: arr.map((x) => x.file).sort().join(' + ') },
      )
    }
  }
  return findings
}

// ---------- per page ----------
const VIEWPORTS = config.viewports
/** Third-party noise the review must not load. Add your own (analytics, chat widgets) to config.blockRequestPatterns. */
const BLOCK = new RegExp(config.blockRequestPatterns.join('|'))
const slugOf = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^A-Za-z0-9._-]+/g, '_'))
/** Evidence shot for a CROP finding. Derived from (route, viewport, file) alone, so a baseline entry can find it later. */
const cropShotPath = (path, vpName, file) =>
  join(REVIEW_DIR, 'shots', slugOf(path), `crop-${vpName}-${createHash('sha1').update(file).digest('hex').slice(0, 10)}.png`)

/** Evidence shot for a FACE_CLIPPED finding, same derivation rule as cropShotPath. */
const faceShotPath = (path, vpName, file, type = 'FACE_CLIPPED') =>
  join(REVIEW_DIR, 'shots', slugOf(path), `${type === 'FACE_CLIPPED' ? 'face' : type.toLowerCase().replace('_', '-')}-${vpName}-${createHash('sha1').update(file).digest('hex').slice(0, 10)}.png`)

async function reviewPage(browser, base, path) {
  const results = { path, findings: [], sheets: [], errors: [], faceUsages: [], notes: [], unscannedHits: [], rendered: [] }
  const shotDir = join(REVIEW_DIR, 'shots', slugOf(path))
  if (!NO_SHOTS) {
    rmSync(shotDir, { recursive: true, force: true })
    mkdirSync(shotDir, { recursive: true })
  }
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      userAgent: vp.userAgent,
      deviceScaleFactor: 1,
      // Determinism: without this, auto-advancing carousels/slideshows show whichever slide
      // the interval happened to land on when the screenshot fired, so the same route
      // produced different findings run to run. Emulating prefers-reduced-motion:reduce
      // makes every such component stop auto-advancing/animating, same as a real visitor who
      // has reduced motion on. See measureImages' data-carousel-slide handling above for how
      // every slide still gets judged despite only slide 1 ever being opacity-visible now.
      reducedMotion: 'reduce',
    })
    await ctx.route('**/*', async (r) => {
      const url = r.request().url()
      if (BLOCK.test(url)) return r.abort()
      // Remote-hosted media (e.g. CMS uploads) live only on the deployed target, never in
      // git, so a local build 404s them. Local runs read those files (and any framework
      // image-optimizer variants of them) from MEDIA_ORIGIN, read-only.
      if (!BASE_ARG && UPLOAD_PREFIXES.length) {
        const u = new URL(url)
        const isMedia =
          UPLOAD_PREFIXES.some((p) => u.pathname.startsWith(p)) ||
          (u.pathname === '/_next/image' && UPLOAD_PREFIXES.some((p) => (u.searchParams.get('url') || '').startsWith(p)))
        // Images only: videos are range requests the checks never measure.
        if (isMedia && r.request().resourceType() === 'image') {
          if (!MEDIA_ORIGIN) return r.continue() // no origin configured; falls through to local 404
          try {
            return await r.fulfill({ response: await r.fetch({ url: MEDIA_ORIGIN + u.pathname + u.search }) })
          } catch {
            return r.continue() // falls through to the local 404, which IMAGE_LOADS then reports
          }
        }
      }
      return r.continue()
    })
    const page = await ctx.newPage()
    try {
      const resp = await page.goto(base + path, { waitUntil: 'load', timeout: 60000 })
      const status = resp?.status() ?? 0
      if (status >= 400) {
        results.findings.push({ type: 'PAGE_ERROR', viewport: vp.name, detail: `HTTP ${status}` })
        continue
      }
      await page.waitForTimeout(800)
      const shots = []
      const vh = vp.height
      for (let n = 0, y = 0; n < 40; n++) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y)
        await page.waitForTimeout(450)
        if (!NO_SHOTS) {
          const file = join(shotDir, `${vp.name}-${String(n + 1).padStart(2, '0')}.png`)
          await page.screenshot({ path: file })
          shots.push(file)
        }
        const total = await page.evaluate(() => document.documentElement.scrollHeight)
        if (y + vh >= total) break
        y += vh
      }
      // give late lazy images a moment to finish decoding
      await page.evaluate(
        () =>
          Promise.race([
            Promise.all(
              [...document.querySelectorAll('main img')].map((i) =>
                i.complete ? 0 : new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) }),
              ),
            ),
            new Promise((r) => setTimeout(r, 6000)),
          ]),
      )
      // second chance for stragglers: bring each unloaded image into view and wait for it
      // (bounded), so a slow network reads as slow, not as a broken image
      await page.evaluate(async () => {
        const deadline = Date.now() + 20000
        for (const img of document.querySelectorAll('main img')) {
          if (Date.now() > deadline) break
          if (img.complete && img.naturalWidth > 0) continue
          img.scrollIntoView({ block: 'center' })
          await new Promise((r) => {
            if (img.complete && img.naturalWidth > 0) return r()
            img.addEventListener('load', r, { once: true })
            img.addEventListener('error', r, { once: true })
            setTimeout(r, 5000)
          })
        }
      })
      const imgs = await page.evaluate(measureImages, { tryPos: TRY_POSITION, BAND_MIN_WIDTH: BACKDROP_MIN_WIDTH, BAND_FILL: BACKDROP_SECTION_FILL })
      // every local image this page actually rendered, for the stamp's rendered-media list
      results.rendered.push(...imgs.map((im) => im.file))
      const notes = []
      const found = checks(imgs, vp.name, results.faceUsages, notes, results.unscannedHits)
      results.notes.push(...notes)
      results.findings.push(...found)
      // CROP evidence: the viewport with the offending image centred and outlined, so a
      // reviewer sees the crop as a visitor does without paging through the whole sheet
      if (!NO_SHOTS) {
        for (const fd of found.filter((x) => x.type === 'CROP')) {
          const file = cropShotPath(path, vp.name, fd.file)
          const ok = await page.evaluate((i) => {
            const el = document.querySelector(`img[data-pr-idx="${i}"]`)
            if (!el) return false
            el.scrollIntoView({ block: 'center', behavior: 'instant' })
            el.dataset.prOutline = el.style.outline
            el.style.outline = '4px solid #ff0040'
            el.style.outlineOffset = '-4px'
            return true
          }, fd.idx)
          if (!ok) continue
          await page.waitForTimeout(300)
          await page.screenshot({ path: file })
          await page.evaluate((i) => {
            const el = document.querySelector(`img[data-pr-idx="${i}"]`)
            if (el) el.style.outline = el.dataset.prOutline || ''
          }, fd.idx)
          fd.shot = relative(REPO, file)
        }
      }
      // FACE_CLIPPED evidence: the image alone (plus a margin, so the cut part of a red box
      // shows past the frame edge) with every detected face drawn: red = clipped, green = in frame.
      // Solid = the detected face, dashed = face + hair extension the rule checks.
      if (!NO_SHOTS) {
        for (const fd of [...found.filter((x) => x.type === 'FACE_CLIPPED'), ...notes]) {
          const file = faceShotPath(path, vp.name, fd.file, fd.type)
          const rect = await page.evaluate(
            ({ i, overlay }) => {
              const el = document.querySelector(`img[data-pr-idx="${i}"]`)
              if (!el) return null
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              const r = el.getBoundingClientRect()
              const layer = document.createElement('div')
              layer.id = 'pr-face-layer'
              layer.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:2147483647;pointer-events:none;outline:2px solid #ffd400`
              for (const [face, ext, clipped, bystander] of overlay) {
                const color = bystander === 'backdrop' ? '#bbbbbb' : clipped ? (bystander ? '#ff9900' : '#ff0033') : bystander ? '#3fa0ff' : '#00d060'
                for (const [b, style] of [[face, 'solid'], [ext, 'dashed']]) {
                  const d = document.createElement('div')
                  d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:3px ${style} ${color};box-sizing:border-box`
                  layer.appendChild(d)
                }
              }
              document.body.appendChild(layer)
              return { x: r.left, y: r.top, w: r.width, h: r.height }
            },
            { i: fd.idx, overlay: fd.overlay },
          )
          if (!rect) continue
          const pad = 60
          const x = Math.max(0, rect.x - pad), y = Math.max(0, rect.y - pad)
          const clip = { x, y, width: Math.min(vp.width, rect.x + rect.w + pad) - x, height: Math.min(vp.height, rect.y + rect.h + pad) - y }
          await page.waitForTimeout(300)
          if (clip.width > 0 && clip.height > 0) {
            await page.screenshot({ path: file, clip })
            fd.shot = relative(REPO, file)
          }
          await page.evaluate(() => document.getElementById('pr-face-layer')?.remove())
        }
      }
      for (const fd of [...found, ...notes]) delete fd.overlay
      if (!NO_SHOTS && shots.length) {
        const sheet = join(shotDir, `${vp.name}-sheet.jpg`)
        await contactSheet(shots, vp, sheet)
        results.sheets.push(relative(REPO, sheet))
      }
    } catch (e) {
      results.findings.push({ type: 'PAGE_ERROR', viewport: vp.name, detail: e.message.split('\n')[0] })
    } finally {
      await ctx.close()
    }
  }
  return results
}

async function contactSheet(shots, vp, out) {
  const tw = vp.thumbW
  const th = Math.round((vp.height / vp.width) * tw)
  const gap = 8
  const cols = Math.min(vp.cols, shots.length)
  const rows = Math.ceil(shots.length / cols)
  const tiles = await Promise.all(
    shots.map(async (s, i) => ({
      input: await sharp(s).resize(tw, th, { fit: 'cover', position: 'top' }).toBuffer(),
      left: gap + (i % cols) * (tw + gap),
      top: gap + Math.floor(i / cols) * (th + gap),
    })),
  )
  await sharp({
    create: { width: gap + cols * (tw + gap), height: gap + rows * (th + gap), channels: 3, background: '#808080' },
  })
    .composite(tiles)
    .jpeg({ quality: 78 })
    .toFile(out)
}

// ---------- main ----------
const model = routeModel()
const keys = model.map((r) => r.key)
const chrome = resolveChrome()
let server = null
let base = BASE_ARG?.replace(/\/$/, '')
const local = !base
const hashBefore = new Map(model.map((r) => [r.key, contentHash(r)]))
if (local) {
  server = await startLocal()
  base = server.base
}
process.on('exit', () => server?.stop())

// Expand requested routes into concrete URL paths; dynamic keys expand via the served sitemap.
let sitemapPaths = null
let sitemapExcluded = 0
async function sitemap() {
  if (sitemapPaths) return sitemapPaths
  const xml = await (await fetch(base + '/sitemap.xml')).text()
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, '') || '/')
  sitemapPaths = all.filter((p) => !isExcludedPath(p))
  sitemapExcluded = all.length - sitemapPaths.length
  return sitemapPaths
}
const plan = [] // { key|null, paths[] }
if (ALL_SITEMAP) plan.push(...planFromUrlPaths(await sitemap(), keys))
const requestedExcluded = requested.filter((r) => isExcludedPath(r))
for (const r of requested.filter((r) => !isExcludedPath(r))) {
  if (isDynamicKey(r)) {
    const re = keyMatcher(r)
    const paths = (await sitemap()).filter((p) => re.test(p))
    if (!paths.length) die(`no sitemap URLs match ${r}; nothing to review for it (pass concrete URLs instead)`)
    plan.push({ key: keys.includes(r) ? r : null, paths })
  } else {
    const key = keyForUrlPath(r, keys)
    // a concrete URL under a dynamic route reviews that URL only; it cannot stamp the whole pattern
    plan.push({ key: key && !isDynamicKey(key) ? key : null, paths: [r], partialOf: key && isDynamicKey(key) ? key : null })
  }
}

// One line, every run, whenever config excludes anything: nothing is dropped silently.
{
  const ex = excludeInfo()
  if (ex.prefixes.length)
    console.log(
      `[page-review] excluded by config (routes.exclude): ${ex.routes.length} route(s) under ${ex.prefixes.join(', ')}` +
        `${sitemapExcluded ? `; ${sitemapExcluded} sitemap URL(s) skipped` : ''}` +
        `${requestedExcluded.length ? `; requested but skipped: ${requestedExcluded.join(', ')}` : ''}`,
    )
  if (!plan.length) die('nothing to review: every requested route is excluded by config (routes.exclude)')
}

// ---------- ratchet baseline ----------
const normPath = (p) => p.replace(/\/+$/, '') || '/'
const findingKey = (path, fd) => [normPath(path), fd.viewport, fd.type, fd.keyFile || ''].join(' | ')
const baselineDoc = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : { neverGrandfather: [], entries: [] }
const NEVER = new Set((baselineDoc.neverGrandfather || []).map(normPath))
const isNever = neverMatcher([...NEVER])
const baseline = new Map(baselineDoc.entries.map((e) => [e.key, e]))
/** Grandfathered = in the baseline (or about to be, under --write-baseline). PAGE_ERROR and
 * NOT_FACE_CHECKED never are: a missing or unscannable image is never quietly waved through. */
const grandfathered = (path, fd) =>
  fd.type !== 'PAGE_ERROR' &&
  fd.type !== 'NOT_FACE_CHECKED' &&
  !isNever(path) &&
  (WRITE_BASELINE || (BASELINE_ADD && fd.type === BASELINE_ADD) || baseline.has(findingKey(path, fd)))

let FACES = loadFaces(config)
const DECORATIVE_RULE =
  'decorative = the img or an ancestor has aria-hidden="true", OR the img has alt="" (present and empty), OR the img or an ancestor inside <main> has computed pointer-events:none'
console.log(`[page-review] base ${base}  threshold ${THRESHOLD}  browser ${chrome}  reduced-motion (deterministic carousels)`)
if (!BASE_ARG && UPLOAD_PREFIXES.length) console.log(`[page-review] local run: ${UPLOAD_PREFIXES.join(', ')} are read from ${MEDIA_ORIGIN || '(no origin configured)'}, because they are not in git.`)
console.log(`[page-review] CROP rule: object-fit:cover content image with visible fraction < ${THRESHOLD}.`)
console.log(`              EXEMPT from CROP: data-crop-ok on the img or an ancestor, and decorative layers.`)
console.log(`              ${DECORATIVE_RULE} (same rule exempts DUPLICATE_IMAGE and GALLERY_MISMATCH).`)
console.log(`              A data-carousel-slide="true" img is judged in its slide box regardless of the above: every slide, not just the one on screen.`)
console.log(`[page-review] ${FACE_RULE}`)
console.log(`              EXEMPT from FACE_CLIPPED: the same data-crop-ok and decorative rules as CROP.`)
console.log(`[page-review] ${BACKDROP_RULE}`)
console.log(
  FACES
    ? `              faces: ${FACES.count} image(s) in .photo-framing/faces.json (${FACES.generated}), minScore ${FACES.minScore}`
    : '              FACE_CLIPPED NOT RUN: .photo-framing/faces.json is missing. Run scripts/detect-faces.py (see its header).',
)
if (WHAT_IF) console.log(`[page-review] WHAT-IF run, object-position overridden for: ${Object.entries(TRY_POSITION).map(([k, v]) => `${k} = ${v}`).join('; ')}`)
console.log(
  `[page-review] baseline: ${existsSync(BASELINE_PATH) ? `${baseline.size} grandfathered finding(s) in ${relative(REPO, BASELINE_PATH)}` : 'none (every finding fails)'}` +
    `${NEVER.size ? `; never grandfathered: ${[...NEVER].join(', ')}` : ''}${WRITE_BASELINE ? '  [--write-baseline]' : ''}`,
)
const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const allPaths = [...new Set(plan.flatMap((p) => p.paths))]
const byPath = new Map()
let next = 0
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, allPaths.length) }, async () => {
    while (next < allPaths.length) {
      const p = allPaths[next++]
      const t0 = Date.now()
      const r = await reviewPage(browser, base, p)
      r.seconds = Math.round((Date.now() - t0) / 1000)
      for (const f of r.findings) {
        f.key = findingKey(p, f)
        f.grandfathered = grandfathered(p, f)
      }
      r.failing = r.findings.filter((f) => !f.grandfathered)
      byPath.set(p, r)
      const n = r.failing.length
      const g = r.findings.length - n
      console.log(`\n${n ? 'FAIL' : 'PASS'}  ${p}${n ? `  (${n} finding${n > 1 ? 's' : ''})` : ''}${g ? `  (${g} grandfathered)` : ''}  ${r.seconds}s`)
      for (const f of [...r.failing, ...r.findings.filter((x) => x.grandfathered)])
        console.log(
          `  ${f.grandfathered ? 'grandfathered ' : ''}${f.type.padEnd(16)} ${f.viewport.padEnd(7)} ${f.file ? f.file + '  ' : ''}${f.section ? `[${f.section}]  ` : ''}${f.detail}`,
        )
      for (const n of r.notes) console.log(`  report-only ${n.type.padEnd(18)} ${n.viewport.padEnd(7)} ${n.file}  ${n.section ? `[${n.section}]  ` : ''}${n.detail}`)
      for (const s of r.sheets) console.log(`  sheet: ${s}`)
    }
  }),
)

// ---------- fail closed on unscanned images: auto-scan, then re-judge ----------
// A content image missing from faces.json (new, or changed since scanned) is never just
// noted and passed: run detect-faces.py --only on exactly those paths, reload faces.json,
// and re-review the affected routes so FACE_CLIPPED actually judges them this run. Any
// image still unscanned afterward (no venv, a python error, or unreachable) fails its
// route(s) with NOT_FACE_CHECKED, which is never grandfathered (see grandfathered() above).
{
  const affectedPaths = allPaths.filter((p) => (byPath.get(p).unscannedHits || []).length)
  if (affectedPaths.length) {
    const files = [...new Set(affectedPaths.flatMap((p) => byPath.get(p).unscannedHits.map((h) => h.file)))].sort()
    console.log(`\n[page-review] ${files.length} content image(s) missing from faces.json or changed since it was written:`)
    for (const f of files) console.log(`  ${f}`)
    const venvPy = join(FACES_VENV, 'bin', 'python')
    const venvRel = relative(REPO, FACES_VENV)
    const detectScript = join(SCRIPT_DIR, 'detect-faces.py')
    const requirementsPath = join(SCRIPT_DIR, '..', 'faces', 'requirements.txt')
    const SETUP = [`python3 -m venv ${venvRel}`, `${venvRel}/bin/pip install -r ${relative(REPO, requirementsPath)}`]
    console.log('[page-review] auto-scanning before judging FACE_CLIPPED on them ...')
    let ran = false
    if (!existsSync(venvPy)) {
      console.log(`  CANNOT AUTO-SCAN: ${venvRel} is missing. Set it up with:`)
      for (const c of SETUP) console.log(`    ${c}`)
    } else {
      const origin = BASE_ARG || MEDIA_ORIGIN
      const args = [detectScript, '--only', ...files, '--project-root', REPO]
      if (origin) args.push('--base', origin)
      const res = spawnSync(venvPy, args, { cwd: REPO, encoding: 'utf8' })
      for (const l of (res.stdout || '').split('\n')) if (l.trim()) console.log('  ' + l)
      for (const l of (res.stderr || '').split('\n')) if (l.trim()) console.log('  [stderr] ' + l)
      if (res.error) console.log(`  detect-faces.py FAILED TO START: ${res.error.message}`)
      ran = !res.error
      if (ran) {
        FACES = loadFaces(config)
        console.log(`[page-review] regenerating ${relative(REPO, autoFocusPath(config))} ...`)
        const gen = spawnSync(process.execPath, [join(SCRIPT_DIR, 'generate-image-focus.mjs')], { cwd: REPO, encoding: 'utf8' })
        for (const l of (gen.stdout || '').split('\n')) if (l.trim()) console.log('  ' + l)
        if (gen.stderr && gen.stderr.trim()) console.log('  [stderr] ' + gen.stderr.trim())
      }
    }
    console.log(`\n[page-review] re-checking ${affectedPaths.length} route(s)${ran ? ' with updated face data' : ''}: ${affectedPaths.join(', ')}`)
    for (const p of affectedPaths) {
      if (ran) {
        const t0 = Date.now()
        const r = await reviewPage(browser, base, p)
        r.seconds = Math.round((Date.now() - t0) / 1000)
        for (const f of r.findings) {
          f.key = findingKey(p, f)
          f.grandfathered = grandfathered(p, f)
        }
        r.failing = r.findings.filter((f) => !f.grandfathered)
        byPath.set(p, r)
      }
      const r = byPath.get(p)
      const byVp = new Map()
      for (const h of r.unscannedHits || []) {
        if (!byVp.has(h.viewport)) byVp.set(h.viewport, new Set())
        byVp.get(h.viewport).add(h.file)
      }
      for (const [viewport, fileSet] of byVp) {
        const list = [...fileSet].sort()
        const fd = {
          type: 'NOT_FACE_CHECKED',
          viewport,
          file: list[0],
          keyFile: list.join(' + '),
          detail:
            `${list.length} content image(s) could not be face-checked: ${list.join(', ')}. ` +
            `Not scanned: ${ran ? 'detect-faces.py ran but could not process them, see the log above' : `${venvRel} is missing`}. ` +
            `Fix: ${SETUP.join(' && ')} (if missing), then ` +
            `${venvRel}/bin/python ${relative(REPO, detectScript)} --only ${list.join(' ')}${BASE_ARG || MEDIA_ORIGIN ? ` --base ${BASE_ARG || MEDIA_ORIGIN}` : ''}, then re-run page-review.`,
        }
        fd.key = findingKey(p, fd)
        fd.grandfathered = grandfathered(p, fd)
        r.findings.push(fd)
        if (!fd.grandfathered) r.failing.push(fd)
      }
      if (!ran || byVp.size) {
        const n = r.failing.length
        console.log(`${n ? 'FAIL' : 'PASS'}  ${p}  (re-checked after auto-scan)${n ? `  (${n} finding${n > 1 ? 's' : ''})` : ''}`)
        for (const [viewport, fileSet] of byVp) console.log(`  NOT_FACE_CHECKED   ${viewport.padEnd(7)} ${[...fileSet].join(', ')}`)
      } else {
        console.log(`PASS  ${p}  (re-checked after auto-scan)`)
      }
    }
  }
}

await browser.close()

// ---------- baseline: stale, prune, write ----------
// A (route, viewport) counts as re-checked only if it ran without PAGE_ERROR this run.
const checkedRV = new Set()
for (const p of allPaths)
  for (const vp of VIEWPORTS)
    if (!byPath.get(p).findings.some((f) => f.type === 'PAGE_ERROR' && f.viewport === vp.name)) checkedRV.add(`${normPath(p)} | ${vp.name}`)
const foundKeys = new Set(allPaths.flatMap((p) => byPath.get(p).findings.map((f) => f.key)))
const rvOf = (e) => `${e.route} | ${e.viewport}`
const stale = [...baseline.values()].filter((e) => checkedRV.has(rvOf(e)) && !foundKeys.has(e.key))
if (stale.length) {
  console.log(`\nSTALE baseline entries (${stale.length}): no longer found, so fixed. ${PRUNE_BASELINE || WRITE_BASELINE ? 'Removing them.' : 'Remove with --prune-baseline.'}`)
  for (const e of stale) console.log(`  stale  ${e.key}`)
}
const allFindings = allPaths.flatMap((p) => byPath.get(p).findings.map((f) => ({ ...f, path: normPath(p) })))
const unchecked = allPaths.length * VIEWPORTS.length - checkedRV.size
if (unchecked && (WRITE_BASELINE || PRUNE_BASELINE))
  console.log(`\n${unchecked} route+viewport(s) hit PAGE_ERROR: NOT re-checked, their baseline entries are left as they were. Re-run those routes.`)
let written = null
if (WRITE_BASELINE || BASELINE_ADD || (PRUNE_BASELINE && stale.length)) {
  const keep = [...baseline.values()].filter((e) =>
    WRITE_BASELINE ? !checkedRV.has(rvOf(e)) : BASELINE_ADD ? !(e.check === BASELINE_ADD && checkedRV.has(rvOf(e))) : !stale.includes(e),
  )
  const next = new Map(keep.map((e) => [e.key, e]))
  if (WRITE_BASELINE || BASELINE_ADD) {
    for (const f of allFindings) {
      if (f.type === 'PAGE_ERROR' || isNever(f.path)) continue
      if (BASELINE_ADD && f.type !== BASELINE_ADD) continue
      const e = { key: f.key, route: f.path, viewport: f.viewport, check: f.type, file: f.keyFile || '' }
      if (f.fraction != null) e.fraction = f.fraction
      if (f.box) e.box = `${f.box.w}x${f.box.h}`
      if (f.sides) e.cut = f.sides
      const prev = next.get(f.key)
      if (!prev || (e.fraction ?? 1) < (prev.fraction ?? 1)) next.set(f.key, e)
    }
  }
  const baseDoc = {
    about:
      'page-review ratchet baseline. Findings listed here are grandfathered: printed and counted, never failing. ' +
      'Anything not listed fails. The list only shrinks: fix a page, then --prune-baseline. See scripts/page-review.mjs.',
    generated: WRITE_BASELINE ? { base, threshold: THRESHOLD, routes: allPaths.length, at: new Date().toISOString() } : baselineDoc.generated,
    neverGrandfather: [...NEVER].sort(),
  }
  if (BASELINE_ADD)
    baseDoc.added = { ...(baselineDoc.added || {}), [BASELINE_ADD]: { base, routes: allPaths.length, at: new Date().toISOString() } }
  else if (baselineDoc.added) baseDoc.added = baselineDoc.added
  const doc = { ...baseDoc, entries: [...next.values()].sort((a, b) => a.key.localeCompare(b.key)) }
  mkdirSync(REVIEW_DIR, { recursive: true })
  const lines = doc.entries.map((e) => '    ' + JSON.stringify(e))
  const head = JSON.stringify({ ...doc, entries: [] }, null, 2).replace(/"entries": \[\]\n\}$/, '')
  writeFileSync(BASELINE_PATH, `${head}"entries": [\n${lines.join(',\n')}\n  ]\n}\n`)
  console.log(`\nbaseline written: ${doc.entries.length} entr${doc.entries.length === 1 ? 'y' : 'ies'} in ${relative(REPO, BASELINE_PATH)} (commit it)`)
  written = doc.entries
}
if (WRITE_BASELINE) writeCropWorst(written.filter((e) => e.check === 'CROP'), 60)

/**
 * The worst N baselined crops by visible fraction, drawn from the WHOLE baseline (not just
 * this run), with evidence shots copied beside it (gitignored).
 */
function writeCropWorst(crops, n) {
  const worst = [...crops].sort((a, b) => a.fraction - b.fraction || a.key.localeCompare(b.key)).slice(0, n)
  rmSync(CROP_WORST_SHOTS, { recursive: true, force: true })
  mkdirSync(CROP_WORST_SHOTS, { recursive: true })
  let missing = 0
  const rows = worst.map((c, i) => {
    let shot = '(no shot on disk: run this route without --no-shots)'
    const src = cropShotPath(c.route, c.viewport, c.file)
    if (existsSync(src)) {
      const name = `${String(i + 1).padStart(2, '0')}-${c.viewport}-${slugOf(c.route)}-${c.file.split('/').pop().replace(/\.[a-z0-9]+$/i, '')}.png`
      copyFileSync(src, join(CROP_WORST_SHOTS, name))
      shot = relative(REPO, join(CROP_WORST_SHOTS, name))
    } else missing++
    return `| ${i + 1} | ${c.route} | ${c.viewport} | ${c.file} | ${c.box} | ${c.fraction.toFixed(2)} | ${shot} |`
  })
  const md = [
    '# Worst grandfathered crops',
    '',
    `The ${worst.length} lowest visible-fraction CROP findings out of ${crops.length} in the baseline,`,
    `measured against ${base} at threshold ${THRESHOLD}. Generated by \`--write-baseline\`; do not edit by hand.`,
    'Visible fraction = the share of the photo the box shows (1.00 = whole photo).',
    'Shots are gitignored: the image is centred in the viewport and outlined in red. Regenerate them with',
    '`node node_modules/photo-framing/scripts/page-review.mjs -- --all --base <your base url> --write-baseline`.',
    `Decorative layers are exempt from CROP: ${DECORATIVE_RULE}.`,
    '',
    '| # | Route | Viewport | Image | Box | Visible | Shot |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
  writeFileSync(CROP_WORST_PATH, md)
  console.log(`crop-worst written: ${relative(REPO, CROP_WORST_PATH)} (${worst.length} rows, ${missing} without a shot), shots in ${relative(REPO, CROP_WORST_SHOTS)}/`)
}

// Whatever is STILL unscanned after the auto-scan attempt above (NOT_FACE_CHECKED findings
// already failed their routes; this is a plain summary, not a second gate).
const finalUnscanned = new Set(allPaths.flatMap((p) => (byPath.get(p).unscannedHits || []).map((h) => h.file)))
if (finalUnscanned.size) {
  console.log(`\nNOT FACE-CHECKED: ${finalUnscanned.size} content image(s) could not be face-checked even after the auto-scan attempt.`)
  console.log('  Every affected route already failed with NOT_FACE_CHECKED above.')
  for (const f of [...finalUnscanned].sort()) console.log(`  unscanned  ${f}`)
}
if (FACE_REPORT) writeFaceReport()

/**
 * .photo-framing/face-report.json: every FACE_CLIPPED finding and report-only EDGE_BYSTANDER /
 * BACKDROP_CANDIDATE note of this run grouped by image, with a suggested fix: for FACE_CLIPPED
 * an object-position keeping every main-subject face (plus hair margin) in frame in EVERY box
 * the image was judged in this run, clipped or not. Shots are copied to
 * .photo-framing/face-shots/ (gitignored).
 */
function writeFaceReport() {
  const FACE_REPORT_PATH = join(REVIEW_DIR, 'face-report.json')
  const FACE_SHOTS = join(REVIEW_DIR, 'face-shots')
  rmSync(FACE_SHOTS, { recursive: true, force: true })
  mkdirSync(FACE_SHOTS, { recursive: true })
  const CLASS_ORDER = ['FACE_CLIPPED', 'BACKDROP_CANDIDATE', 'EDGE_BYSTANDER']
  const items = [
    ...allFindings.filter((f) => f.type === 'FACE_CLIPPED'),
    ...allPaths.flatMap((p) => byPath.get(p).notes.map((n) => ({ ...n, path: normPath(p), grandfathered: false }))),
  ]
  const usages = allPaths.flatMap((p) => byPath.get(p).faceUsages.map((u) => ({ ...u, path: normPath(p) })))
  const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`)
  const files = [...new Set(items.map((f) => f.file))]
  const images = files.map((file) => {
    const { main, bystanders } = FACES.lookup(file)
    const mine = items.filter((f) => f.file === file)
    const classes = CLASS_ORDER.filter((c) => mine.some((f) => f.type === c))
    const cls = classes[0]
    const clipped = mine.filter((f) => f.type === 'FACE_CLIPPED')
    // every box the image was judged in this run (backdrops are not judged), for the fix and the worst main face
    const seen = new Map()
    for (const u of usages.filter((u) => u.file === file)) seen.set(`${u.path}|${u.viewport}|${u.box.w}x${u.box.h}`, u)
    const judged = [...seen.values()]
    const worstMains = judged.map((u) => u.worstMain).filter((v) => v != null)
    let suggestedFix = null
    if (cls === 'BACKDROP_CANDIDATE' && !clipped.length) suggestedFix = { action: 'mark decorative', why: 'dimmed backdrop behind CTA text; a visitor does not look at it as a photo' }
    else if (cls === 'EDGE_BYSTANDER') suggestedFix = { action: 'none needed', why: 'only a bystander is cut at the edge; every main-subject face is in frame' }
    else if (clipped.length) {
      const shapes = judged.map((u) => ({ u, range: positionRange(u.box, u.nat, main) }))
      const posCount = new Map()
      for (const f of clipped) posCount.set(f.objPos, (posCount.get(f.objPos) || 0) + 1)
      const current = [...posCount].sort((a, b) => b[1] - a[1])[0]?.[0] || '50% 50%'
      const [cx, cy] = current.split(/\s+/).map((t) => axisPercent(t) ?? 0.5)
      const impossible = shapes.filter((s) => !s.range.x || !s.range.y)
      const inter = (axis) =>
        shapes.filter((s) => s.range.x && s.range.y).reduce((acc, s) => [Math.max(acc[0], s.range[axis][0]), Math.min(acc[1], s.range[axis][1])], [0, 1])
      const ix = inter('x'), iy = inter('y')
      const pick = ([lo, hi], cur) => {
        const want = Math.min(hi, Math.max(lo, cur))
        const lo100 = Math.ceil(lo * 100 - 1e-9), hi100 = Math.floor(hi * 100 + 1e-9)
        if (lo100 > hi100) return Number((want * 100).toFixed(1))
        return Math.min(hi100, Math.max(lo100, Math.round(want * 100)))
      }
      if (ix[0] <= ix[1] + 1e-9 && iy[0] <= iy[1] + 1e-9 && !impossible.length) {
        const position = `${pick(ix, cx)}% ${pick(iy, cy)}%`
        suggestedFix = {
          action: 'set object-position',
          objectPosition: position,
          singlePositionWorks: true,
          allowedX: `${pct(ix[0])} to ${pct(ix[1])}`,
          allowedY: `${pct(iy[0])} to ${pct(iy[1])}`,
          how: `register '${file}': '${position}' in your focus registry (config.focusRegistry.handPath, see templates/image-focus.ts.template) -- only reaches renderers that call focusFor(); a page passing its own objectPosition needs that value changed instead)`,
          verify: `node node_modules/photo-framing/scripts/page-review.mjs -- --base ${base} --try-position '${file}=${position}' ${[...new Set(clipped.map((f) => f.path))].join(' ')}`,
        }
      } else {
        suggestedFix = {
          action: 'per-usage override or different photo',
          objectPosition: null,
          singlePositionWorks: false,
          why: impossible.length
            ? `${impossible.length} box shape(s) show less of the photo than the main faces span, so no object-position fits there: use a per-usage override with a different box shape, or a different photo for those`
            : 'the boxes this image appears in need incompatible positions: set a per-usage objectPosition override on the usages that clip, or use a different photo there',
          perUsage: shapes.map(({ u, range }) => ({
            route: u.path, viewport: u.viewport, box: `${u.box.w}x${u.box.h}`,
            x: range.x ? `${pct(range.x[0])} to ${pct(range.x[1])}` : 'impossible: main faces wider than the frame shows',
            y: range.y ? `${pct(range.y[0])} to ${pct(range.y[1])}` : 'impossible: main faces taller than the frame shows',
          })),
        }
      }
    }
    const routes = mine
      .map((f) => {
        let shot = null
        if (f.shot && existsSync(join(REPO, f.shot))) {
          const name = `${file.split('/').pop().replace(/\.[a-z0-9]+$/i, '')}--${f.type.toLowerCase()}--${f.viewport}--${slugOf(f.path)}.png`
          copyFileSync(join(REPO, f.shot), join(FACE_SHOTS, name))
          shot = relative(REPO, join(FACE_SHOTS, name))
        }
        const r = { class: f.type, route: f.path, viewport: f.viewport, section: f.section, box: `${f.box.w}x${f.box.h}`, objectPosition: f.objPos }
        if (f.sides) r.cut = Object.fromEntries(Object.entries(f.sides).map(([k, v]) => [k, pct(v)]))
        if (f.type === 'FACE_CLIPPED') r.worstMainFaceVisible = pct(f.worstVisible)
        if (f.type === 'EDGE_BYSTANDER') Object.assign(r, { worstBystanderVisible: pct(f.worstVisible), worstMainFaceVisible: pct(f.worstMain ?? 1) })
        if (f.type === 'BACKDROP_CANDIDATE') Object.assign(r, { opacity: f.backdrop.opacity, overlayAlpha: f.backdrop.overlay, suggestion: 'mark decorative' })
        r.gate = f.type === 'FACE_CLIPPED' ? (f.grandfathered ? 'grandfathered' : 'fails') : 'report only'
        r.shot = shot
        return r
      })
      .sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || a.route.localeCompare(b.route) || a.viewport.localeCompare(b.viewport))
    return {
      image: file,
      class: cls,
      classes,
      mainFaces: main.map(({ x, y, w, h, score }) => ({ x, y, w, h, score })),
      bystanderFaces: bystanders.length,
      worstMainFaceVisible: worstMains.length ? pct(Math.min(...worstMains)) : null,
      routeCount: new Set(mine.filter((f) => f.type === cls).map((f) => f.path)).size,
      findings: mine.filter((f) => f.type === cls).length,
      sidesCut: [...new Set(mine.filter((f) => f.type === cls).flatMap((f) => Object.keys(f.sides || {})))].sort(),
      suggestedFix,
      routes,
    }
  })
  images.sort(
    (a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || b.routeCount - a.routeCount || b.findings - a.findings || a.image.localeCompare(b.image),
  )
  const totals = { routesReviewed: allPaths.length, notFaceChecked: finalUnscanned.size }
  for (const c of CLASS_ORDER) {
    const list = items.filter((f) => f.type === c)
    totals[c] = { usages: list.length, images: new Set(list.map((f) => f.file)).size, routes: new Set(list.map((f) => f.path)).size }
  }
  const doc = {
    about:
      'Face findings grouped by image, from scripts/page-review.mjs --face-report. Classes: FACE_CLIPPED (a main-subject face cut; a gate finding), ' +
      'BACKDROP_CANDIDATE (dimmed backdrop behind CTA text; report only, suggestion mark decorative), EDGE_BYSTANDER (only a bystander cut at the edge; report only). ' +
      'An image\'s "class" is its most serious class across usages; each route row carries its own. ' +
      'Shots (gitignored) are in .photo-framing/face-shots/: yellow outline = the rendered frame, solid box = detected face, dashed = face plus hair margin; ' +
      'red = main face clipped, green = main face in frame, orange = bystander clipped, blue = bystander in frame, grey = face on a backdrop (not judged). ' +
      'Every FACE_CLIPPED row was added to .photo-framing/baseline.json (--baseline-add FACE_CLIPPED), so the deploy gate grandfathers it until a human decides; ' +
      'rows marked gate "fails" are on a neverGrandfather route. EDGE_BYSTANDER and BACKDROP_CANDIDATE are never baselined. Nothing here has been fixed.',
    rule: FACE_RULE,
    backdropRule: BACKDROP_RULE,
    generated: { base, routes: allPaths.length, at: new Date().toISOString(), minScore: FACES.minScore },
    totals,
    images,
  }
  writeFileSync(FACE_REPORT_PATH, JSON.stringify(doc, null, 2) + '\n')
  console.log(
    `\nface report written: ${relative(REPO, FACE_REPORT_PATH)} (${CLASS_ORDER.map((c) => `${c} ${totals[c].usages} in ${totals[c].images} image(s)`).join(', ')}), shots in ${relative(REPO, FACE_SHOTS)}/`,
  )
}

// grandfathered tally, by check and viewport
const gf = allFindings.filter((f) => f.grandfathered)
if (gf.length) {
  const tally = new Map()
  for (const f of gf) tally.set(`${f.type} ${f.viewport}`, (tally.get(`${f.type} ${f.viewport}`) || 0) + 1)
  console.log(`\ngrandfathered this run: ${gf.length}  (${[...tally].sort().map(([k, v]) => `${k} ${v}`).join(', ')})`)
}

// ---------- stamps ----------
const failed = allPaths.filter((p) => byPath.get(p).failing.length)
if (local && !NO_SHOTS && !WHAT_IF) {
  const fresh = routeModel()
  const stamps = readStamps()
  let wrote = 0
  for (const item of plan) {
    if (item.partialOf) {
      console.log(`\nnot stamped: ${item.paths[0]} is one URL of ${item.partialOf}; review the pattern: node node_modules/photo-framing/scripts/page-review.mjs -- '${item.partialOf}'`)
      continue
    }
    if (!item.key) {
      console.log(`\nnot stamped: ${item.paths.length} reviewed URL(s) match no discovered route: ${item.paths.join(', ')}`)
      continue
    }
    if (item.paths.some((p) => byPath.get(p).failing.length)) continue
    const route = fresh.find((r) => r.key === item.key)
    if (contentHash(route) !== hashBefore.get(item.key)) {
      console.log(`\nnot stamped: ${item.key} changed on disk during the review; run it again`)
      continue
    }
    // media.trackRendered: the local files this route's URLs were measured rendering, at both
    // viewports. They are hashed into the stamp and listed in it, so the gate can map a changed
    // photo to every route that shows it.
    const rendered = config.media.trackRendered ? resolveRenderedMedia(item.paths.flatMap((p) => byPath.get(p).rendered || [])) : null
    stamps[item.key] = {
      route: item.key,
      contentHash: contentHash(route, rendered || []),
      ...(rendered ? { renderedMedia: rendered } : {}),
      reviewedAt: new Date().toISOString(),
      urls: item.paths,
      sheets: item.paths.flatMap((p) => byPath.get(p).sheets),
      grandfathered: item.paths.reduce((n, p) => n + byPath.get(p).findings.filter((f) => f.grandfathered).length, 0),
    }
    wrote++
  }
  if (wrote) {
    mkdirSync(REVIEW_DIR, { recursive: true })
    const sorted = Object.fromEntries(Object.entries(stamps).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(STAMPS_PATH, JSON.stringify(sorted, null, 2) + '\n')
    console.log(`\nstamped ${wrote} route(s) in ${relative(REPO, STAMPS_PATH)} (commit it; it is the record)`)
  }
} else {
  console.log(`\nno stamps written: ${!local ? `reviewed ${base}, which is not this working tree` : WHAT_IF ? '--try-position what-if run' : '--no-shots run'}`)
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify([...byPath.values()], null, 2))
console.log(`\n${allPaths.length - failed.length}/${allPaths.length} page(s) passed.`)
console.log(HONESTY)
process.exit(failed.length ? 1 : 0)
