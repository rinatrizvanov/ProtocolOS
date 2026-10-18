# Deploying ProtocolOS (Railway backend, Vercel frontend)

Backend: one Docker service on Railway: FastAPI + the static dashboard in `web/` + poppler, one worker, the
public-demo guard on. Frontend: the Next.js app in `web-next/` on Vercel, which proxies `/api/*` to the backend.
Files: `Dockerfile`, `.dockerignore`, `.railwayignore`, `railway.toml`, `.env.example`, `trialforge/demo_guard.py`,
`trialforge/web_next.py`, `web-next/vercel.json`, `scripts/`.

Every step that creates, deploys or changes something on Railway or Vercel is **user confirms**: an agent stops and
asks. Status: Railway and Vercel have been live since 2026-10-18; section 9 has the URLs and the exact redeploy
commands.

## 1. What the container does

- Build: installs the dependencies from `pyproject.toml` (the `tomllib` one-liner from AGENTS.md section 8),
  copies the repo, then runs `python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518`.
  The prewarm fetches documents with at most 4 concurrent requests, builds the reviews and then, when
  `trialforge.draft` is present, the authoring-mode draft presets. It always exits 0, so a build without
  network (or with HTTP 403 from ClinicalTrials.gov) still succeeds.
- Start: `python -m scripts.prewarm --if-missing --drafts ...` fills whatever the build could not fetch, then
  `exec python -m trialforge.demo_guard`, which installs the guard when `PROTOCOLOS_PUBLIC=1` and serves
  `trialforge.api:app` with uvicorn on `$PORT` (default 8765), one worker. The guard is therefore on even before
  the `routes_graph` hook in `api.py` exists; with the hook it is installed once (idempotent).
- Health check: `/api/review/NCT03409614` (timeout 600 s in `railway.toml`). The server listens only after the
  startup prewarm, so a passing health check means the EL3 review is cached.

Environment names: ProtocolOS reads `PROTOCOLOS_<NAME>` first, then the legacy `TRIALLENS_<NAME>` (`trialforge/settings.py`).

## 2. Public-demo guard (`PROTOCOLOS_PUBLIC=1`)

| Request | Answer |
|---|---|
| NCT in the path or body `nct` not `NCT` + 8 digits | 400 |
| `as_of` not `auto`, `none` or `YYYY-MM-DD` | 400 |
| decision `criterion_id` not a criterion of the review; `reason` over 1000 characters; body over 16 KB | 400 |
| `refresh` truthy | 403 |
| `/api/parse`, `/api/critique` | 503 "disabled on the public demo" |
| `/api/verify` | `with_llm_baseline` forced to false |
| `/api/investigate` | `mode` forced to `deterministic` |
| a review that is not cached yet | computed one at a time |

The model rules lift only with `PROTOCOLOS_ALLOW_MODEL=1`; set it only together with a budgeted router key.

## 3. Variables (names only; values never committed)

Set on the Railway service (user confirms). `PORT` is injected by Railway.

| Name | Value on the public deploy |
|---|---|
| `PROTOCOLOS_PUBLIC` | `1` (also set in the Dockerfile) |
| `PROTOCOLOS_ALLOW_MODEL` | unset |
| `CHALK_ROUTER_API_KEY` | only if the key has a budget; otherwise unset (no model on the public app) |
| `CHALK_ROUTER_ENV_ID` | `trll59fe560c` (set explicitly: the code default `clkdcdaf84e` belongs to another team) |
| `CHALK_ROUTER_MODEL` | set explicitly when a router key is set (the code default is `openai/gpt-6.1-sol`) |
| `ANTHROPIC_API_KEY` | unset on the public app |
| `CHALK_CLIENT_ID`, `CHALK_CLIENT_SECRET`, `CHALK_ENVIRONMENT`, `CHALK_API_SERVER` | a scoped client credential for the registry profile chip, if the user creates one; without it the chip says "unavailable" |

`.env.example` lists the same names for local runs (`cp .env.example .env`, gitignored).

## 4. Before a deploy (local, from the repo root)

```bash
.venv/bin/python -m pytest -q tests/
.venv/bin/python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518
.venv/bin/python -m scripts.check_numbers            # offenders are change requests for the doc owner
.venv/bin/uvicorn trialforge.api:app --port 8765 &
BASE_URL=http://localhost:8765 /tmp/pw/bin/python scripts/e2e_demo.py
scripts/smoke_deploy.sh http://localhost:8765
```

Secrets scan (plan.md 5.8) before the repo goes public. Report only redacted findings.

```bash
git log -p --all | grep -nE 'ck-[A-Za-z0-9]{6,}|sk-ant-|CLIENT_SECRET=|CHALK_ROUTER_API_KEY=.'
git ls-files | grep -E '(^|/)\.env$|\.pem$|\.chalk\.yml'
```

The second command must print nothing. The first is broad and, on `ws/deploy` at 2026-10-17 17:40 ET, matched
only non-secrets: the word "back-tested" (`ck-` pattern), placeholder text `CHALK_ROUTER_API_KEY=...` in the
docs, this file's own copy of the pattern, and the empty `CHALK_CLIENT_SECRET=` in `.env.example`. Read every
hit; a hit with an actual value after `=`, or `ck-`/`sk-ant-` followed by a key, blocks going public.

## 5. Railway steps (user confirms each)

1. Pick the account/workspace and spend limit (plan.md section 10 question).
2. Create a project and one service from the GitHub repo (or `railway up` from a local checkout; see 7).
   Railway reads `railway.toml`: Dockerfile builder, health check path and timeout, restart on failure,
   one replica (`[deploy.multiRegionConfig.us-east4-eqdc4a] numReplicas = 1`).
   Railway's docs (checked 2026-10-17) call config as code deprecated but supported for existing services
   until 2026-12-01; after the first deploy, confirm in the dashboard that builder, health check path and
   replicas match, and set them there if not.
3. Set the variables of section 3.
4. Deploy; wait for the health check to pass.
5. `scripts/smoke_deploy.sh https://<demo-url>` and `BASE_URL=https://<demo-url> /tmp/pw/bin/python scripts/e2e_demo.py`
   (step 9 checks that `refresh=1` is refused on the deployed URL).
6. Put the URL in the README and Devpost (collaborator).

## 6. Decisions and audit log on Railway

Decisions are written to `data/decisions/` and investigation audit lines to `data/investigations/` inside the
container, so a redeploy or restart loses them. Optional (plan item 13): attach a Railway volume mounted at
`/app/data/decisions` so recorded decisions survive restarts. Do not mount a volume at `/app/data`: it would
hide the prewarmed caches baked into the image. The audit log then stays per-deployment; say so if asked.

## 7. Shipping the caches (the build does not depend on ClinicalTrials.gov)

`railway up` honours `.gitignore` by default, and `.gitignore` excludes the document caches (`data/protocols/`,
`data/registry/`, `data/fda/`, `data/nhanes/`, `data/search_cache/`), the reviews (`data/reviews/`) and the drafts
(`data/drafts/`). The live deploys therefore use `railway up --no-gitignore` from a checkout whose `data/` holds real
directories (not symlinks, which a worktree may have) filled by the prewarm. The build-time prewarm then finds every
review and draft preset cached, and the health check passes without network access. With `--no-gitignore`,
`.railwayignore` is the only filter: it keeps `.env`, `.env.*`, `*.pem`, `.chalk.yml`, `.venv/`, `.git/`, `web-next/`,
`data/decisions/`, `data/investigations/` and the generated Chalk eval bundles out of the upload. It must not exclude
`data/reviews/` or `data/drafts/`. Sponsor PDFs stay out of git either way. If a checkout has no caches, plain
`railway up` still works: the build and startup prewarms fetch from the network, with retries.

## 8. Rollback

- Railway keeps earlier deployments: redeploy the last good one from the service's Deployments list (user confirms).
- Or revert the commit on the deployed branch and let Railway rebuild (user confirms the push).
- If no deployment serves EL3 by 01:30 ET (plan.md section 10): submit with the repo and the video, demo from
  localhost, and say in Devpost that no demo URL is live.
- After any rollback: `scripts/smoke_deploy.sh https://<demo-url>`.

## 9. Live deploys and redeploy commands (2026-10-18)

- Backend: Railway project `protocolos-api`, service `protocolos-api`, environment `production`,
  https://protocolos-api-production.up.railway.app (variables `PROTOCOLOS_PUBLIC=1` and `PROTOCOLOS_BUILD_SHA`; no
  model keys).
- Frontend: Vercel project `protocolos-web`, root `web-next/`, https://protocolos-web.vercel.app (production variable
  `PROTOCOLOS_API_URL` = the Railway URL; `/api/*` goes through the `next.config.ts` rewrite).

Redeploy integrated `main` (user confirms each deploy) from the root of the main checkout, with a clean tree on
`main`. The link commands are non-interactive and are needed once per checkout.

```bash
API=https://protocolos-api-production.up.railway.app
WEB=https://protocolos-web.vercel.app

# Railway
railway link --project protocolos-api --service protocolos-api --environment production
.venv/bin/python -m scripts.prewarm --drafts          # data/reviews/ and data/drafts/ warm (gitignored; shipped below)
railway variable set PROTOCOLOS_BUILD_SHA=$(git rev-parse HEAD) --skip-deploys   # no deploy of the old upload
railway up --ci --no-gitignore                         # streams the build log, then exits; .railwayignore keeps secrets out
for i in $(seq 1 60); do curl -fsS $API/api/build | grep -q "$(git rev-parse HEAD)" && break; sleep 10; done
curl -s $API/api/build                                 # sha must equal git rev-parse main
railway deployment list                                # newest deployment SUCCESS (FAILED: see the build log)
scripts/smoke_deploy.sh $API                           # run from this checkout: merged modules make their checks required

# Vercel
cd web-next
npx -y vercel@latest link --yes --project protocolos-web
npx -y vercel@latest env ls production | grep -q PROTOCOLOS_API_URL \
  || printf '%s' $API | npx -y vercel@latest env add PROTOCOLOS_API_URL production
npx -y vercel@latest deploy --prod --yes
curl -s $WEB/ | grep -c ProtocolOS                     # at least 1
curl -s -o /dev/null -w '%{http_code}\n' $WEB/api/review/NCT03409614   # 200 through the rewrite
```

The wait loop polls for up to 10 minutes, the `railway.toml` health-check timeout. Until the new deployment passes its
health check, Railway keeps serving the previous one, so `/api/build` still shows the old SHA. Setting the variable
with `--skip-deploys` matters: without it, Railway redeploys the previous upload with the new SHA, and `/api/build`
would then report `main` while old code serves. Do not use `railway logs` to wait: it streams without end and shows the
most recent *successful* deployment, not the one being checked.

`vercel link` writes `web-next/.vercel/` (the project link) and `web-next/.env.local` (a short-lived
`VERCEL_OIDC_TOKEN`). Both are gitignored, and the Vercel CLI does not upload `.vercel` or `.env.local` (its default
ignore list). The production variable is stored on the Vercel project, so a new checkout does not need to set it again.
