#!/usr/bin/env python3
"""
detect-faces.py: offline face detection for every photo a site can render.

WHY: page-review's CROP check is geometry only, so it can pass a portrait crop that cuts
someone's head off (the container shape looked fine; nothing knew where the face was).
FACE_CLIPPED in scripts/page-review.mjs needs to know where the faces are; this script is
that knowledge's one home, written to <project>/.photo-framing/faces.json.

PRIVACY: detection runs locally with OpenCV YuNet (an ONNX model in ../faces/models, from
opencv_zoo, MIT licensed -- see faces/licenses/). No photo is ever sent to any external
service. Images served from a remote origin (config.media.remoteUploadPrefixes -- e.g. a CMS
upload path not checked into git) are only DOWNLOADED, read-only, into a gitignored cache.

Setup (the venv lives in the CONSUMING project, gitignored, not inside this package):
  python3 -m venv .photo-framing/faces-venv
  .photo-framing/faces-venv/bin/pip install -r node_modules/photo-framing/faces/requirements.txt

Usage (run from the project root, or pass --project-root):
  .photo-framing/faces-venv/bin/python node_modules/photo-framing/scripts/detect-faces.py
  .photo-framing/faces-venv/bin/python node_modules/photo-framing/scripts/detect-faces.py --only /images/foo.webp /api/file/bar.webp

Config: reads photo-framing.config.json (see scripts/lib/config.mjs for the JS-side loader;
this script re-implements the small subset it needs so the Python side has no Node dependency).
  media.roots              local directories images are read from (default ["public"]);
                           a file under one of these maps to the URL path Next.js serves it
                           at: public/images/x.jpg -> /images/x.jpg
  media.remoteOrigin       origin to fetch remote-hosted images from (default: baseUrl)
  media.remoteUploadPrefixes  URL path prefixes that are NOT in git (e.g. CMS uploads) and
                           must be downloaded to be scanned (default: [])
  baseUrl                  used for the sitemap crawl that discovers remote upload paths,
                           and as the default --base

--only PATH [PATH ...]: detect just these image paths (as page-review requests them: local
paths like /images/foo.webp, or remote-prefixed paths like /api/file/bar.webp), skipping the
full media-root walk and sitemap crawl. The result is MERGED into the existing faces.json
(every other image keeps its entry); only the named paths are added or re-detected. This is
what scripts/page-review.mjs runs automatically when it finds a content image missing from
faces.json or changed since it was written -- never a full rebuild for one new photo.

Output: faces.json maps image path (as the page requests it) to {sha256, width, height,
faces:[{x,y,w,h,score}]}, boxes normalized 0-1. Every candidate at or above CANDIDATE_MIN is
stored; the top-level "minScore" is the tuned threshold page-review applies. Incremental: a
file whose sha256 is unchanged keeps its entry without re-running detection.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(SCRIPT_DIR)
MODEL = os.path.join(PACKAGE_ROOT, 'faces', 'models', 'face_detection_yunet_2023mar.onnx')
MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
CONFIG_FILENAME = 'photo-framing.config.json'
# Detector version: bump when anything below changes, so every entry re-runs.
DETECTOR = 'yunet-2023mar/max1600/cand0.5/v1'
# Candidates stored; the gate threshold (MIN_SCORE) is applied by the consumer, so it
# can be re-tuned without re-running detection.
CANDIDATE_MIN = 0.5
MIN_SCORE = 0.85
# How MIN_SCORE was chosen (on the source project's image set, 1431 images, 3765 candidates):
# a seeded random 48 candidates per score band (faces >= 3% of image width, the size
# FACE_CLIPPED checks) were cropped into contact sheets and judged by eye. Re-tune for your
# own image set if you see false positives or missed faces; write your findings into
# photo-framing.config.json as `faceDetection.minScore` (falls back to this default).
TUNING = {
    'method': 'seeded random 48 candidates per band, faces >= 3% of image width, judged by eye',
    'bands': [
        {'score': '0.70-0.80', 'candidates': 108, 'sampled': 48, 'notAFace': 13},
        {'score': '0.80-0.85', 'candidates': 100, 'sampled': 48, 'notAFace': 4},
        {'score': '0.85-0.90', 'candidates': 348, 'sampled': 48, 'notAFace': 0},
        {'score': '0.90-1.00', 'candidates': 989, 'sampled': 48, 'notAFace': 0},
    ],
    'falsePositivesSeen': 'sunglasses, bokeh, balloons, jewelry, flowers, a spiral print, painted lips',
    'choice': 'minScore 0.85: 0/96 false positives above it; 0.80 would admit ~8% junk in its band',
    'source': 'tuned on the source project this engine was ported from; carried forward as the default, re-tune per project if needed',
}
MAX_SIDE = 1600  # detection runs on the photo scaled so its long side is at most this
EXT = re.compile(r'\.(webp|jpe?g|png|avif)$', re.I)
UA = 'PhotoFramingFaceScan/1.0 (read-only, offline detection)'


def find_project_root(start):
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, CONFIG_FILENAME)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_config(project_root):
    path = os.path.join(project_root, CONFIG_FILENAME)
    with open(path) as f:
        raw = json.load(f)
    media = {'roots': ['public'], 'remoteOrigin': None, 'remoteUploadPrefixes': []}
    media.update(raw.get('media') or {})
    return {
        'baseUrl': raw.get('baseUrl'),
        'media': media,
        'faceDetection': {'minScore': MIN_SCORE, **(raw.get('faceDetection') or {})},
    }


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def local_images(project_root, roots):
    """(url_path, abs_file_path) for every matching image under each configured media root."""
    out = []
    for root in roots:
        base = os.path.join(project_root, root)
        for d, _, files in os.walk(base):
            for f in files:
                if EXT.search(f):
                    full = os.path.join(d, f)
                    out.append(('/' + os.path.relpath(full, base).replace(os.sep, '/'), full))
    return sorted(set(out))


def fetch(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def upload_paths(base: str, prefixes):
    """Every remote-prefixed path any sitemap page references in its HTML (plain or /_next/image-encoded)."""
    if not prefixes:
        return [], 0, []
    upload_re = re.compile('(?:' + '|'.join(re.escape(p) for p in prefixes) + r')[^"\'&?\s\\)]+')
    xml = fetch(base + '/sitemap.xml').decode('utf8', 'replace')
    pages = sorted(set(re.findall(r'<loc>([^<]+)</loc>', xml)))
    found = set()

    def scan(u):
        path = re.sub(r'^https?://[^/]+', '', u) or '/'
        try:
            html = fetch(base + path).decode('utf8', 'replace')
        except Exception as e:  # a page that fails to load is reported, never silently skipped
            return path, None, str(e)
        html = urllib.parse.unquote(html)
        return path, set(upload_re.findall(html)), None

    errors = []
    with ThreadPoolExecutor(8) as ex:
        for path, hits, err in ex.map(scan, pages):
            if err:
                errors.append(f'{path}: {err}')
            else:
                found |= {h for h in hits if EXT.search(h)}
    return sorted(found), len(pages), errors


def load_detector():
    with open(MODEL, 'rb') as f:
        if sha256(f.read()) != MODEL_SHA256:
            sys.exit(f'model checksum mismatch: {MODEL}')
    return cv2.FaceDetectorYN.create(MODEL, '', (320, 320), CANDIDATE_MIN, 0.3, 5000)


def detect(det, data: bytes):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    s = min(1.0, MAX_SIDE / max(w, h))
    small = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
    sh, sw = small.shape[:2]
    det.setInputSize((sw, sh))
    _, rows = det.detect(small)
    faces = []
    for r in rows if rows is not None else []:
        x, y, fw, fh, score = float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[14])
        # clamp to the frame; YuNet can extend a box a little past an edge
        x0, y0 = max(0.0, x), max(0.0, y)
        x1, y1 = min(sw, x + fw), min(sh, y + fh)
        if x1 <= x0 or y1 <= y0:
            continue
        faces.append({
            'x': round(x0 / sw, 4), 'y': round(y0 / sh, 4),
            'w': round((x1 - x0) / sw, 4), 'h': round((y1 - y0) / sh, 4),
            'score': round(score, 3),
        })
    faces.sort(key=lambda f: -f['score'])
    return {'width': w, 'height': h, 'faces': faces}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-root', default=None, help='defaults to the nearest ancestor of cwd containing photo-framing.config.json')
    ap.add_argument('--base', default=None, help='defaults to media.remoteOrigin, then baseUrl, from the config')
    ap.add_argument('--no-uploads', action='store_true')
    ap.add_argument('--force', action='store_true', help='re-run detection on every file')
    ap.add_argument('--only', nargs='+', metavar='PATH', default=None,
                     help='detect only these image paths (as page-review requests them), merged into the '
                          'existing faces.json instead of a full rebuild')
    a = ap.parse_args()

    project_root = a.project_root or find_project_root(os.getcwd())
    if not project_root:
        sys.exit(f'no {CONFIG_FILENAME} found in {os.getcwd()} or any parent directory (or pass --project-root)')
    config = load_config(project_root)
    roots = config['media']['roots']
    prefixes = config['media']['remoteUploadPrefixes']
    base = (a.base or config['media']['remoteOrigin'] or config['baseUrl'] or '').rstrip('/')
    min_score = config['faceDetection']['minScore']

    review_dir = os.path.join(project_root, '.photo-framing')
    out_path = os.path.join(review_dir, 'faces.json')
    cache_dir = os.path.join(review_dir, 'faces-cache')

    existing_detector = None
    prev = {}
    if os.path.exists(out_path):
        with open(out_path) as f:
            existing_doc = json.load(f)
        existing_detector = existing_doc.get('detector')
        if existing_detector == DETECTOR:
            prev = existing_doc.get('images', {})

    if a.only and os.path.exists(out_path) and existing_detector != DETECTOR:
        sys.exit(
            f'--only refuses to run: faces.json was written by detector {existing_detector!r}, this script is '
            f'{DETECTOR!r}. A merge would mislabel every other image as scanned by the current detector when it '
            f'was not. Run a full scan first (drop --only) so every image re-runs under the current detector.'
        )

    det = load_detector()

    def upload_getter(p):
        def g():
            if not base:
                raise RuntimeError('no base URL configured (set baseUrl or media.remoteOrigin in photo-framing.config.json, or pass --base)')
            cached = os.path.join(cache_dir, re.sub(r'[^A-Za-z0-9._-]', '_', p))
            data = fetch(base + urllib.parse.quote(p))
            with open(cached, 'wb') as f:
                f.write(data)
            return data
        return g

    n_pages, page_errors = 0, []
    if a.only:
        os.makedirs(cache_dir, exist_ok=True)
        items = []
        for p in a.only:
            local_file = None
            for root in roots:
                candidate = os.path.join(project_root, root, p.lstrip('/'))
                if os.path.isfile(candidate):
                    local_file = candidate
                    break
            if local_file:
                items.append((p, (lambda full=local_file: open(full, 'rb').read())))
            elif any(p.startswith(pre) for pre in prefixes):
                items.append((p, upload_getter(p)))
            else:
                page_errors.append(f'{p}: not found under any media root {roots} and does not start with a configured remote upload prefix {prefixes}')
    else:
        items = [(p, (lambda full=full: open(full, 'rb').read())) for p, full in local_images(project_root, roots)]
        if not a.no_uploads and prefixes:
            if not base:
                page_errors.append('remote upload scan skipped: no base URL configured (set baseUrl in photo-framing.config.json, or pass --base)')
            else:
                os.makedirs(cache_dir, exist_ok=True)
                ups, n_pages, page_errors = upload_paths(base, prefixes)
                items += [(p, upload_getter(p)) for p in ups]

    # --only merges into the existing file (every other image keeps its entry); a full scan
    # starts empty so a since-deleted image naturally drops out, same as before.
    images, reused, ran, failed = (dict(prev) if a.only else {}), 0, 0, []
    for i, (path, read) in enumerate(items):
        try:
            data = read()
        except Exception as e:
            failed.append(f'{path}: {e}')
            continue
        digest = sha256(data)
        old = prev.get(path)
        if old and old.get('sha256') == digest and not a.force:
            images[path] = old
            reused += 1
            continue
        r = detect(det, data)
        if r is None:
            failed.append(f'{path}: could not decode')
            continue
        images[path] = {'sha256': digest, **r}
        ran += 1
        if ran % 100 == 0:
            print(f'  detected {ran} ...', flush=True)

    doc = {
        'about': 'Face boxes per image, normalized 0-1, from detect-faces.py (OpenCV YuNet, offline). '
                 'faces holds every candidate >= candidateMin; page-review applies minScore.',
        'detector': DETECTOR,
        'candidateMin': CANDIDATE_MIN,
        'minScore': min_score,
        'tuning': TUNING,
        'generated': datetime.now(timezone.utc).isoformat(),
        'images': dict(sorted(images.items())),
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        # one image per line keeps diffs readable
        body = ',\n'.join(f'    {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))}' for k, v in doc['images'].items())
        head = json.dumps({k: v for k, v in doc.items() if k != 'images'}, indent=2)[:-2]
        f.write(f'{head},\n  "images": {{\n{body}\n  }}\n}}\n')

    with_faces = sum(1 for v in images.values() if any(x['score'] >= min_score for x in v['faces']))
    scope = f'{len(a.only)} requested path(s)' if a.only else f'{len(images)} images'
    print(f'faces.json: {scope} ({ran} detected, {reused} unchanged and reused), '
          f'{len(images)} images total in the file, {with_faces} with a face at score >= {min_score}')
    if not a.only and not a.no_uploads and prefixes:
        print(f'uploads: scanned {n_pages} sitemap pages, {len(page_errors)} page fetch error(s)')
    for e in page_errors + failed:
        print('  NOT SCANNED ' + e)
    return 1 if failed or page_errors else 0


if __name__ == '__main__':
    sys.exit(main())
