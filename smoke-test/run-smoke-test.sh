#!/usr/bin/env bash
# Smoke test: proves FACE_CLIPPED fails a genuinely bad crop and passes a good one, end to
# end through the real engine (detect-faces.py -> page-review.mjs), against a tiny static
# fixture site. No Next.js build involved: page-review is run with --base against a plain
# static file server, which the engine supports natively (see scripts/page-review.mjs's
# --base flag).
#
# Fixture photo: smoke-test/fixtures/public/images/face.jpg, a public-domain NASA official
# portrait of Apollo 15 Command Module Pilot Al Worden (Wikimedia Commons, "Al Worden Apollo
# 15 CMP (3x4 cropped).jpg", credited to NASA / Apollo Lunar Surface Journal, License: Public
# domain -- U.S. government work). Resized to 600x799 for repo size; not modified otherwise.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
FIXTURES="$HERE/fixtures"
PUBLIC="$FIXTURES/public"
VENV="$FIXTURES/.photo-framing/faces-venv"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[smoke-test] 1/5 python venv for face detection"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet -r "$ROOT/faces/requirements.txt"
else
  echo "  reusing existing venv at $VENV"
fi

echo "[smoke-test] 2/5 detecting faces in the fixture photo"
"$VENV/bin/python" "$ROOT/scripts/detect-faces.py" --project-root "$FIXTURES" --no-uploads

echo "[smoke-test] 3/5 building the bad-crop / good-crop fixture pages"
node "$HERE/build-fixture-pages.mjs"

echo "[smoke-test] 4/5 serving the fixture site"
PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
python3 -m http.server "$PORT" --directory "$PUBLIC" --bind 127.0.0.1 >/tmp/photo-framing-smoke-http.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/images/face.jpg" -o /dev/null && break
  sleep 0.3
done

echo "[smoke-test] 5/5 running page-review against both pages"
OUT_JSON="$HERE/.tmp-results.json"
mkdir -p "$HERE"
set +e
(cd "$FIXTURES" && node "$ROOT/scripts/page-review.mjs" --base "http://127.0.0.1:$PORT" /bad-crop.html /good-crop.html --json "$OUT_JSON" --no-shots)
REVIEW_EXIT=$?
set -e

CHECK_OUT="$(node "$HERE/check-results.cjs" "$OUT_JSON")"
BAD_HAS_FACE_CLIPPED="$(echo "$CHECK_OUT" | sed -n 's/^bad=//p')"
GOOD_HAS_FACE_CLIPPED="$(echo "$CHECK_OUT" | sed -n 's/^good=//p')"

echo ""
echo "[smoke-test] result: /bad-crop.html FACE_CLIPPED=$BAD_HAS_FACE_CLIPPED (want yes), /good-crop.html FACE_CLIPPED=$GOOD_HAS_FACE_CLIPPED (want no)"

if [ "$BAD_HAS_FACE_CLIPPED" = "yes" ] && [ "$GOOD_HAS_FACE_CLIPPED" = "no" ]; then
  echo "[smoke-test] PASS"
  exit 0
else
  echo "[smoke-test] FAIL"
  echo "  (page-review's own exit code was $REVIEW_EXIT; a FAIL here is about which page tripped FACE_CLIPPED, not that exit code)"
  exit 1
fi
