#!/usr/bin/env node
/**
 * Builds the two smoke-test fixture pages from smoke-test/templates/crop-page.html.tmpl:
 * a "bad" crop that partially cuts the fixture photo's face, and a "good" crop that shows
 * the whole photo. Run AFTER detect-faces.py has scanned smoke-test/fixtures/public/images/
 * (needs the real face box from faces.json).
 *
 * Uses the SAME geometry the engine's FACE_CLIPPED check uses (coverView/clipOf from
 * scripts/lib/face-clip.mjs), searched over a grid of box shapes and object-positions,
 * to construct a crop that is GUARANTEED to trip the check rather than hand-tuning CSS and
 * hoping. See face-clip.mjs: clipOf(view, box, face) returns non-null exactly when
 * page-review would flag that face as clipped. clipOf's verdict depends only on aspect
 * ratios and the object-position percentage, not absolute pixel size, so any box width
 * works as long as the ratio is right.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../scripts/lib/config.mjs'
import { reviewPaths } from '../scripts/lib/paths.mjs'
import { classifyFaces, coverView, clipOf } from '../scripts/lib/face-clip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures')
const PUBLIC_DIR = join(FIXTURES_DIR, 'public')
const TEMPLATE = readFileSync(join(HERE, 'templates', 'crop-page.html.tmpl'), 'utf8')

const config = loadConfig(FIXTURES_DIR)
const { FACES_PATH } = reviewPaths(config)
if (!existsSync(FACES_PATH)) {
  console.error('build-fixture-pages: faces.json does not exist yet. Run detect-faces.py against the fixtures first.')
  process.exit(1)
}
const doc = JSON.parse(readFileSync(FACES_PATH, 'utf8'))
const entry = doc.images['/images/face.jpg']
if (!entry) {
  console.error('build-fixture-pages: /images/face.jpg is not in faces.json.')
  process.exit(1)
}
const { main } = classifyFaces(entry.faces.filter((f) => f.score >= doc.minScore))
if (!main.length) {
  console.error('build-fixture-pages: no prominent face detected in the fixture photo. Pick a clearer headshot.')
  process.exit(1)
}
const face = main[0]
const nat = { w: entry.width, h: entry.height }
console.log(`fixture face box: x=${face.x} y=${face.y} w=${face.w} h=${face.h} score=${face.score}, photo ${nat.w}x${nat.h}`)

const WIDTH = 1000

// Search for a box shape (aspect ratio) + vertical object-position that clips the face
// partially (clipOf non-null) with a moderate visible share, so it reads as a real bad crop
// rather than an edge case. Horizontal anchor fixed at 50% (the photo is a centered portrait).
let bad = null
for (let ar = 1.3; ar <= 6 && !bad; ar += 0.1) {
  const height = Math.round(WIDTH / ar)
  const box = { w: WIDTH, h: height }
  for (let posY = 0; posY <= 100 && !bad; posY += 5) {
    const objPos = `50% ${posY}%`
    const view = coverView(box, nat, objPos)
    const clip = clipOf(view, box, face)
    if (clip && clip.faceVisible >= 0.15 && clip.faceVisible <= 0.85) {
      bad = { ar, height, posY, objPos, clip }
    }
  }
}
if (!bad) {
  console.error('build-fixture-pages: could not find a box shape that partially clips the fixture face. Try a different photo or widen the search grid.')
  process.exit(1)
}
console.log(`bad crop: AR ${bad.ar.toFixed(1)} object-position "${bad.objPos}" -> face ${Math.round(bad.clip.faceVisible * 100)}% visible, cut sides: ${bad.clip.sides.map((s) => s.side).join(', ')}`)

// Good crop: box at the photo's own aspect ratio shows the WHOLE photo under cover, so no
// object-position can crop anything -- trivially safe regardless of where the face sits.
const goodAR = nat.w / nat.h
const goodHeight = Math.round(WIDTH / goodAR)
{
  const box = { w: WIDTH, h: goodHeight }
  const view = coverView(box, nat, '50% 50%')
  const clip = clipOf(view, box, face)
  if (clip) {
    console.error('build-fixture-pages: the "good" full-photo box unexpectedly clipped the face; this should never happen.')
    process.exit(1)
  }
}
console.log(`good crop: AR ${goodAR.toFixed(3)} (the photo's own aspect ratio) object-position "50% 50%" -> whole photo shown`)

const render = (title, width, height, objPos) =>
  TEMPLATE.replaceAll('{{TITLE}}', title).replaceAll('{{WIDTH}}', String(width)).replaceAll('{{HEIGHT}}', String(height)).replaceAll('{{OBJPOS}}', objPos)

mkdirSync(PUBLIC_DIR, { recursive: true })
writeFileSync(join(PUBLIC_DIR, 'bad-crop.html'), render('Bad crop (face should be flagged)', WIDTH, bad.height, bad.objPos))
writeFileSync(join(PUBLIC_DIR, 'good-crop.html'), render('Good crop (face should pass)', WIDTH, goodHeight, '50% 50%'))
console.log('wrote smoke-test/fixtures/public/bad-crop.html and good-crop.html')
