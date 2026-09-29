# photo-framing

Screenshot-driven crop and face-safety checks for web pages, plus a deploy gate that
refuses to ship a changed page without a review stamp.

"Verify in the browser" as a line in a checklist is not a mechanism. This package is the
mechanism: it builds (or points at) your site, screenshots every route at desktop and phone
widths, and fails the ones with a bad photo crop, a clipped face, a duplicate image, or an
uneven gallery row -- before you deploy, not after someone notices.

## What it checks

Run against a route, every content image (`object-fit: cover`) is checked for:

- **CROP** -- the rendered box shows less than `threshold` (default 0.6) of the photo.
- **FACE_CLIPPED** -- a *prominent* (main-subject) face is cut by the rendered frame, or under
  90% visible. Uses real face detection (see below), not guesswork. A cut *bystander* face at
  the frame edge is reported separately (`EDGE_BYSTANDER`) and never fails the gate --
  cropping out someone in the background is normal photography.
- **BACKDROP_CANDIDATE** -- a dimmed full-width image behind a CTA heading and button, report
  only: the suggestion is to mark it decorative so it stops being judged as a photo at all.
- **IMAGE_LOADS** -- the image never actually loaded (`naturalWidth` is 0).
- **DUPLICATE_IMAGE** -- the same file used more than once in the visible content.
- **GALLERY_MISMATCH** -- a row of images at natural aspect ratio with wildly different
  heights, leaving a dead-space void next to a tall one.
- **NOT_FACE_CHECKED** -- a content image page-review cannot yet judge for FACE_CLIPPED (new,
  or changed since the last scan). This **fails closed**: page-review auto-runs face
  detection on exactly the unscanned images and re-judges the route in the same run; if that
  scan cannot run (missing venv, a decode error, an unreachable image), the route fails and
  is never silently waved through.

Every check can be exempted per-image with `data-crop-ok="<reason>"` (CROP, FACE_CLIPPED) or
`data-gallery-ok="<reason>"` (GALLERY_MISMATCH) on the `<img>` or an ancestor -- for a crop a
human has actually looked at and approved. An image is "decorative" (exempt from all of the
above) when it or an ancestor has `aria-hidden="true"`, has `alt=""` (present and empty), or
sits under computed `pointer-events: none` inside `<main>`.

Findings ratchet through `.photo-framing/baseline.json` (see "The ratchet baseline" below):
existing findings on a site you're adopting this into don't have to be fixed on day one, but
the list can only shrink, never grow.

## Face detection: how, and the privacy guarantee

Faces are detected **entirely offline** with OpenCV's YuNet model (`faces/models/`, MIT
licensed, see `faces/licenses/NOTICE.md`) via `scripts/detect-faces.py`. No photo is ever
sent to any external service, ever -- this is a hard design constraint, not a configuration
option. Images hosted remotely (e.g. a CMS upload path not checked into your repo) are only
*downloaded*, read-only, into a gitignored cache so the same local model can look at them.

Detected face boxes are written to `.photo-framing/faces.json` (gitignored; it can be large
and is fully reproducible by re-running the scan). `page-review.mjs` auto-runs the scanner on
any image it doesn't recognize, so day-to-day you should rarely need to run it by hand.

## Use it as a Claude Code skill

Copy `skill/SKILL.md` to `~/.claude/skills/photo-framing/SKILL.md`. Claude Code then offers `/photo-framing`, and uses it on its own when you build or change a page with photos.

## Setup in 5 steps

1. **Install** (see "Install path" below for why this method):

   ```bash
   npm install --save-dev github:ShiranNYC/photo-framing#v0.1.0
   ```

2. **Copy the config** into your project root and edit it:

   ```bash
   cp node_modules/photo-framing/photo-framing.config.example.json photo-framing.config.json
   ```

   At minimum, set `baseUrl` (your production URL) and `routes.appDir` (your Next.js App
   Router directory, e.g. `"src/app"` or `"src/app/(frontend)"` if you use a route group).
   If your project has images hosted outside git (a CMS), set `media.remoteUploadPrefixes`
   (e.g. `["/api/file/"]`) and `media.remoteOrigin`. See the comments in
   `photo-framing.config.example.json` for every field and its default.

3. **Gitignore the review record**, keeping the four files that should be committed:

   ```gitignore
   .photo-framing/*
   !.photo-framing/stamps.json
   !.photo-framing/baseline.json
   !.photo-framing/crop-worst.md
   !.photo-framing/auto-focus-legacy.json
   ```

4. **Set up face detection** (one-time; the venv lives in your project, not in
   `node_modules`, so it survives a `node_modules` wipe):

   ```bash
   python3 -m venv .photo-framing/faces-venv
   .photo-framing/faces-venv/bin/pip install -r node_modules/photo-framing/faces/requirements.txt
   ```

5. **Add npm scripts** (optional but recommended):

   ```json
   {
     "scripts": {
       "page-review": "node node_modules/photo-framing/scripts/page-review.mjs",
       "page-review:gate": "node node_modules/photo-framing/scripts/page-review-gate.mjs",
       "generate:image-focus": "node node_modules/photo-framing/scripts/generate-image-focus.mjs"
     }
   }
   ```

   Then review a route with `npm run page-review -- /some/route`, or a whole site with
   `npm run page-review -- --all --base https://your-site.com --write-baseline` (the first
   run against a real, already-live site: this seeds the baseline with everything already
   wrong, so the gate only stops *new* problems from here).

## Wire the gate into a deploy script

Add this **before** your deploy builds or ships anything, so a blocked review stops the
deploy before it does any work:

```bash
echo "[gate] page-review"
DEPLOYED_SHA="$(ssh "$SERVER" "head -1 $REMOTE_DIR/.deployed-sha 2>/dev/null" | awk '{print $1}' || true)"
if ! node node_modules/photo-framing/scripts/page-review-gate.mjs --deployed-sha "$DEPLOYED_SHA"; then
  echo "DEPLOY STOPPED by the page-review gate."
  exit 1
fi
```

`--deployed-sha` should come from wherever your deploy already records what commit is live
(most deploy scripts write something like `.deployed-sha` on the target after a successful
deploy -- if yours doesn't yet, add one line to do that). Without it, the gate falls back to
the merge-base with your remote's `main` branch, which still works but can't see routes
changed on the deploy target that never made it into this clone.

Escape hatch for a deploy that must go out anyway: `PHOTO_FRAMING_SKIP="reason" bash deploy.sh`
passes the gate, prints the reason loudly, and logs it to `.photo-framing/skips.log` (commit
that file -- it's the paper trail of what shipped unreviewed and why).

## The ratchet baseline

`.photo-framing/baseline.json` lists findings that are grandfathered: printed, counted, but
never failing. Anything not in it fails. The list can only shrink:

- First run against a live site: `--write-baseline` (with `--all --base <url>`) snapshots
  everything currently wrong, so adopting this into an existing site doesn't require fixing
  every photo on day one.
- Fixed a page? Its stale baseline entries are reported next run; `--prune-baseline` removes
  them, so the baseline only ever gets smaller.
- Shipping a new check onto a site that already has findings for it (e.g. turning on
  FACE_CLIPPED after CROP has been running a while): `--baseline-add FACE_CLIPPED` grandfathers
  just that check's current findings, leaving everything else alone, so a human can decide
  them on their own schedule instead of the gate blocking every page at once.
- A route can be put on `baseline.json`'s `neverGrandfather` list: never baselined, never
  exempted, a fix owed rather than a pass.

## Auto-crop: the focus registry

If you want new photos with an off-center face to get a *sane* default crop automatically
(instead of `object-position: center`, which can clip a face nobody has reviewed yet), copy
`templates/image-focus.ts.template` into your project (e.g. `src/lib/image-focus.ts`), point
`focusRegistry.handPath` at it in your config, and call `focusFor(src)` from any renderer that
shows a content photo with `object-fit: cover`:

```ts
style={{ objectPosition: override || focusFor(src) }}
```

`page-review.mjs` auto-generates `focusRegistry.autoPath` (default
`src/lib/image-focus.auto.ts`) for any image with a detected prominent face that isn't in
your hand-picked registry. The deploy gate fails if that generated file is stale (run
`generate:image-focus` to refresh it). Images already known to `faces.json` the first time
this ran for your project are frozen in `.photo-framing/auto-focus-legacy.json` and never get
an automatic crop retroactively -- only images added afterward.

This whole step is optional: FACE_CLIPPED and CROP work without a focus registry at all; it
only improves what *new* photos look like by default.

## Route discovery

Route discovery assumes a Next.js App Router project: a `page.(tsx|ts|jsx|js|mdx)` file per
route under `routes.appDir`, with route groups (`(marketing)`) stripped from the URL. This is
what lets the deploy gate know *which route* a changed file belongs to, and lets it hash a
route's exact source + media so a stamp can prove "this content was reviewed."

If `routes.appDir` doesn't exist (a non-Next.js project, or you just want ad hoc checks),
route discovery returns zero routes -- `page-review.mjs --base <url> /some/path` still runs
every check against that URL, it just can never mark a route as reviewed for the deploy
gate, and `page-review-gate.mjs` has nothing to check against source-file changes for.
`--sitemap` / `--all` still work off your live sitemap.xml either way.

## Install path

Installed as an **npm dependency pinned to a git tag**, not `npx`'d on demand or vendored by
hand-copy:

```bash
npm install --save-dev github:ShiranNYC/photo-framing#v0.1.0
```

Why: the engine needs to read and write files inside your project on every run
(`.photo-framing/`, the generated focus registry) and be called repeatedly from your deploy
script and CI -- that needs a stable on-disk location, which `npx` (which re-fetches and runs
in a temp location) doesn't give you for free. A plain vendored copy-paste would drift
silently between projects with no way to tell what version you're on. A git-tag dependency
gets you: a pinned, reproducible version in `package-lock.json`; a normal `npm update` /
version-bump path (`npm install ...#v0.2.0`) when the engine changes; and no separate
publishing step for what is, for now, a private, single-owner tool. If this ever needs to be
consumed by parties without SSH access to this repo, switch to an HTTPS git URL with a
deploy-key-scoped PAT, or publish it to a private npm registry -- the config contract and the
scripts don't change either way.

## Smoke test

`npm run smoke-test` (or `bash smoke-test/run-smoke-test.sh`) proves the engine end to end
against a tiny fixture site: a public-domain face photo, rendered once in a deliberately bad
crop and once in a good one, served by a plain static file server (no Next.js involved). It
asserts `FACE_CLIPPED` fires on the bad page and not on the good one, using the real
detection model and the real browser-based measurement -- not a mock. See
`smoke-test/run-smoke-test.sh` for the fixture photo's source and license (public domain,
NASA official portrait via Wikimedia Commons).

## What a stamp does NOT prove

A stamp in `.photo-framing/stamps.json` proves screenshots were taken and the machine checks
passed on exactly that content. It does not prove a person looked at the screenshots. Open
the contact sheets (`.photo-framing/shots/<route>/`) before calling a page done -- the
checks catch crops and clipped faces; they do not catch a photo that's simply the wrong one,
badly lit, or off-brand.
