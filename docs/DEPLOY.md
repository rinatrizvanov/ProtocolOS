# Deploying ProtocolOS (Railway backend, Vercel frontend)

An operator guide for the hosted demo.

- **Backend:** one Docker service on Railway running FastAPI, the vanilla dashboard in `web/` and poppler, with one
  worker and the public-demo guard on.
- **Frontend:** the Next.js app in `web-next/` on Vercel, which proxies `/api/*` to the backend.

Relevant files: `Dockerfile`, `.dockerignore`, `.railwayignore`, `railway.toml`, `.env.example`,
`trialforge/demo_guard.py`, `trialforge/web_next.py`, `web-next/next.config.ts`, `web-next/vercel.json`, `scripts/`.

Current deployments:

| | Project | URL |
|---|---|---|
| Backend | Railway project `protocolos-api`, service `protocolos-api`, environment `production` | https://protocolos-api-production.up.railway.app |
| Frontend | Vercel project `protocolos-web`, root directory `web-next/` | https://protocolos-web.vercel.app |

## 1. What the container does

- **Build:** installs the dependencies listed in `pyproject.toml` (the same `tomllib` one-liner as in
  [INSTALL.md](INSTALL.md)), copies the repository, then runs
  `python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518`. The prewarm fetches
  documents with at most 4 concurrent requests, builds the reviews and then the authoring-mode draft presets. It
  always exits 0, so a build without network access (or with HTTP 403 from ClinicalTrials.gov) still succeeds.
- **Start:** `python -m scripts.prewarm --if-missing --drafts ...` fills whatever the build could not fetch, then
  `exec python -m trialforge.demo_guard` serves `trialforge.api:app` with uvicorn on `$PORT` (default 8765), one
  worker, with the guard installed when `PROTOCOLOS_PUBLIC=1`.
- **Health check:** `/api/review/NCT03409614` with a 600-second timeout (`railway.toml`). The server listens only
  after the startup prewarm, so a passing health check means the EMPOWER-Lung 3 review is cached.

ProtocolOS reads `PROTOCOLOS_<NAME>` settings first, then the legacy `TRIALLENS_<NAME>` names
(`trialforge/settings.py`).

## 2. Public-demo guard (`PROTOCOLOS_PUBLIC=1`)

| Request | Answer |
|---|---|
| NCT in the path or body `nct` that is not `NCT` + 8 digits | 400 |
| `as_of` not `auto`, `none` or `YYYY-MM-DD` | 400 |
| decision `criterion_id` not a criterion of the review; `reason` over 1000 characters; body over 16 KB | 400 |
| `refresh` truthy | 403 |
| `/api/parse`, `/api/critique` | 503 "disabled on the public demo" |
| `/api/verify` | `with_llm_baseline` forced to false |
| `/api/investigate` | `mode` forced to `deterministic` |
| a review that is not cached yet | computed one at a time |

The model restrictions lift only with `PROTOCOLOS_ALLOW_MODEL=1`; set it only together with a router key that
has a spending budget.

## 3. Variables (names only; never commit values)

`PORT` is injected by Railway.

| Name | Value on the public deploy |
|---|---|
| `PROTOCOLOS_PUBLIC` | `1` (also set in the Dockerfile) |
| `PROTOCOLOS_BUILD_SHA` | the git SHA being deployed; `GET /api/build` reports it |
| `PROTOCOLOS_ALLOW_MODEL` | unset |
| `CHALK_ROUTER_API_KEY` | unset, unless the key has a spending budget |
| `CHALK_ROUTER_ENV_ID` | the Chalk environment of the router key, set explicitly (the code default belongs to another environment) |
| `CHALK_ROUTER_MODEL` | set explicitly whenever a router key is set |
| `ANTHROPIC_API_KEY` | unset |
| `CHALK_CLIENT_ID`, `CHALK_CLIENT_SECRET`, `CHALK_ENVIRONMENT`, `CHALK_API_SERVER` | a scoped client credential for the registry profile chip, optional; without it the chip says "unavailable" |

`.env.example` lists the same names for local runs (`cp .env.example .env`; `.env` is gitignored). The Vercel
project needs one production variable: `PROTOCOLOS_API_URL`, the backend URL.

## 4. Before a deploy

From the repository root:

```bash
.venv/bin/python -m pytest -q tests/
.venv/bin/python -m scripts.check_numbers
.venv/bin/python -m scripts.prewarm --drafts            # data/reviews/ and data/drafts/ warm
.venv/bin/uvicorn trialforge.api:app --port 8765 &
BASE_URL=http://localhost:8765 /tmp/pw/bin/python scripts/e2e_demo.py   # Playwright venv: see DEMO_GUIDE.md
PROTOCOLOS_PUBLIC=1 .venv/bin/uvicorn trialforge.api:app --port 8766 &
scripts/smoke_deploy.sh http://localhost:8766           # the smoke test expects the guard to be on
```

`e2e_demo.py` records a test decision for hemoglobin. Against a local server it backs up
`data/decisions/NCT03409614.json` first and restores it afterwards; run it from the checkout the server runs from,
or set `E2E_DECISIONS_DIR` to that server's `data/decisions`.

Secrets scan before publishing the repository or a deploy. Report only redacted findings.

```bash
git log -p --all | grep -nE 'ck-[A-Za-z0-9]{6,}|sk-ant-|CLIENT_SECRET=|CHALK_ROUTER_API_KEY=.'
git ls-files | grep -E '(^|/)\.env$|\.pem$|\.chalk\.yml'
```

The second command must print nothing. The first is deliberately broad: it also matches words such as
"back-tested", placeholder text such as `CHALK_ROUTER_API_KEY=...` in the docs, this file's copy of the pattern and
the empty `CHALK_CLIENT_SECRET=` in `.env.example`. Read every hit; a hit with an actual value after `=`, or `ck-` or
`sk-ant-` followed by a key, must be removed before going public.

## 5. Backend on Railway

### Why a slim staging copy

`.gitignore` excludes the document caches (`data/protocols/`, `data/registry/`, `data/fda/`, `data/nhanes/`,
`data/search_cache/`), the reviews (`data/reviews/`) and the drafts (`data/drafts/`). The deploy ships them anyway
with `railway up --no-gitignore`, so the build-time prewarm finds every review and draft preset cached and the
health check passes without network access. `.railwayignore` is then the only filter: it keeps `.env`, `.env.*`,
`*.pem`, `.chalk.yml`, `.venv/`, `.git/`, `web-next/`, `data/decisions/`, `data/investigations/` and the
generated Chalk eval bundles out of the upload. It must not exclude `data/reviews/` or `data/drafts/`.

A full checkout's `data/protocols/` holds hundreds of MB of protocol PDFs, and Railway rejects an upload that large
(HTTP 413). Deploy from a slim staging copy instead: the committed tree (`git archive HEAD`) plus only the caches
the deployed reviews and draft presets read. Run this in bash from the root of a checkout whose `data/` caches are
warm (real directories or symlinks; `cp -L` copies their contents):

```bash
SHA=$(git rev-parse HEAD)
STAGE=/tmp/protocolos-deploy
rm -rf "$STAGE" && mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"
mkdir -p "$STAGE/data/drafts" "$STAGE/data/protocols"
cp -RL data/reviews data/fda data/nhanes data/registry data/search_cache "$STAGE/data/"
IDS=$(.venv/bin/python -c "from trialforge import draft; print(' '.join(draft.draft_id_for(p['idea'], p.get('exclude') or ()) for p in draft.PRESETS.values()))")
for id in $IDS; do cp -L "data/drafts/$id.json" "$STAGE/data/drafts/"; done
for n in $(cat data/reviews/*.json "$STAGE"/data/drafts/*.json | grep -oE 'NCT[0-9]{8}' | sort -u); do
  cp -L data/protocols/"$n"__* "$STAGE/data/protocols/" 2>/dev/null || true
done
du -sh "$STAGE"                                         # tens of MB, not hundreds
```

If no caches are available at all, a plain `railway up` from a checkout still works: the build and startup
prewarms fetch from the network, with retries.

### Deploy

```bash
API=https://protocolos-api-production.up.railway.app
cd "$STAGE"
railway link --project protocolos-api --service protocolos-api --environment production   # once per directory
railway variable set PROTOCOLOS_BUILD_SHA=$SHA --skip-deploys   # no redeploy of the previous upload
railway up --ci --no-gitignore                          # streams the build log, then exits
for i in $(seq 1 60); do curl -fsS $API/api/build | grep -q "$SHA" && break; sleep 10; done
curl -s $API/api/build                                  # sha must equal $SHA
railway deployment list                                 # newest deployment SUCCESS (FAILED: read the build log)
scripts/smoke_deploy.sh $API                            # the staging copy has scripts/ too
```

The wait loop polls for up to 10 minutes, the health-check timeout. Until the new deployment passes its health
check, Railway keeps serving the previous one, so `/api/build` still shows the old SHA. `--skip-deploys` matters:
without it, Railway redeploys the previous upload with the new SHA, and `/api/build` would report the new commit
while old code serves. Do not use `railway logs` to wait: it streams without end and shows the most recent
*successful* deployment, not the one being checked.

First deployment of a new project: create the project and service with `railway up` from the staging copy, set the
variables of section 3, and confirm in the Railway dashboard that the builder (Dockerfile), health-check path and
timeout, restart policy and replica count match `railway.toml`.

## 6. Frontend on Vercel

```bash
API=https://protocolos-api-production.up.railway.app
WEB=https://protocolos-web.vercel.app
cd web-next
npx -y vercel@latest link --yes --project protocolos-web
npx -y vercel@latest env ls production | grep -q PROTOCOLOS_API_URL \
  || printf '%s' $API | npx -y vercel@latest env add PROTOCOLOS_API_URL production
npx -y vercel@latest deploy --prod --yes
curl -s $WEB/ | grep -c ProtocolOS                      # at least 1
curl -s -o /dev/null -w '%{http_code}\n' $WEB/api/review/NCT03409614   # 200 through the rewrite
```

The rewrite target is fixed when the app is built, so set `PROTOCOLOS_API_URL` before deploying. `vercel link`
writes `web-next/.vercel/` and `web-next/.env.local` (a short-lived OIDC token); both are gitignored and the
Vercel CLI does not upload them. The production variable is stored on the Vercel project, so a new checkout does
not need to set it again.

## 7. Verify a deployment

```bash
scripts/smoke_deploy.sh https://protocolos-api-production.up.railway.app
BASE_URL=https://protocolos-api-production.up.railway.app /tmp/pw/bin/python scripts/e2e_demo.py
BASE_URL=https://protocolos-web.vercel.app /tmp/pw/bin/python scripts/e2e_review_next.py
BASE_URL=https://protocolos-web.vercel.app /tmp/pw/bin/python scripts/e2e_draft_next.py
```

Against a deployed URL, `e2e_demo.py` and `e2e_review_next.py` skip their decision step and leave no test decision
behind (so do not pass `--strict`, which turns a skip into a failure); `e2e_demo.py` also checks that `refresh=1` is
refused. `--write-decision` records a decision, which then stays on the server until a redeploy.

## 8. Decisions and audit log

Decisions are written to `data/decisions/` and investigation audit lines to `data/investigations/` inside the
container, so a redeploy or restart loses them. To keep decisions across restarts, attach a Railway volume mounted
at `/app/data/decisions`. Do not mount a volume at `/app/data`: it would hide the prewarmed caches baked into the
image.

## 9. Rollback

- Railway keeps earlier deployments: redeploy the last good one from the service's Deployments list.
- Or check out the last good commit, rebuild the staging copy and deploy it as in section 5.
- Vercel: promote the previous production deployment in the project's Deployments list.
- After any rollback: `scripts/smoke_deploy.sh https://protocolos-api-production.up.railway.app`.
