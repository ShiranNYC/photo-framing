/**
 * Face geometry for page-review's FACE_CLIPPED check and the face report: map face
 * boxes from .photo-framing/faces.json (normalized to the photo) through a rendered
 * object-fit:cover box, and compute object-positions that keep every face in frame.
 * Pure functions plus one config-bound loader; scripts/detect-faces.py is what writes
 * faces.json.
 *
 * Ported from an existing page-review engine's scripts/lib/face-clip.mjs.
 * The geometry and thresholds below are unchanged from the original; only the file
 * path (now project-config-driven) and the "is this a local image I can re-hash"
 * check (now driven by config.media.roots instead of a hardcoded /images/ prefix)
 * were made generic.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inProject } from './config.mjs'
import { reviewPaths } from './paths.mjs'

/** Hair and top of head: the face box is grown by these fractions of its own size before the check. */
export const EXTEND_UP = 0.35
export const EXTEND_SIDE = 0.1
/** Faces narrower than this share of the photo's width are distant crowd, ignored. */
export const MIN_FACE_W = 0.03
/** A face whose visible share is below this is clipped even if its extension somehow fits. */
export const MIN_FACE_VISIBLE = 0.9
/** Rendered pixels a box edge may overhang before it counts as cut (sub-pixel rounding). */
const TOLERANCE_PX = 2
/**
 * PROMINENT (main-subject) faces: only these can fail FACE_CLIPPED. A bystander cut at the
 * frame edge is normal photography. Prominent = area at least PROMINENT_AREA of the photo's
 * largest detected face, OR the face centre within CENTRE_BAND of the photo centre on both
 * axes (as a share of the photo's width/height). Either way the face must be at least
 * MIN_FACE_W of the photo's width.
 */
export const PROMINENT_AREA = 0.4
export const CENTRE_BAND = 0.25
/**
 * The "largest face" the area test compares against is the largest face whose centre is NOT
 * in the outer SIDE_BAND of the photo's width (left or right), and a face centred in that band
 * is a bystander unless it passes the test against that reference. Only the sides count as
 * edge; a head near the TOP is the incident this check exists for. If no face >= MIN_FACE_W
 * sits inside the band, the reference falls back to the largest face overall.
 */
export const SIDE_BAND = 0.15
/**
 * BACKDROP_CANDIDATE: an image behind a CTA band's text that is visibly dimmed. Report only,
 * suggestion "mark decorative"; it is never judged for faces. Measured in the page:
 * dimmed = effective opacity (own x ancestors, x any brightness() filter) under BACKDROP_MAX_OPACITY,
 *          OR the layers painted above its centre combine to alpha >= BACKDROP_OVERLAY_ALPHA;
 * CTA band = at least BACKDROP_MIN_WIDTH of the viewport wide, filling BACKDROP_SECTION_FILL of its
 *          nearest <section> (so a full-width phone card is never one), starting below the first
 *          viewport (so a page hero is never one), with a heading AND a link or button
 *          painted over it that are not the image's own ancestors.
 */
export const BACKDROP_MAX_OPACITY = 0.6
export const BACKDROP_OVERLAY_ALPHA = 0.5
export const BACKDROP_MIN_WIDTH = 0.8
/** ...and it fills at least this share of its nearest <section>'s area (a band background, not a card inside the band). */
export const BACKDROP_SECTION_FILL = 0.9

export const FACE_RULE =
  `FACE_CLIPPED: for each object-fit:cover content image, detected faces (score >= minScore) at least ${MIN_FACE_W * 100}% of the photo's width are split into ` +
  `PROMINENT (area >= ${PROMINENT_AREA * 100}% of the largest face not centred in the outer ${SIDE_BAND * 100}% of the photo's width, or centre within ${CENTRE_BAND * 100}% of the photo centre on both axes) and bystanders; ` +
  `a face centred in that outer side band is a bystander unless it is central or no face sits inside the band. ` +
  `Each face box is extended up ${EXTEND_UP * 100}% and sideways ${EXTEND_SIDE * 100}% of its own size (hair, top of head) and clamped to the photo; ` +
  `a PROMINENT face whose extended box is cut by the rendered frame by more than ${TOLERANCE_PX}px, or with under ${MIN_FACE_VISIBLE * 100}% visible, is a FACE_CLIPPED finding. ` +
  `A cut bystander is EDGE_BYSTANDER: face report only, never a gate finding, never baselined. A face entirely outside the frame is not shown at all and is neither.`
export const BACKDROP_RULE =
  `BACKDROP_CANDIDATE (face report only, never a gate finding): an image at least ${BACKDROP_MIN_WIDTH * 100}% of the viewport wide that fills at least ${BACKDROP_SECTION_FILL * 100}% of its <section>, starting below the first viewport, ` +
  `with a heading and a link/button painted over it, and dimmed (effective opacity < ${BACKDROP_MAX_OPACITY}, or overlays above it at alpha >= ${BACKDROP_OVERLAY_ALPHA}). ` +
  `Suggestion: mark decorative. It is not judged for FACE_CLIPPED or EDGE_BYSTANDER.`

/** Split usable faces (score >= minScore) into prominent main-subject faces and bystanders; faces under MIN_FACE_W are dropped. */
export function classifyFaces(all) {
  if (!all.length) return { main: [], bystanders: [] }
  const atSide = (f) => Math.abs(f.x + f.w / 2 - 0.5) > 0.5 - SIDE_BAND
  const inner = all.filter((f) => f.w >= MIN_FACE_W && !atSide(f))
  const maxArea = Math.max(...(inner.length ? inner : all).map((f) => f.w * f.h))
  const main = [], bystanders = []
  for (const f of all) {
    if (f.w < MIN_FACE_W) continue
    const central = Math.abs(f.x + f.w / 2 - 0.5) <= CENTRE_BAND && Math.abs(f.y + f.h / 2 - 0.5) <= CENTRE_BAND
    const big = f.w * f.h >= PROMINENT_AREA * maxArea && (!atSide(f) || !inner.length)
    ;(big || central ? main : bystanders).push(f)
  }
  return { main, bystanders }
}

/**
 * Loads faces.json for one project config. Returns { minScore, count, generated, lookup(file) }
 * where lookup gives the usable faces for an image path split by classifyFaces
 * ({ main, bystanders }), or null when the image was never scanned or has changed on disk
 * since (a locally-stored file whose sha256 differs): not knowing is reported, not passed.
 * Images served from a remote origin (config.media.remoteUploadPrefixes, not present on
 * disk) are trusted as scanned without a re-hash -- detect-faces.py hashes them at fetch time.
 */
export function loadFaces(config) {
  const { FACES_PATH } = reviewPaths(config)
  if (!existsSync(FACES_PATH)) return null
  const doc = JSON.parse(readFileSync(FACES_PATH, 'utf8'))
  const shaCache = new Map()
  const localRoot = (file) => config.media.roots.find((root) => file.startsWith('/') && existsSync(inProject(config, root, file.slice(1))))
  const lookup = (file) => {
    const e = doc.images[file]
    if (!e) return null
    const root = localRoot(file)
    if (root) {
      const abs = inProject(config, root, file.slice(1))
      if (!shaCache.has(file))
        shaCache.set(file, existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : null)
      if (shaCache.get(file) && shaCache.get(file) !== e.sha256) return null
    }
    return classifyFaces(e.faces.filter((f) => f.score >= doc.minScore))
  }
  return { minScore: doc.minScore, count: Object.keys(doc.images).length, generated: doc.generated, lookup }
}

/** Face box grown for hair/top of head, clamped to the photo (what is not in the photo cannot be cropped off). */
export function extend(f) {
  const x0 = Math.max(0, f.x - EXTEND_SIDE * f.w)
  const x1 = Math.min(1, f.x + f.w + EXTEND_SIDE * f.w)
  const y0 = Math.max(0, f.y - EXTEND_UP * f.h)
  const y1 = Math.min(1, f.y + f.h)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * One axis of a computed object-position token ("50%", "0%", "12px", "calc(...)") to
 * the offset in px of the painted image inside the box, given free space (box - painted).
 */
function axisOffset(token, free) {
  if (!token) return free * 0.5
  if (token.endsWith('%')) return free * (parseFloat(token) / 100)
  if (token.endsWith('px')) return parseFloat(token)
  return free * 0.5
}

/**
 * The part of the photo an object-fit:cover box shows, normalized 0-1 to the photo,
 * plus the transform needed to draw photo coordinates in box pixels.
 */
export function coverView(box, nat, objectPosition) {
  const s = Math.max(box.w / nat.w, box.h / nat.h)
  const pw = nat.w * s
  const ph = nat.h * s
  const [tx, ty] = (objectPosition || '50% 50%').trim().split(/\s+/)
  const ox = axisOffset(tx, box.w - pw)
  const oy = axisOffset(ty, box.h - ph)
  return {
    pw, ph, ox, oy,
    u0: -ox / pw, u1: (box.w - ox) / pw,
    v0: -oy / ph, v1: (box.h - oy) / ph,
  }
}

/** Photo-normalized rect -> box pixels. */
export const toBox = (view, r) => ({ x: view.ox + r.x * view.pw, y: view.oy + r.y * view.ph, w: r.w * view.pw, h: r.h * view.ph })

/**
 * Clip report for one face in one rendered box: px cut per side (of the extended box)
 * and the visible share of the bare face. null when nothing is cut.
 */
export function clipOf(view, box, face) {
  const e = toBox(view, extend(face))
  const cut = {
    top: Math.max(0, -e.y),
    bottom: Math.max(0, e.y + e.h - box.h),
    left: Math.max(0, -e.x),
    right: Math.max(0, e.x + e.w - box.w),
  }
  const b = toBox(view, face)
  const vw = Math.max(0, Math.min(box.w, b.x + b.w) - Math.max(0, b.x))
  const vh = Math.max(0, Math.min(box.h, b.y + b.h) - Math.max(0, b.y))
  const faceVisible = (vw * vh) / (b.w * b.h)
  // entirely outside the frame: that person is not shown at all, not shown cut
  const inside = e.x < box.w && e.x + e.w > 0 && e.y < box.h && e.y + e.h > 0
  if (!inside) return null
  const sides = Object.entries(cut).filter(([, px]) => px > TOLERANCE_PX)
  if (!sides.length && faceVisible >= MIN_FACE_VISIBLE) return null
  return {
    sides: sides.map(([side, px]) => ({
      side,
      px: Math.round(px),
      // share of the extended (face + hair) box that is cut on this side
      share: Number(Math.min(1, px / (side === 'top' || side === 'bottom' ? e.h : e.w)).toFixed(2)),
    })),
    faceVisible: Number(faceVisible.toFixed(2)),
  }
}

/**
 * Range of object-position percentages (0-1) on each axis that keeps every extended face
 * in frame for one usage. An axis with no crop is unconstrained ([0,1]); an axis where the
 * faces span more than the frame shows is impossible (null).
 */
export function positionRange(box, nat, faces) {
  const ext = faces.map(extend)
  const top = Math.min(...ext.map((f) => f.y)), bottom = Math.max(...ext.map((f) => f.y + f.h))
  const left = Math.min(...ext.map((f) => f.x)), right = Math.max(...ext.map((f) => f.x + f.w))
  const boxAR = box.w / box.h, natAR = nat.w / nat.h
  const axis = (visible, lo, hi) => {
    if (visible >= 0.999) return [0, 1]
    if (hi - lo > visible + 1e-6) return null
    return [Math.max(0, (hi - visible) / (1 - visible)), Math.min(1, lo / (1 - visible))]
  }
  return {
    x: boxAR < natAR ? axis(boxAR / natAR, left, right) : [0, 1],
    y: boxAR > natAR ? axis(natAR / boxAR, top, bottom) : [0, 1],
  }
}

/** Percent token for a computed object-position axis, or null when it is px/calc. */
export function axisPercent(token) {
  return token && token.endsWith('%') ? parseFloat(token) / 100 : null
}
