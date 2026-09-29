/**
 * Loads photo-framing.config.json from the consuming project and fills in defaults.
 * Every project-specific fact (base URL, where routes live, where images live, viewports,
 * thresholds) comes from this file so the engine itself (page-review.mjs, face-clip.mjs,
 * detect-faces.py, etc.) never hardcodes a project's domain, paths, or names.
 *
 * Discovery: walks up from process.cwd() looking for photo-framing.config.json. Run the
 * CLI from the project root (or any subfolder of it).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const CONFIG_FILENAME = 'photo-framing.config.json'

export const DEFAULT_VIEWPORTS = [
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
    thumbW: 480,
    cols: 3,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 PhotoFramingReviewBot/1.0',
  },
  {
    name: 'phone',
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    thumbW: 260,
    cols: 6,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 PhotoFramingReviewBot/1.0',
  },
]

const DEFAULT_BLOCK_PATTERNS = ['googletagmanager\\.com', 'google-analytics\\.com', 'doubleclick\\.net']

function findConfigPath(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function die(msg) {
  console.error(`\nphoto-framing config: ${msg}`)
  process.exit(2)
}

/**
 * Loads and validates the project config. Returns a fully-defaulted object plus
 * `projectRoot` (the directory the config file lives in -- every relative path in
 * the config, and every path the engine writes, is resolved against this).
 */
export function loadConfig(startDir = process.cwd()) {
  const configPath = findConfigPath(startDir)
  if (!configPath) {
    die(
      `no ${CONFIG_FILENAME} found in ${startDir} or any parent directory.\n` +
        `Copy photo-framing.config.example.json from the photo-framing package into your project root and edit it.\n` +
        `See README.md "Setup in 5 steps".`,
    )
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (e) {
    die(`${configPath} is not valid JSON: ${e.message}`)
  }
  const projectRoot = dirname(configPath)

  if (raw.viewports && (!Array.isArray(raw.viewports) || !raw.viewports.length))
    die('config.viewports, if present, must be a non-empty array')

  const routes = { appDir: 'src/app', ...raw.routes }
  const media = { roots: ['public'], remoteOrigin: null, remoteUploadPrefixes: [], ...raw.media }
  const focusRegistry = { handPath: null, autoPath: 'src/lib/image-focus.auto.ts', ...raw.focusRegistry }
  const devServer = { buildCommand: 'npm run build', startCommand: 'npx next start -p {port} -H 127.0.0.1', ...raw.devServer }
  const chrome = { extraCandidates: [], ...raw.chrome }

  return {
    configPath,
    projectRoot,
    baseUrl: raw.baseUrl || null,
    threshold: typeof raw.threshold === 'number' ? raw.threshold : 0.6,
    routes: { appDir: routes.appDir },
    media: {
      roots: media.roots,
      remoteOrigin: media.remoteOrigin,
      remoteUploadPrefixes: media.remoteUploadPrefixes,
    },
    focusRegistry: { handPath: focusRegistry.handPath, autoPath: focusRegistry.autoPath },
    viewports: raw.viewports || DEFAULT_VIEWPORTS,
    blockRequestPatterns: raw.blockRequestPatterns || DEFAULT_BLOCK_PATTERNS,
    chrome,
    devServer,
  }
}

/** Absolute path for a project-relative path from the config. */
export function inProject(config, ...segments) {
  return join(config.projectRoot, ...segments)
}
