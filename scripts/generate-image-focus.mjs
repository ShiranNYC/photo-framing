#!/usr/bin/env node
/**
 * Regenerates the AUTO_FOCUS registry (config.focusRegistry.autoPath) from
 * .photo-framing/faces.json. Run by hand, or automatically by scripts/page-review.mjs
 * right after it auto-scans a new image into faces.json (see page-review's "fail closed on
 * unscanned images" step). The deploy gate (scripts/page-review-gate.mjs) fails the build if
 * the committed file does not match this script's output, so a stale registry can never ship
 * silently.
 *
 * Usage: node node_modules/photo-framing/scripts/generate-image-focus.mjs
 * (run from the project root, or anywhere under it -- see scripts/lib/config.mjs)
 */
import { writeFileSync } from 'node:fs'
import { loadConfig } from './lib/config.mjs'
import { autoFocusPath, generate } from './lib/image-focus-gen.mjs'

const config = loadConfig()
const content = generate(config, { write: true })
if (content == null) {
  console.log('[generate-image-focus] .photo-framing/faces.json does not exist yet; nothing to generate. Run detect-faces.py first.')
  process.exit(0)
}
writeFileSync(autoFocusPath(config), content)
console.log(`[generate-image-focus] wrote ${autoFocusPath(config)}`)
