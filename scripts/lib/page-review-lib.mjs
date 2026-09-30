/**
 * Shared home for the page-review gate: route discovery, the content hash a
 * review stamp is bound to, and the changed-file -> route mapping the deploy
 * gate uses. scripts/page-review.mjs (writes stamps) and
 * scripts/page-review-gate.mjs (reads them) both build this from the SAME
 * config so the two sides can never disagree about what "this route's content" means.
 *
 * Ported from an existing page-review engine's scripts/lib/page-review-lib.mjs:
 * every project-specific path (the app dir, the focus registry) now comes from
 * photo-framing.config.json (see ./config.mjs) instead of being hardcoded.
 *
 * Route model: assumes a Next.js App Router project (a `page.(tsx|ts|jsx|js|mdx)` file
 * per route, route groups `(name)` stripped from the URL). If your project's `routes.appDir`
 * does not exist, route discovery returns zero routes -- reviews still run against any URL
 * you pass with --base, they just never get a content-hash stamp (see README "Route
 * discovery" for what that means for non-Next.js projects).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { inProject } from './config.mjs'
import { reviewPaths } from './paths.mjs'
import { makeImportGraph } from './import-graph.mjs'

/** Media a page can reference from its image roots. A change to one of these re-requires review. */
export const MEDIA_EXT = /\.(webp|jpe?g|png|avif|gif|svg|mp4|webm)$/i
/** Files in the app-dir root that belong to EVERY page, not to "/". */
const ROOT_GLOBAL = /^(layout\.[jt]sx?|globals\.css|not-found\.[jt]sx?|error\.[jt]sx?|loading\.[jt]sx?)$/
const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx)$/
/** Files that render around every route below their directory (deep mode follows them up the tree). */
const LAYOUT_FILE = /^(layout|template)\.(tsx|ts|jsx|js|mdx)$/

/**
 * Builds every route-model function bound to one project config. Call once per run;
 * page-review.mjs and page-review-gate.mjs each do this from the config they load.
 */
export function makeLib(config) {
  const REPO = config.projectRoot
  const FRONTEND_REL = config.routes.appDir
  const FRONTEND = inProject(config, FRONTEND_REL)
  const SHARED_DIRS = [`${FRONTEND_REL}/components/`]
  const paths = reviewPaths(config)
  const DEEP = config.routes.trackImports === 'deep'
  const EXCLUDE = config.routes.exclude || []
  const graph = DEEP ? makeImportGraph(REPO) : null

  const toPosix = (p) => p.split(sep).join('/')
  const rel = (abs) => toPosix(relative(REPO, abs))

  /** True when a route key or concrete URL path sits under a `routes.exclude` prefix. */
  const isExcludedPath = (p) => {
    const n = p.replace(/\/+$/, '') || '/'
    return EXCLUDE.some((x) => n === x || n.startsWith(x + '/'))
  }

  /** Every directory under the app dir that renders a page, as project-relative paths. */
  function routeDirs() {
    if (!existsSync(FRONTEND)) return []
    const out = []
    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true })
      if (entries.some((e) => e.isFile() && PAGE_FILE.test(e.name))) out.push(rel(dir))
      for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name))
    }
    walk(FRONTEND)
    return out
  }

  /** Route key for a route dir: route groups dropped, dynamic segments kept (`/games/[slug]`). */
  function routeKeyForDir(dirRel) {
    const segs = dirRel.slice(FRONTEND_REL.length).split('/').filter(Boolean)
    const kept = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    return '/' + kept.join('/')
  }

  const isDynamicKey = (key) => /\[[^\]]+\]/.test(key)

  /** Regex that matches concrete URL paths served by a (possibly dynamic) route key. */
  function keyMatcher(key) {
    const src = key
      .split('/')
      .map((s) => (/^\[\.\.\.[^\]]+\]$/.test(s) ? '.+' : /^\[[^\]]+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^${src || '/'}$`)
  }

  /** Concrete URL path -> the route key that serves it (static routes win over dynamic ones). */
  function keyForUrlPath(urlPath, keys) {
    const p = urlPath.replace(/\/+$/, '') || '/'
    if (keys.includes(p)) return p
    return keys.filter(isDynamicKey).find((k) => keyMatcher(k).test(p)) || null
  }

  /** Files a route dir owns: its own files plus non-route subfolders (stops at child routes). */
  function ownFiles(dirRel, allRouteDirs) {
    const abs = inProject(config, dirRel)
    const isRoot = dirRel === FRONTEND_REL
    const out = []
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, e.name)
      if (e.isFile()) {
        if (isRoot && ROOT_GLOBAL.test(e.name)) continue
        out.push(rel(full))
      } else if (e.isDirectory() && !isRoot) {
        const sub = rel(full)
        if (allRouteDirs.includes(sub)) continue
        out.push(...ownFiles(sub, allRouteDirs).filter((f) => !allRouteDirs.some((r) => f.startsWith(r + '/'))))
      }
    }
    return out
  }

  const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  const RESOLVE_EXT = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '/index.tsx', '/index.ts', '/index.js']

  function resolveImport(fromRel, spec) {
    let base
    if (spec.startsWith('.')) base = join(REPO, dirname(fromRel), spec)
    else if (spec.startsWith('@/')) base = join(REPO, 'src', spec.slice(2))
    else return null
    for (const ext of RESOLVE_EXT) {
      const cand = base + ext
      if (existsSync(cand) && statSync(cand).isFile()) return rel(cand)
    }
    return null
  }

  /**
   * Direct imports that are page-specific siblings (inside the app dir, outside the
   * shared components folder and the root globals). One hop only: a sibling helper
   * counts for every page that imports it.
   */
  function pageLocalImports(fileRel) {
    if (!/\.(tsx?|jsx?|mjs)$/.test(fileRel)) return []
    const text = readFileSync(join(REPO, fileRel), 'utf8')
    const out = []
    for (const m of text.matchAll(IMPORT_RE)) {
      const r = resolveImport(fileRel, m[1] || m[2])
      if (!r || !r.startsWith(FRONTEND_REL + '/')) continue
      if (SHARED_DIRS.some((d) => r.startsWith(d))) continue
      if (dirname(r) === FRONTEND_REL && ROOT_GLOBAL.test(r.split('/').pop())) continue
      out.push(r)
    }
    return out
  }

  const MEDIA_REF_RE = /["'`(]\/([A-Za-z0-9_\-./]+\.(?:webp|jpe?g|png|avif|gif|svg|mp4|webm))/gi

  /** Files under the configured image roots that a set of source files references by literal path. */
  function referencedMedia(filesRel) {
    const out = new Set()
    for (const f of filesRel) {
      if (!/\.(tsx?|jsx?|mjs|css|json|md|mdx)$/.test(f)) continue
      const text = readFileSync(join(REPO, f), 'utf8')
      for (const m of text.matchAll(MEDIA_REF_RE)) {
        for (const root of config.media.roots) {
          const p = `${root}/${m[1]}`
          if (existsSync(join(REPO, p))) {
            out.add(p)
            break
          }
        }
      }
    }
    return [...out]
  }

  /**
   * The image-focus registries (hand-picked `focusRegistry.handPath`, generated
   * `focusRegistry.autoPath`): the one home for a photo's object-position, used by shared
   * renderers a page reaches only through the components folder (excluded from per-route
   * source hashing, see SHARED_DIRS). That means a route's own sources never include either
   * file, so editing a registered focus position would otherwise change what every route
   * renders without changing that route's contentHash. routeModel() below closes that gap
   * by attaching a registry file as a source for exactly the routes whose media includes an
   * image it registers.
   */
  const IMAGE_FOCUS_FILES = [config.focusRegistry.handPath, config.focusRegistry.autoPath].filter(Boolean)

  /** Image paths declared as keys in one image-focus registry file, by literal path in the file. */
  function registryImagePaths(relPath) {
    const abs = join(REPO, relPath)
    if (!existsSync(abs)) return []
    const text = readFileSync(abs, 'utf8')
    return [...new Set([...text.matchAll(MEDIA_REF_RE)].map((m) => '/' + m[1]))]
  }

  /** Layout/template files that wrap a route dir: every one from the app dir root down to the dir itself. */
  function layoutFiles(dirRel) {
    const out = []
    const segs = dirRel.slice(FRONTEND_REL.length).split('/').filter(Boolean)
    let cur = FRONTEND_REL
    for (let i = 0; i <= segs.length; i++) {
      if (i > 0) cur += '/' + segs[i - 1]
      for (const e of readdirSync(inProject(config, cur), { withFileTypes: true }))
        if (e.isFile() && LAYOUT_FILE.test(e.name)) out.push(`${cur}/${e.name}`)
    }
    return out
  }

  /**
   * Build the model for a subset of route dirs: key, dir, source files, media files.
   * One-hop (default): own files plus their page-local direct imports, exactly as v0.1.0.
   * Deep: own files + wrapping layouts/templates + the full transitive import closure of all
   * of them. Literal-path media is scanned only in the route's own files and layouts, not in
   * the closure: a shared registry such as an image map names every photo on the site and
   * would make every image change touch every route. The images a page really shows come from
   * the stamp's rendered-media list instead (see resolveRenderedMedia).
   */
  function buildModel(dirs, allDirs) {
    const registries = IMAGE_FOCUS_FILES.map((file) => ({ file, images: new Set(registryImagePaths(file)) }))
    return dirs.map((dir) => {
      const own = ownFiles(dir, allDirs)
      let sources
      let scanned
      if (DEEP) {
        scanned = [...new Set([...own, ...layoutFiles(dir)])]
        sources = [...graph.closure(scanned)]
      } else {
        const src = new Set(own)
        for (const f of own) for (const imp of pageLocalImports(f)) src.add(imp)
        sources = [...src]
        scanned = sources
      }
      const media = referencedMedia(scanned).sort()
      for (const { file, images } of registries) {
        for (const root of config.media.roots) {
          if (images.size && media.some((m) => m.startsWith(root + '/') && images.has('/' + m.slice(root.length + 1)))) {
            sources.push(file)
            break
          }
        }
      }
      return { key: routeKeyForDir(dir), dir, sources: (DEEP ? [...new Set(sources)] : sources).sort(), media }
    })
  }

  /** The per-route model for every route NOT excluded by config. Computed fresh every call. */
  function routeModel() {
    const dirs = routeDirs()
    return buildModel(dirs.filter((d) => !isExcludedPath(routeKeyForDir(d))), dirs)
  }

  /** Model of the routes `routes.exclude` removed; used only to name what a changed file touches. */
  function excludedModel() {
    const dirs = routeDirs()
    return buildModel(dirs.filter((d) => isExcludedPath(routeKeyForDir(d))), dirs)
  }

  /** What config excluded, for the one visible line every run prints: { prefixes, routes }. */
  function excludeInfo() {
    return { prefixes: EXCLUDE, routes: routeDirs().map(routeKeyForDir).filter(isExcludedPath).sort() }
  }

  /**
   * Turns the image URL paths a page rendered (the measured <img> srcs, after unwrapping
   * /_next/image) into project-relative files under media.roots. Remote URLs and files that
   * are not in a configured root are dropped: only local files can be hashed.
   */
  function resolveRenderedMedia(urlPaths) {
    const out = new Set()
    for (const raw of urlPaths) {
      if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) continue
      let p
      try {
        p = decodeURIComponent(raw.replace(/[?#].*$/, ''))
      } catch {
        continue
      }
      if (p.split('/').includes('..')) continue
      for (const root of config.media.roots) {
        const cand = `${root}${p}`
        if (MEDIA_EXT.test(cand) && existsSync(join(REPO, cand)) && statSync(join(REPO, cand)).isFile()) {
          out.add(cand)
          break
        }
      }
    }
    return [...out].sort()
  }

  /**
   * Content hash a stamp is bound to: every source file and referenced media file, by path and
   * bytes, plus the media the page was measured rendering (`rendered`, read from the stamp;
   * empty for a v0.1.0 stamp, which leaves the hash exactly as v0.1.0 computed it).
   */
  function contentHash(route, rendered = []) {
    const h = createHash('sha256')
    const base = new Set([...route.sources, ...route.media])
    for (const f of [...base, ...rendered.filter((r) => !base.has(r))].sort()) {
      h.update(f + '\0')
      h.update(existsSync(join(REPO, f)) ? readFileSync(join(REPO, f)) : Buffer.from('<missing>'))
      h.update('\0')
    }
    return h.digest('hex')
  }

  function readStamps() {
    if (!existsSync(paths.STAMPS_PATH)) return {}
    return JSON.parse(readFileSync(paths.STAMPS_PATH, 'utf8'))
  }

  /** Every source file under src/ as text, for the "which source references this image" grep. */
  function allSrcFiles() {
    const srcDir = join(REPO, 'src')
    if (!existsSync(srcDir)) return []
    const out = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(tsx?|jsx?|mjs|css|json|md|mdx)$/.test(e.name)) out.push(rel(full))
      }
    }
    walk(srcDir)
    return out
  }

  /**
   * Map changed repo paths to the routes whose review they invalidate.
   * Returns { routes: Map<key, reasons[]>, uncovered: [{file, why}], excluded: [{file, routes}] }.
   * Nothing is dropped: every changed path lands in exactly one of the three. `excluded` holds
   * files that touch only routes `routes.exclude` removed. `stamps` lets a changed media file
   * map to every route whose stamp lists it as rendered.
   */
  function mapChangedFiles(changed, model = routeModel(), stamps = {}) {
    const routes = new Map()
    const uncovered = []
    const excluded = []
    let excludedRoutes = null
    const add = (key, why) => {
      if (!routes.has(key)) routes.set(key, [])
      routes.get(key).push(why)
    }
    let srcIndex = null
    const reviewDirRel = rel(paths.REVIEW_DIR) + '/'
    for (const file of changed) {
      if (file.startsWith(reviewDirRel)) {
        uncovered.push({ file, why: 'review record itself' })
        continue
      }
      const owners = model.filter(
        (r) => r.sources.includes(file) || r.media.includes(file) || (stamps[r.key]?.renderedMedia || []).includes(file),
      )
      if (owners.length) {
        owners.forEach((r) => add(r.key, file))
        continue
      }
      if (EXCLUDE.length) {
        excludedRoutes ??= excludedModel()
        const hit = excludedRoutes.filter((r) => r.sources.includes(file) || r.media.includes(file))
        if (hit.length) {
          excluded.push({ file, routes: hit.map((r) => r.key).sort() })
          continue
        }
      }
      // A deleted page file: its route is gone, nothing to review, but say so.
      if (file.startsWith(FRONTEND_REL + '/') && PAGE_FILE.test(file.split('/').pop()) && !existsSync(join(REPO, file))) {
        uncovered.push({ file, why: 'page deleted (route removed)' })
        continue
      }
      if (config.media.roots.some((root) => file.startsWith(root + '/')) && MEDIA_EXT.test(file)) {
        srcIndex ??= allSrcFiles().map((f) => [f, readFileSync(join(REPO, f), 'utf8')])
        const name = file.split('/').pop()
        const refs = srcIndex.filter(([, t]) => t.includes(name)).map(([f]) => f)
        const refRoutes = model.filter((r) => r.sources.some((s) => refs.includes(s)))
        refRoutes.forEach((r) => add(r.key, file))
        const refsOutside = refs.filter((f) => !model.some((r) => r.sources.includes(f)))
        if (!refs.length) uncovered.push({ file, why: 'media not referenced by name anywhere in src/' })
        else if (refsOutside.length) uncovered.push({ file, why: `media also referenced by shared code: ${refsOutside.join(', ')}` })
        continue
      }
      const why = file.startsWith(FRONTEND_REL + '/components/')
        ? 'shared component'
        : file.startsWith(FRONTEND_REL + '/')
          ? 'global frontend file'
          : 'not page source'
      uncovered.push({ file, why })
    }
    return { routes, uncovered, excluded }
  }

  return {
    REPO,
    FRONTEND_REL,
    ...paths,
    routeDirs,
    routeKeyForDir,
    isDynamicKey,
    keyMatcher,
    keyForUrlPath,
    routeModel,
    excludeInfo,
    isExcludedPath,
    resolveRenderedMedia,
    contentHash,
    readStamps,
    mapChangedFiles,
  }
}
