import { test } from 'node:test'
import assert from 'node:assert/strict'
import { libFor, makeProject, writeFile, SHARED_APP } from './helpers.mjs'

const DEEP = { routes: { trackImports: 'deep' } }
const byKey = (model) => Object.fromEntries(model.map((r) => [r.key, r]))

test('default config reproduces the v0.1.0 one-hop mapping on a fixture', () => {
  const { lib } = libFor(makeProject(SHARED_APP))
  const m = byKey(lib.routeModel())
  assert.deepEqual(Object.keys(m).sort(), ['/', '/about', '/portal', '/portal/tools'])
  assert.deepEqual(m['/'].sources, ['src/app/page.tsx', 'src/app/tokens.css'])
  assert.deepEqual(m['/about'].sources, ['src/app/about/layout.tsx', 'src/app/about/page.tsx'])
  assert.deepEqual(m['/portal'].sources, ['src/app/portal/page.tsx'])
  assert.deepEqual(m['/portal/tools'].sources, ['src/app/portal/tools/Tool.tsx', 'src/app/portal/tools/page.tsx'])
  // a shared-file change maps to no route, as before
  const r = lib.mapChangedFiles(['src/components/Img.tsx'])
  assert.equal(r.routes.size, 0)
  assert.equal(r.uncovered.length, 1)
  assert.deepEqual(r.excluded, [])
})

test('one-hop pins the old behaviour for page-local siblings and literal media', () => {
  const root = makeProject({
    'src/app/x/page.tsx': `import { h } from '../helper'\nexport default () => <img src="/images/a.webp"/>`,
    'src/app/helper.ts': `import { deep } from './deeper'\nexport const h = 1`,
    'src/app/deeper.ts': `export const deep = 1`,
    'public/images/a.webp': 'a',
  })
  const m = byKey(libFor(root).lib.routeModel())
  assert.deepEqual(m['/x'].sources, ['src/app/helper.ts', 'src/app/x/page.tsx'])
  assert.deepEqual(m['/x'].media, ['public/images/a.webp'])
})

test('deep: sources are own files + layouts + the full transitive closure, cycles included', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  const m = byKey(lib.routeModel())
  assert.deepEqual(m['/'].sources, [
    'src/app/globals.css', 'src/app/layout.tsx', 'src/app/page.tsx', 'src/app/tokens.css',
    'src/components/Header.tsx', 'src/components/Img.tsx', 'src/content/images.ts',
  ])
  assert.deepEqual(m['/about'].sources, [
    'src/app/about/layout.tsx', 'src/app/about/page.tsx', 'src/app/globals.css', 'src/app/layout.tsx', 'src/app/tokens.css',
    'src/components/Header.tsx', 'src/components/Img.tsx', 'src/components/Nav.tsx',
    'src/content/about.ts', 'src/content/images.ts', 'src/content/tail.ts',
  ])
})

test('deep: a nested route inherits every wrapping layout but not its parent page or siblings', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  const tools = byKey(lib.routeModel())['/portal/tools'].sources
  assert.ok(tools.includes('src/app/layout.tsx') && tools.includes('src/app/globals.css'))
  assert.ok(tools.includes('src/app/portal/tools/Tool.tsx'))
  assert.ok(!tools.includes('src/app/portal/page.tsx') && !tools.includes('src/components/Img.tsx'))
})

test('deep: a nested layout is included for its routes only', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  const m = byKey(lib.routeModel())
  assert.ok(m['/about'].sources.includes('src/components/Nav.tsx'))
  assert.ok(!m['/'].sources.includes('src/components/Nav.tsx'))
})

test('deep: literal media is scanned in own files and layouts, not in the shared closure', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  // images.ts names every photo; it must not drag them all into every route
  assert.deepEqual(byKey(lib.routeModel())['/'].media, [])
})

test('shared-file change: every route that reaches it goes STALE, others do not', () => {
  const root = makeProject(SHARED_APP)
  const before = Object.fromEntries(libFor(root, DEEP).lib.routeModel().map((r) => [r.key, libFor(root, DEEP).lib.contentHash(r)]))
  writeFile(root, { 'src/components/Img.tsx': `export const Img = () => <p>changed</p>` })
  const { lib } = libFor(root, DEEP)
  const after = Object.fromEntries(lib.routeModel().map((r) => [r.key, lib.contentHash(r)]))
  const stale = Object.keys(after).filter((k) => after[k] !== before[k]).sort()
  // Img.tsx no longer imports images.ts, but the three routes that imported Img still hash it
  assert.deepEqual(stale, ['/', '/about', '/portal'])
  const { routes, uncovered } = lib.mapChangedFiles(['src/components/Img.tsx'])
  assert.deepEqual([...routes.keys()].sort(), ['/', '/about', '/portal'])
  assert.equal(uncovered.length, 0)
})

test('deep: a changed layout-only dependency marks just the routes under that layout', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  assert.deepEqual([...lib.mapChangedFiles(['src/components/Nav.tsx']).routes.keys()], ['/about'])
  assert.deepEqual([...lib.mapChangedFiles(['src/app/tokens.css']).routes.keys()].sort(), ['/', '/about', '/portal', '/portal/tools'])
})

test('rendered media: resolveRenderedMedia keeps only local files under media.roots', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  assert.deepEqual(
    lib.resolveRenderedMedia(['/images/hero.webp', '/images/hero.webp', 'https://cdn.example/x.jpg', '//cdn.example/x.jpg', '/images/missing.webp', '/images/../../etc/passwd.png', '/images/team.webp?x=1']),
    ['public/images/hero.webp', 'public/images/team.webp'],
  )
})

test('rendered media: the list is hashed, and a stamp without it hashes exactly as v0.1.0 did', () => {
  const root = makeProject(SHARED_APP)
  const { lib } = libFor(root, DEEP)
  const route = byKey(lib.routeModel())['/']
  const plain = lib.contentHash(route)
  assert.equal(lib.contentHash(route, []), plain)
  const withHero = lib.contentHash(route, ['public/images/hero.webp'])
  assert.notEqual(withHero, plain)
  writeFile(root, { 'public/images/hero.webp': 'different-bytes' })
  assert.notEqual(libFor(root, DEEP).lib.contentHash(route, ['public/images/hero.webp']), withHero)
})

test('rendered media: a changed photo maps to every route whose stamp lists it', () => {
  const { lib } = libFor(makeProject(SHARED_APP), DEEP)
  const stamps = {
    '/': { renderedMedia: ['public/images/hero.webp'] },
    '/portal': { renderedMedia: ['public/images/hero.webp'] },
    '/about': { renderedMedia: ['public/images/team.webp'] },
    '/portal/tools': {},
  }
  const hero = lib.mapChangedFiles(['public/images/hero.webp'], lib.routeModel(), stamps)
  assert.deepEqual([...hero.routes.keys()].sort(), ['/', '/portal'])
  const team = lib.mapChangedFiles(['public/images/team.webp'], lib.routeModel(), stamps)
  assert.deepEqual([...team.routes.keys()], ['/about'])
})

test('exclude: routes leave the model, and a file that only touches them is reported, not dropped', () => {
  const { lib } = libFor(makeProject(SHARED_APP), { routes: { trackImports: 'deep', exclude: ['/portal'] } })
  assert.deepEqual(lib.routeModel().map((r) => r.key).sort(), ['/', '/about'])
  assert.deepEqual(lib.excludeInfo(), { prefixes: ['/portal'], routes: ['/portal', '/portal/tools'] })
  assert.ok(lib.isExcludedPath('/portal/tools') && lib.isExcludedPath('/portal') && !lib.isExcludedPath('/portalx'))
  const only = lib.mapChangedFiles(['src/app/portal/tools/Tool.tsx'])
  assert.equal(only.routes.size, 0)
  assert.deepEqual(only.excluded, [{ file: 'src/app/portal/tools/Tool.tsx', routes: ['/portal/tools'] }])
  assert.equal(only.uncovered.length, 0)
  // a shared file that reaches both included and excluded routes is gated for the included ones
  const shared = lib.mapChangedFiles(['src/components/Img.tsx'])
  assert.deepEqual([...shared.routes.keys()].sort(), ['/', '/about'])
  assert.deepEqual(shared.excluded, [])
})

test('exclude also works in one-hop mode', () => {
  const { lib } = libFor(makeProject(SHARED_APP), { routes: { exclude: ['/portal'] } })
  assert.deepEqual(lib.routeModel().map((r) => r.key).sort(), ['/', '/about'])
})

test('a whole-site run plans one item per route, so every fully covered route can be stamped', () => {
  const { lib } = libFor(makeProject({
    'src/app/page.tsx': 'export default () => null',
    'src/app/about/page.tsx': 'export default () => null',
    'src/app/people/page.tsx': 'export default () => null',
    'src/app/people/[slug]/page.tsx': 'export default () => null',
  }))
  const routes = lib.routeModel().map((r) => r.key)
  const plan = lib.planFromUrlPaths(['/', '/about', '/people', '/people/ann', '/people/bob', '/people/ann', '/nowhere'], routes)
  const byRoute = Object.fromEntries(plan.map((i) => [String(i.key), i.paths]))
  assert.deepEqual(byRoute['/people/[slug]'], ['/people/ann', '/people/bob'])
  assert.deepEqual(byRoute['/people'], ['/people'])
  assert.deepEqual(byRoute['/'], ['/'])
  assert.deepEqual(byRoute['null'], ['/nowhere'])
  assert.equal(plan.filter((i) => i.key === null).length, 1)
})
