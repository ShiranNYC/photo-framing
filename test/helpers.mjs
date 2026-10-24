import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeConfig } from '../scripts/lib/config.mjs'
import { makeLib } from '../scripts/lib/page-review-lib.mjs'

/** Writes { 'rel/path': 'text' } into a fresh temp dir and returns its path. */
export function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'pf-test-'))
  writeFile(root, files)
  return root
}

export function writeFile(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
}

/** Lib bound to a project dir, with config overrides merged over the defaults. */
export function libFor(root, raw = {}) {
  const config = normalizeConfig(raw, root)
  return { config, lib: makeLib(config) }
}

export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
}

/**
 * A small app that composes pages from shared content and components and names photos by key:
 * the shape deep mode exists for. Two routes share a component; a third route is excluded-able.
 */
export const SHARED_APP = {
  'tsconfig.json': `{
    // comments are legal in tsconfig
    "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@content/*": ["src/content/*"], }, },
  }`,
  'src/app/layout.tsx': `import './globals.css'\nimport { Header } from '@/components/Header'\nexport default function L({children}){return <><Header/>{children}</>}`,
  'src/app/globals.css': `@import './tokens.css';\nbody{margin:0}`,
  'src/app/tokens.css': `:root{--c:red}`,
  'src/app/page.tsx': `import { Img } from '@/components/Img'\nexport default function P(){return <Img k="hero"/>}`,
  'src/app/about/page.tsx': `import { Img } from '@/components/Img'\nimport { copy } from '@content/about'\nexport default function P(){return <Img k="team">{copy}</Img>}`,
  'src/app/about/layout.tsx': `import { Nav } from '../../components/Nav'\nexport default function L({children}){return <Nav>{children}</Nav>}`,
  'src/app/portal/page.tsx': `import { Img } from '@/components/Img'\nexport default function P(){return <Img k="hero"/>}`,
  'src/app/portal/tools/page.tsx': `import { Tool } from './Tool'\nexport default function P(){return <Tool/>}`,
  'src/app/portal/tools/Tool.tsx': `export const Tool = () => null`,
  'src/components/Header.tsx': `export const Header = () => null`,
  'src/components/Nav.tsx': `export const Nav = ({children}) => children`,
  'src/components/Img.tsx': `import { images } from '@/content/images'\nexport const Img = ({k}) => <img src={images[k]}/>`,
  'src/content/images.ts': `export const images = { hero: '/images/hero.webp', team: '/images/team.webp', unused: '/images/unused.webp' }`,
  'src/content/about.ts': `import { tail } from './tail'\nexport const copy = 'about' + tail`,
  'src/content/tail.ts': `import { copy } from './about'\nexport const tail = copy ? '.' : '!'`,
  'public/images/hero.webp': 'hero-bytes',
  'public/images/team.webp': 'team-bytes',
  'public/images/unused.webp': 'unused-bytes',
}
