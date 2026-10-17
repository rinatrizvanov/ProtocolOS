# Deploying TrialLens (Railway, one container)

One Docker service: FastAPI + the static dashboard in `web/` + poppler, one worker, the public-demo guard on.
Files: `Dockerfile`, `.dockerignore`, `railway.toml`, `.env.example`, `trialforge/demo_guard.py`, `scripts/`.

Every step that creates, deploys or changes something on Railway is **user confirms**: an agent stops and asks.
Status when this was written (2026-10-17): the image has **not** been built (Docker is not installed on the
development Mac) and nothing has been deployed.

## 1. What the container does

- Build: installs the dependencies from `pyproject.toml` (the `tomllib` one-liner from AGENTS.md section 8),
  copies the repo, then runs `python -m scripts.prewarm NCT03409614 NCT02578680 NCT03088540 NCT02819518`.
  The prewarm fetches documents with at most 4 concurrent requests and always exits 0, so a build without
  network (or with HTTP 403 from ClinicalTrials.gov) still succeeds.
- Start: `python -m scripts.prewarm --if-missing ...` fills whatever the build could not fetch, then
  `exec python -m trialforge.demo_guard`, which installs the guard when `TRIALLENS_PUBLIC=1` and serves
  `trialforge.api:app` with uvicorn on `$PORT` (default 8765), one worker. The guard is therefore on even before
  the `routes_graph` hook in `api.py` exists; with the hook it is installed once (idempotent).
- Health check: `/api/review/NCT03409614` (timeout 600 s in `railway.toml`). The server listens only after the
  startup prewarm, so a passing health check means the EL3 review is cached.

## 2. Public-demo guard (`TRIALLENS_PUBLIC=1`)

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

The model rules lift only with `TRIALLENS_ALLOW_MODEL=1`; set it only together with a budgeted router key.

## 3. Variables (names only; values never committed)

Set on the Railway service (user confirms). `PORT` is injected by Railway.

| Name | Value on the public deploy |
|---|---|
| `TRIALLENS_PUBLIC` | `1` (also set in the Dockerfile) |
| `TRIALLENS_ALLOW_MODEL` | unset |
| `CHALK_ROUTER_API_KEY` | only if the key has a budget; otherwise unset (no model on the public app) |
| `CHALK_ROUTER_ENV_ID` | `trll59fe560c` (set explicitly: the code default `clkdcdaf84e` belongs to another team) |
| `CHALK_ROUTER_MODEL` | set explicitly when a router key is set (the code default is `openai/gpt-6.1-sol`) |
| `ANTHROPIC_API_KEY` | unset on the public app |
| `CHALK_CLIENT_ID`, `CHALK_CLIENT_SECRET`, `CHALK_ENVIRONMENT`, `CHALK_API_SERVER` | a scoped client credential for the registry profile chip, if the user creates one; without it the chip says "unavailable" |

`.env.example` lists the same names for local runs (`cp .env.example .env`, gitignored).

## 4. Before a deploy (local, from the repo root)

```bash
.venv/bin/python -m pytest -q tests/
.venv/bin/python -m scripts.prewarm NCT03409614 NCT02578680 NCT03088540 NCT02819518
.venv/bin/python -m scripts.check_numbers            # offenders are change requests for the doc owner
.venv/bin/uvicorn trialforge.api:app --port 8765 &
BASE_URL=http://localhost:8765 /tmp/pw/bin/python scripts/e2e_demo.py
scripts/smoke_deploy.sh http://localhost:8765
```

Secrets scan (plan.md 5.8) before the repo goes public; both commands must print nothing. Report only
redacted findings.

```bash
git log -p --all | grep -nE 'ck-[A-Za-z0-9]{6,}|sk-ant-|CLIENT_SECRET=|CHALK_ROUTER_API_KEY=.'
git ls-files | grep -E '(^|/)\.env$|\.pem$|\.chalk\.yml'
```

`.env.example` contains `CHALK_ROUTER_API_KEY=` and `CHALK_CLIENT_SECRET=` with empty values, which the first
pattern does not match (`CHALK_ROUTER_API_KEY=.` needs a character after `=`; `CLIENT_SECRET=` does match).
Expect that one hit from `.env.example` and check that it has no value.

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

## 7. If the build cannot reach ClinicalTrials.gov

The startup prewarm retries at container start. If that also fails (the health check never passes), build from a
local checkout whose `data/` caches are filled (`railway up` uploads the build context). Whether `railway up`
honours `.gitignore` (which excludes `data/protocols/` and the other caches) is not verified; check the build
log for `prewarm: documents done` with cached trials before relying on it. Sponsor PDFs stay out of git either way.

## 8. Rollback

- Railway keeps earlier deployments: redeploy the last good one from the service's Deployments list (user confirms).
- Or revert the commit on the deployed branch and let Railway rebuild (user confirms the push).
- If no deployment serves EL3 by 01:30 ET (plan.md section 10): submit with the repo and the video, demo from
  localhost, and say in Devpost that no demo URL is live.
- After any rollback: `scripts/smoke_deploy.sh https://<demo-url>`.
