/**
 * Matching for baseline.json's `neverGrandfather` list.
 *
 * An entry is a URL path (`/artists`) or a route pattern with Next.js-style dynamic segments
 * (`/artists/[slug]`). Each `[name]` segment matches exactly one path segment, so a pattern
 * keeps covering pages added later (a new slug) instead of failing open the day one appears.
 * An entry with no brackets matches only that exact path.
 */
const trim = (p) => p.replace(/\/+$/, '') || '/'

/** Returns a function: does this concrete URL path match any entry in `entries`? */
export function neverMatcher(entries) {
  const patterns = (entries || []).map((e) => trim(e).split('/'))
  return (path) => {
    const segs = trim(path).split('/')
    return patterns.some((pat) => pat.length === segs.length && pat.every((p, i) => (/^\[[^\]/]+\]$/.test(p) ? segs[i] !== '' : p === segs[i])))
  }
}
