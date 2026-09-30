---
name: photo-framing
description: "Use when building or changing any web page with photos, setting up a new web project, or before calling page work done: runs the photo-framing crop + face-safety checks (CROP, FACE_CLIPPED, DUPLICATE_IMAGE, GALLERY_MISMATCH) and wires the deploy gate that refuses to ship an unreviewed page."
user-invocable: true
---

# photo-framing

A page is not done until photo-framing passes. This skill wraps the `photo-framing` package
(`github.com/ShiranNYC/photo-framing`), which screenshots every changed route at desktop
and phone widths and fails on a bad crop, a clipped face, a duplicate image, or an uneven
gallery row, in a portable engine any web project can install.

## What it guarantees

- **CROP**: an `object-fit: cover` image showing less than 60% of the photo.
- **FACE_CLIPPED**: a main-subject face cut by the frame, detected with a real offline face
  model (OpenCV YuNet, runs locally -- no photo ever leaves the machine). A cut background
  bystander is reported separately and never fails the gate.
- **IMAGE_LOADS / DUPLICATE_IMAGE / GALLERY_MISMATCH**: a broken image, the same photo used
  twice, or a gallery row with a dead-space void next to a tall image.
- **Fail-closed face checking**: a new or changed image with no face data auto-triggers a
  scan and re-judge in the same run; if the scan can't run, the route fails
  (`NOT_FACE_CHECKED`) rather than passing silently.
- **A ratchet baseline**: adopting this into an existing site doesn't require fixing every
  photo on day one -- `--write-baseline` grandfathers what's already there, and the list can
  only shrink from there.

Full check definitions, config reference, and the ratchet/auto-crop mechanics:
`node_modules/photo-framing/README.md` after install.

## Install (new project)

1. `npm install --save-dev github:ShiranNYC/photo-framing#<latest tag>` (v0.2.0 or later for
   the options below). A deploy server without git can install from the release tarball
   instead: `npm install --save-dev https://github.com/<owner>/photo-framing/archive/refs/tags/<tag>.tar.gz`
2. `cp node_modules/photo-framing/photo-framing.config.example.json photo-framing.config.json`
   and set at least `baseUrl` and `routes.appDir` (your Next.js App Router dir).
3. Gitignore `.photo-framing/*` except `stamps.json`, `baseline.json`, `crop-worst.md`,
   `auto-focus-legacy.json` (see README "Setup in 5 steps" for the exact block).
4. One-time face-detection setup:
   `python3 -m venv .photo-framing/faces-venv && .photo-framing/faces-venv/bin/pip install -r node_modules/photo-framing/faces/requirements.txt`
5. Add npm scripts `page-review`, `page-review:gate`, `generate:image-focus` pointing at the
   package's scripts (README has the exact `package.json` block).

Sites that build pages from shared content and components (images named by key, not by path)
should set, in `photo-framing.config.json`:

- `"routes": { "trackImports": "deep" }`: a route owns the full import closure of its files and
  layouts, so editing a shared file marks every route that reaches it STALE (`page-review -- --all`
  re-stamps them). Default `"one-hop"` is the v0.1.0 behaviour.
- `"media": { "trackRendered": true }` (on by default in deep mode): each stamp lists the local
  images the page actually rendered and hashes them, so a changed photo blocks the routes that
  show it.
- `"routes": { "exclude": ["/admin"] }`: routes under these prefixes are skipped by review,
  `--all` and the gate. Every run prints which were excluded; nothing is dropped silently.

If the project already has `photo-framing.config.json`, it's already wired -- just run
`npm run page-review -- <route>` on whatever you changed.

## Wire the deploy gate

Add a step to the deploy script, BEFORE it builds or ships anything, that runs
`node node_modules/photo-framing/scripts/page-review-gate.mjs --deployed-sha "$DEPLOYED_SHA"`
and stops the deploy on non-zero exit. Exact snippet: README "Wire the gate into a deploy
script". This is what makes "done" enforced instead of aspirational -- a changed route with
no current review stamp blocks the deploy, before anything ships.

## Rule: a page is not done until this passes

Before reporting page/feature work complete: run
`npm run page-review -- <the routes you touched>` (or `--base <staging-url>` against a
deployed preview), open the contact sheets it writes to `.photo-framing/shots/`, and only
then call it done. A stamp proves screenshots were taken and the checks ran on exactly that
content -- it does NOT prove a human looked. Look anyway.

## Handling a finding

1. **Fix it**: usually a container shape or `object-position` change. If the site uses the
   optional focus registry (`templates/image-focus.ts.template`), a `FACE_CLIPPED` report's
   `--face-report` output gives the exact `object-position` to register.
2. **Different image**: sometimes no crop of the given photo works for a box shape; swap the
   photo instead of contorting the position.
3. **Grandfather, only with owner OK**: `data-crop-ok="<reason>"` / `data-gallery-ok="<reason>"`
   on the element is a human sign-off on a specific crop, not a way to silence the check.
   Adding a route to `baseline.json`'s `neverGrandfather` list, or removing a baseline entry,
   is a deliberate decision -- ask before doing either on someone else's project.

## When NOT to use this

Static marketing pages with zero photos, or a check the owner has explicitly said to skip for
one deploy (`PHOTO_FRAMING_SKIP="reason"`, which still logs the skip loudly). Otherwise: any
page with photos, on any project, gets this before it ships.
