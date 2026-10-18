#!/usr/bin/env bash
# Smoke-check a ProtocolOS deployment: expected vs actual HTTP status for each check.
#   scripts/smoke_deploy.sh https://<demo-url>        (or DEMO_URL=... scripts/smoke_deploy.sh)
# /api/rationale and /api/draft/presets are required once routes_rationale.py / routes_draft.py exist in this
# checkout, else SKIPPED (not merged). Graph and investigate routes report NOT INSTALLED (not a failure) while the app has no such route.
# Requests that would recompute a review or call a model run only after the guard is shown to be active.
set -u
BASE="${1:-${DEMO_URL:-http://127.0.0.1:8765}}"
BASE="${BASE%/}"
NCT=NCT03409614
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

# check <name> <expected status> <method> <path> [json body file] [grep pattern the body must contain]
check() {
  local name="$1" want="$2" method="$3" path="$4" body="${5:-}" pattern="${6:-}" out code secs verdict
  out="$TMP/out"
  if [ -n "$body" ]; then
    read -r code secs < <(curl -s -o "$out" -w '%{http_code} %{time_total}' --max-time 120 -X "$method" \
      -H 'Content-Type: application/json' --data-binary "@$body" "$BASE$path")
  else
    read -r code secs < <(curl -s -o "$out" -w '%{http_code} %{time_total}' --max-time 120 -X "$method" "$BASE$path")
  fi
  if [ "$code" = "$want" ] && { [ -z "$pattern" ] || grep -q "$pattern" "$out"; }; then
    verdict=PASS
  elif [ "$code" = "404" ] && grep -qx '{"detail":"Not Found"}' "$out" && [ "${OPTIONAL:-0}" = 1 ]; then
    verdict="NOT INSTALLED"
  else
    verdict=FAIL
    fails=$((fails + 1))
  fi
  printf '%-14s %-52s expected %s, got %s (%ss)%s\n' "$verdict" "$name" "$want" "$code" "$secs" \
    "$([ "$verdict" = FAIL ] && [ -n "$pattern" ] && [ "$code" = "$want" ] && echo " body lacks '$pattern'")"
  LAST="$verdict"
}

echo "ProtocolOS smoke check against $BASE"
check "dashboard /" 200 GET "/"
check "static app.js" 200 GET "/static/app.js"
check "GET /api/status" 200 GET "/api/status"
check "GET /api/review/$NCT" 200 GET "/api/review/$NCT" "" '"Review recommended"'
check "GET /api/build" 200 GET "/api/build" "" '"sha"'

# required once the module is merged in this checkout; before that SKIPPED (not merged), never a pass
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
skips=0
if [ -f "$ROOT/trialforge/routes_rationale.py" ]; then
  check "GET /api/rationale/$NCT" 200 GET "/api/rationale/$NCT" "" '"blind_spot"'
else
  echo "SKIPPED (not merged) GET /api/rationale/$NCT"; skips=$((skips + 1))
fi
if [ -f "$ROOT/trialforge/routes_draft.py" ]; then
  check "GET /api/draft/presets" 200 GET "/api/draft/presets" "" '"id"'
else
  echo "SKIPPED (not merged) GET /api/draft/presets"; skips=$((skips + 1))
fi
OPTIONAL=1 check "GET /api/graph/$NCT?criterion_id=hemoglobin" 200 GET "/api/graph/$NCT?criterion_id=hemoglobin" "" '"nodes"'
printf '{"nct":"%s","criterion_id":"hemoglobin","question":"why_flagged","as_of":"auto","mode":"deterministic"}' "$NCT" > "$TMP/inv.json"
OPTIONAL=1 check "POST /api/investigate why_flagged" 200 POST "/api/investigate" "$TMP/inv.json" '"statements"'

# guard: an oversize but otherwise valid what-if body is harmless without the guard (answers 200)
python3 -c "import json,sys;json.dump({'nct':sys.argv[1],'criterion_id':'hemoglobin','value':9,'as_of':'auto','pad':'x'*17000},open(sys.argv[2],'w'))" "$NCT" "$TMP/big.json"
check "guard: body > 16 KB rejected" 400 POST "/api/whatif" "$TMP/big.json"
if [ "$LAST" = PASS ]; then
  check "guard: refresh=1 refused" 403 GET "/api/review/$NCT?refresh=1"
  check "guard: as_of=../../x rejected" 400 GET "/api/review/$NCT?as_of=..%2F..%2Fx"
  printf '{"nct":"%s","criterion_id":"hemoglobin"}' "$NCT" > "$TMP/crit.json"
  check "guard: /api/critique disabled" 503 POST "/api/critique" "$TMP/crit.json" 'disabled on the public demo'
else
  echo "SKIPPED        guard checks for refresh/as_of/critique: guard not active (they would recompute or call a model)"
fi

[ "$skips" -gt 0 ] && echo "note: $skips required check(s) SKIPPED (not merged); a skip is not a pass"
if [ "$fails" -eq 0 ]; then echo "smoke: all checks passed"; else echo "smoke: $fails check(s) failed"; fi
exit $((fails > 0))
