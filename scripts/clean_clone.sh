#!/usr/bin/env bash
# Clean-clone check for ProtocolOS: clone, fresh venv (pip, no uv), cache documents, pytest, web-next npm ci + build.
#   scripts/clean_clone.sh [source repo or URL] [branch]
# Defaults: the GitHub repository, branch main (pass "$(pwd)" to check this checkout instead). Logs go to
# /tmp/triallens-logs/v2/clean/. The clone (about 1 GB with venv and node_modules) is deleted at the end unless
# KEEP=1. PYTHON picks the interpreter (default: python3.13, else python3).
# Exits non-zero on the first failing step.
set -euo pipefail
SRC="${1:-https://github.com/rinatrizvanov/ProtocolOS.git}"
BRANCH="${2:-main}"
PY="${PYTHON:-$(command -v python3.13 || command -v python3)}"
LOGS=/tmp/triallens-logs/v2/clean
mkdir -p "$LOGS"
WORK="$(mktemp -d /tmp/protocolos-clean.XXXXXX)"
[ "${KEEP:-0}" = "1" ] || trap 'rm -rf "$WORK"' EXIT
echo "clean clone of $SRC ($BRANCH) into $WORK; logs in $LOGS"

step() { echo "== $1"; }

step "git clone"
git clone --quiet --branch "$BRANCH" "$SRC" "$WORK/repo" > "$LOGS/clone.txt" 2>&1
cd "$WORK/repo"
git rev-parse HEAD | tee -a "$LOGS/clone.txt"

step "python venv + pip install (pyproject dependencies + dev group)"
"$PY" -m venv .venv
DEPS="$(.venv/bin/python -c "import tomllib;d=tomllib.load(open('pyproject.toml','rb'));print(' '.join(d['project']['dependencies']+d['dependency-groups']['dev']))")"
# shellcheck disable=SC2086
.venv/bin/pip install -q $DEPS > "$LOGS/pip.txt" 2>&1

step "cache documents"
.venv/bin/python -m trialforge.sources NCT03409614 NCT03088540 NCT02578680 > "$LOGS/sources.txt" 2>&1

step "prewarm reviews (auto and none) and draft presets, as docs/INSTALL.md does"
.venv/bin/python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518 > "$LOGS/prewarm.txt" 2>&1

step "pytest"
.venv/bin/python -m pytest -q tests/ > "$LOGS/pytest-full.txt" 2>&1 || { tail -n 30 "$LOGS/pytest-full.txt"; exit 1; }
tail -n 1 "$LOGS/pytest-full.txt" | tee "$LOGS/pytest.txt"

step "web-next npm ci + build"
( cd web-next && npm ci && npm run build ) > "$LOGS/web-next-build.txt" 2>&1 || { tail -n 30 "$LOGS/web-next-build.txt"; exit 1; }
tail -n 5 "$LOGS/web-next-build.txt"

echo "clean clone: all steps passed ($WORK/repo$([ "${KEEP:-0}" = "1" ] || echo ", deleted"))"
