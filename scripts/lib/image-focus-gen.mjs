/**
 * Shared generator for the AUTO_FOCUS registry (config.focusRegistry.autoPath): pure
 * functions so the CLI (scripts/generate-image-focus.mjs) and the deploy gate
 * (scripts/page-review-gate.mjs, which must fail if the committed file is stale)
 * compute exactly the same content.
 *
 * Ported from an existing page-review engine's scripts/lib/image-focus-gen.mjs.
 *
 * WHY THIS EXISTS: a brand new photo lands in .photo-framing/faces.json with no
 * hand-picked crop in the hand-picked registry (config.focusRegistry.handPath, if you have
 * one -- see templates/image-focus.ts.template). A photo with an off-center face then
 * defaults to object-center and can clip it -- the same class of bug FACE_CLIPPED exists to
 * catch, except this happens before anyone reviews the page. AUTO_FOCUS closes that gap:
 * any image with a prominent main-subject face (the same PROMINENT test FACE_CLIPPED uses,
 * classifyFaces in ./face-clip.mjs -- not a second definition) that is not in the frozen
 * legacy list (.photo-framing/auto-focus-legacy.json) gets an automatic object-position.
 * Images already in faces.json when auto-focus first ran for a project are frozen in that
 * legacy list and keep their existing crop (grandfather existing images, never change a crop
 * nobody asked to change); only images added afterward qualify.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadFaces, extend } from './face-clip.mjs'
import { reviewPaths } from './paths.mjs'
import { inProject } from './config.mjs'

export const GENERATE_CMD = 'node node_modules/photo-framing/scripts/generate-image-focus.mjs'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
/** One decimal place, matching a typical hand-picked style ('63% 12%'). */
const pct = (v) => Math.round(clamp01(v) * 1000) / 10

/**
 * One object-position for a photo's prominent (main-subject) face(s): anchors near the TOP
 * of their combined extended (face + hair) box rather than its centre, so the face lands in
 * the upper third of most cover crops instead of being bisected; horizontal anchor is the
 * midpoint of the faces' span. This is a photo-level default (no rendered box in play, unlike
 * page-review's per-usage positionRange), so it cannot guarantee every box shape stays
 * uncropped (it does guarantee the top of the face and hair stays visible in any box that
 * passes the CROP check) -- it is the same kind of starting point a hand-picked entry is, and a page can
 * still override it or a human can promote a per-usage FOCUS entry after review.
 */
export function autoPosition(mainFaces, minVisible = 0.6) {
  const ext = mainFaces.map(extend)
  const top = Math.min(...ext.map((f) => f.y))
  const bottom = Math.max(...ext.map((f) => f.y + f.h))
  const left = Math.min(...ext.map((f) => f.x))
  const right = Math.max(...ext.map((f) => f.x + f.w))
  // An object-position percentage is a fraction of the FREE space, not a point in the photo.
  // With a box that still shows `minVisible` of the photo's height (the CROP threshold), y%
  // hides at most y * (1 - minVisible) of the photo's top. Cap y so that hidden strip can
  // never reach the top of the extended face box, or a face near the top of the photo is
  // clipped by the very crop meant to protect it.
  const y = Math.min(top + (bottom - top) * 0.25, Math.floor((top / (1 - minVisible)) * 1000) / 1000)
  const x = (left + right) / 2
  return `${pct(x)}% ${pct(y)}%`
}

/**
 * The frozen legacy set: every image key in faces.json at the moment auto-focus first ran
 * for this project. Created once, on first run, and never changed after (grandfather
 * existing crops). `write: false` (the deploy gate) never creates it, only reads it if
 * present, so a read-only gate check can never mutate the repo.
 */
export function legacySet(config, facesDoc, { write }) {
  const { LEGACY_PATH } = reviewPaths(config)
  if (existsSync(LEGACY_PATH)) return new Set(JSON.parse(readFileSync(LEGACY_PATH, 'utf8')).images)
  const images = facesDoc ? Object.keys(facesDoc.images).sort() : []
  if (write) {
    writeFileSync(
      LEGACY_PATH,
      JSON.stringify(
        {
          about:
            'Frozen snapshot of every image key in faces.json when automatic image-focus ' +
            '(the AUTO_FOCUS registry) first ran for this project. Grandfathers existing hand-reviewed ' +
            'crops -- only images added to faces.json AFTER this snapshot are eligible for an automatic ' +
            'entry. Never regenerated once created; commit it. See scripts/lib/image-focus-gen.mjs.',
          frozenAt: new Date().toISOString(),
          images,
        },
        null,
        2,
      ) + '\n',
    )
  }
  return new Set(images)
}

/**
 * The exact content the AUTO_FOCUS registry should have right now, or null when
 * faces.json does not exist yet (nothing to generate from). `write: true` also creates the
 * legacy snapshot if missing; `write: false` (the deploy gate) never writes anything.
 */
export function generate(config, { write } = { write: false }) {
  const { FACES_PATH } = reviewPaths(config)
  const facesDoc = existsSync(FACES_PATH) ? JSON.parse(readFileSync(FACES_PATH, 'utf8')) : null
  if (!facesDoc) return null
  const legacy = legacySet(config, facesDoc, { write })
  const FACES = loadFaces(config)
  const entries = []
  for (const file of Object.keys(facesDoc.images).sort()) {
    if (legacy.has(file)) continue
    const faces = FACES.lookup(file)
    if (!faces || !faces.main.length) continue
    entries.push([file, autoPosition(faces.main, config.threshold)])
  }
  const body = entries.map(([file, pos]) => `  ${JSON.stringify(file)}: ${JSON.stringify(pos)},`).join('\n')
  return (
    '/**\n' +
    ' * GENERATED by photo-framing, do not edit by hand.\n' +
    ` * Regenerate with: ${GENERATE_CMD}\n` +
    ' *\n' +
    ' * Automatic object-position for images with a prominent main-subject face (the same\n' +
    ' * prominence test FACE_CLIPPED uses, classifyFaces in photo-framing/scripts/lib/face-clip.mjs)\n' +
    ' * that were ADDED to .photo-framing/faces.json after auto-focus first ran for this project.\n' +
    ' * Images already known at that point are frozen in .photo-framing/auto-focus-legacy.json and\n' +
    ' * keep their existing crop (a hand entry in your focus registry, or plain center). See\n' +
    ' * photo-framing/scripts/lib/image-focus-gen.mjs and templates/image-focus.ts.template.\n' +
    ' * Your hand-picked registry should check this registry AFTER its own hand-picked entries.\n' +
    ' */\n' +
    'export const AUTO_FOCUS: Record<string, string> = {\n' +
    (body ? body + '\n' : '') +
    '}\n'
  )
}

/** Absolute path the generated file should be written to, from config. */
export function autoFocusPath(config) {
  return inProject(config, config.focusRegistry.autoPath)
}
