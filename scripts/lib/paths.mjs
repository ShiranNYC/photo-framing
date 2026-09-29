/**
 * Fixed layout of the review record inside a consuming project, all under one
 * gitignored-except-for-a-few-files directory so it is easy to point a .gitignore at.
 * Only stamps.json, baseline.json, crop-worst.md, and auto-focus-legacy.json are meant to
 * be committed (see README "What to commit").
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inProject } from './config.mjs'

/** Root of the photo-framing package itself (two levels up from this file: lib/ -> scripts/ -> package root). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function reviewPaths(config) {
  const dir = inProject(config, '.photo-framing')
  return {
    REVIEW_DIR: dir,
    STAMPS_PATH: join(dir, 'stamps.json'),
    SKIP_LOG_PATH: join(dir, 'skips.log'),
    BASELINE_PATH: join(dir, 'baseline.json'),
    CROP_WORST_PATH: join(dir, 'crop-worst.md'),
    CROP_WORST_SHOTS: join(dir, 'crop-worst-shots'),
    FACES_PATH: join(dir, 'faces.json'),
    FACES_CACHE: join(dir, 'faces-cache'),
    LEGACY_PATH: join(dir, 'auto-focus-legacy.json'),
    FACES_VENV: join(dir, 'faces-venv'),
  }
}
