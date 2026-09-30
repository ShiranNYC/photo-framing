/**
 * Static import graph for `routes.trackImports: "deep"`. Given a project root, answers one
 * question: starting from these files, which project files do they reach through imports?
 *
 * Covers relative specifiers, tsconfig/jsconfig `paths` + `baseUrl` aliases (with the
 * conventional `@/` -> `src/` as a fallback when no config maps it), index files,
 * `export ... from`, side-effect imports, `require('x')` and dynamic `import('literal')`,
 * for .ts .tsx .js .jsx .mjs .cjs .mts .cts .mdx, plus `@import` inside .css. A specifier
 * that does not resolve to a file inside the project root (a bare package, a computed
 * dynamic import) is skipped. Anything under node_modules is never followed.
 *
 * No dependencies and no build step: imports are found with regexes, not a TypeScript parse.
 * That over-approximates (an import inside a comment still counts if the file exists), which
 * is the safe direction for a gate: it can only mark a route stale too often, never too rarely.
 * The per-file parse is cached by path + mtime + size, so `--all` over many routes stays fast.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const PARSE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts|mdx|css)$/
const RESOLVE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.mdx', '.json', '.css']
const JS_SWAP = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

const JS_IMPORT_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*[,)]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g

/** Removes // and block comments from JSONC (tsconfig) without touching string contents. */
export function stripJsonComments(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Reads tsconfig.json / jsconfig.json (following relative `extends`), returns {baseUrlAbs, paths}. */
function loadPathConfig(repo) {
  const readOne = (abs, depth) => {
    if (depth > 5 || !existsSync(abs)) return { baseUrlAbs: null, paths: {} }
    let cfg
    try {
      cfg = JSON.parse(stripJsonComments(readFileSync(abs, 'utf8')))
    } catch {
      return { baseUrlAbs: null, paths: {} }
    }
    let inherited = { baseUrlAbs: null, paths: {} }
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      const ext = resolve(dirname(abs), cfg.extends)
      inherited = readOne(existsSync(ext) ? ext : ext + '.json', depth + 1)
    }
    const co = cfg.compilerOptions || {}
    const baseUrlAbs = typeof co.baseUrl === 'string' ? resolve(dirname(abs), co.baseUrl) : inherited.baseUrlAbs
    // `paths` targets resolve against baseUrl, or against the config file's own directory without one
    const pathsRoot = baseUrlAbs || dirname(abs)
    const own = {}
    for (const [pat, targets] of Object.entries(co.paths || {}))
      if (Array.isArray(targets)) own[pat] = targets.map((t) => resolve(pathsRoot, t))
    return { baseUrlAbs, paths: { ...inherited.paths, ...own } }
  }
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const r = readOne(join(repo, name), 0)
    if (r.baseUrlAbs || Object.keys(r.paths).length) return r
  }
  return { baseUrlAbs: null, paths: {} }
}

const isFile = (abs) => {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/** Builds the graph for one project root. Call once per run so the parse cache is shared. */
export function makeImportGraph(repo) {
  const toPosix = (p) => p.split(sep).join('/')
  const pathCfg = loadPathConfig(repo)
  const aliasRules = Object.entries(pathCfg.paths).map(([pat, targets]) => {
    const star = pat.indexOf('*')
    return { prefix: star === -1 ? pat : pat.slice(0, star), suffix: star === -1 ? '' : pat.slice(star + 1), wild: star !== -1, targets }
  })
  const parseCache = new Map() // fileRel -> { sig, specs }

  const inside = (abs) => {
    const r = relative(repo, abs)
    return r !== '' && !r.startsWith('..') && !r.split(sep).includes('node_modules')
  }

  function asFile(base) {
    if (isFile(base)) return base
    for (const ext of RESOLVE_EXT) if (isFile(base + ext)) return base + ext
    for (const ext of RESOLVE_EXT) if (isFile(join(base, 'index' + ext))) return join(base, 'index' + ext)
    const m = base.match(/\.(js|jsx|mjs|cjs)$/)
    if (m) for (const swap of JS_SWAP['.' + m[1]]) if (isFile(base.slice(0, -m[0].length) + swap)) return base.slice(0, -m[0].length) + swap
    return null
  }

  /** Specifier -> project-relative posix path, or null (bare package, unresolvable, outside the project). */
  function resolveSpec(fromRel, rawSpec) {
    const spec = rawSpec.replace(/[?#].*$/, '')
    if (!spec) return null
    const bases = []
    if (spec.startsWith('.')) bases.push(resolve(repo, dirname(fromRel), spec))
    else {
      for (const rule of aliasRules) {
        if (rule.wild ? spec.startsWith(rule.prefix) && spec.endsWith(rule.suffix) && spec.length >= rule.prefix.length + rule.suffix.length : spec === rule.prefix) {
          const mid = rule.wild ? spec.slice(rule.prefix.length, spec.length - rule.suffix.length) : ''
          for (const t of rule.targets) bases.push(t.replace('*', mid))
        }
      }
      if (spec.startsWith('@/')) bases.push(join(repo, 'src', spec.slice(2)))
      if (pathCfg.baseUrlAbs) bases.push(join(pathCfg.baseUrlAbs, spec))
    }
    for (const b of bases) {
      const f = asFile(b)
      if (f && inside(f)) return toPosix(relative(repo, f))
    }
    return null
  }

  /** Direct, resolved imports of one file (cached by path + mtime + size). */
  function directImports(fileRel) {
    if (!PARSE_EXT.test(fileRel)) return []
    const abs = join(repo, fileRel)
    let st
    try {
      st = statSync(abs)
    } catch {
      return []
    }
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = parseCache.get(fileRel)
    if (hit && hit.sig === sig) return hit.resolved
    const text = readFileSync(abs, 'utf8')
    const specs = new Set()
    if (/\.css$/.test(fileRel)) for (const m of text.matchAll(CSS_IMPORT_RE)) specs.add(m[1])
    else for (const re of JS_IMPORT_RES) for (const m of text.matchAll(re)) specs.add(m[1])
    const resolved = [...new Set([...specs].map((s) => resolveSpec(fileRel, s)).filter(Boolean))]
    parseCache.set(fileRel, { sig, resolved })
    return resolved
  }

  /** Every file reachable from `startRel` (including the start files that exist). Cycles terminate. */
  function closure(startRel) {
    const seen = new Set()
    const queue = []
    for (const f of startRel) if (!seen.has(f) && isFile(join(repo, f))) (seen.add(f), queue.push(f))
    while (queue.length) {
      for (const imp of directImports(queue.pop())) {
        if (!seen.has(imp)) {
          seen.add(imp)
          queue.push(imp)
        }
      }
    }
    return seen
  }

  return { resolveSpec, directImports, closure }
}
