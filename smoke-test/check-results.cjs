// Explicit .cjs so this runs as CommonJS regardless of the package's "type": "module",
// since it just needs to `require()` a JSON results file and print two yes/no answers.
const results = require(require('node:path').resolve(process.argv[2]))
const has = (path, type) => {
  const r = results.find((x) => x.path === path)
  return r ? r.findings.some((f) => f.type === type) : null
}
console.log('bad=' + (has('/bad-crop.html', 'FACE_CLIPPED') ? 'yes' : 'no'))
console.log('good=' + (has('/good-crop.html', 'FACE_CLIPPED') ? 'yes' : 'no'))
