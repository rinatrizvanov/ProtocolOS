# Installing ProtocolOS

ProtocolOS (formerly TrialLens) is a Python + FastAPI engine with two UIs: the vanilla dashboard in `web/`
(served by FastAPI at `/`) and the Next.js app in `web-next/`. Public data only; no patient data.

## 1. Engine (pip, no uv needed)

Python 3.13 and `poppler-utils` (`pdftotext`) are required.

```bash
python3.13 -m venv .venv
.venv/bin/pip install $(python3 -c "import tomllib;d=tomllib.load(open('pyproject.toml','rb'));print(' '.join(d['project']['dependencies']+d['dependency-groups']['dev']))")
.venv/bin/python -m trialforge.sources NCT03409614 NCT03088540 NCT02578680        # cache public documents
.venv/bin/python -m scripts.prewarm NCT03409614 NCT02578680 NCT03088540 NCT02819518  # cache reviews
```

(uv users: `uv sync` does the same from `pyproject.toml`.)

## 2. Run both UIs

```bash
.venv/bin/uvicorn trialforge.api:app --port 8765                 # engine + vanilla dashboard, http://localhost:8765
PROTOCOLOS_PUBLIC=1 .venv/bin/uvicorn trialforge.api:app --port 8765   # same, with the public-demo guard on
cd web-next && npm ci && npm run dev -- -p 3765                  # Next.js app, http://localhost:3765 (/tour = guided demo)
```

The Next.js app proxies `/api/*` to `PROTOCOLOS_API_URL` (legacy `TRIALLENS_API_URL`; default
`http://127.0.0.1:8765`). Production build: `cd web-next && npm run build && npm start`.

API reference: FastAPI serves interactive docs at `http://localhost:8765/docs` and the schema at `/openapi.json`.
`GET /api/build` returns `{sha, web_next, built_at}` for the running build.

## 3. Tests and checks

```bash
.venv/bin/python -m pytest -q tests/
cd web-next && npm run build && npx tsc --noEmit && npm run lint
scripts/smoke_deploy.sh http://localhost:8765          # or a deployed URL; must print "smoke: all checks passed"
scripts/clean_clone.sh                                  # clone main, fresh venv, pytest, web-next build (logs in /tmp/triallens-logs/v2/clean/)
```

## 4. Docker (one container: engine + vanilla dashboard + poppler)

```bash
docker build -t protocolos .
docker run --rm -p 8765:8765 protocolos                  # PROTOCOLOS_PUBLIC=1 is set in the image
```

The image prewarms the demo trials at build time and again at start for anything missing. `web-next/` is not in the
image (`.dockerignore`); it is deployed separately.

## 5. Hosted deploy

The backend runs on Railway (project `protocolos-api`), the Next.js app on Vercel (project `protocolos-web`), which
proxies `/api/*` to the Railway URL. Exact deploy and redeploy commands: `docs/DEPLOY.md` section 9.

- Railway: `railway up --detach` from the repo root, with `PROTOCOLOS_PUBLIC=1` and `PROTOCOLOS_BUILD_SHA` set on the
  service.
- Vercel: from `web-next/`, set `PROTOCOLOS_API_URL` for production, then `npx -y vercel@latest deploy --prod --yes`.

## 6. Security notes

- `.env` (model and Chalk keys) is gitignored and never shipped: `.railwayignore` and `.dockerignore` exclude `.env`,
  `.env.*`, `.venv/`, `*.pem` and `.chalk.yml`. The public deploys carry no model keys (`CHALK_ROUTER_*`,
  `ANTHROPIC_API_KEY` and `*_ALLOW_MODEL` are unset), so model mode reports "not configured" and every answer comes
  from the deterministic verifier.
- `PROTOCOLOS_PUBLIC=1` turns on the public-demo guard (`trialforge/demo_guard.py`): input validation, a 16 KB body
  limit, no `refresh=1`, `/api/parse` and `/api/critique` disabled, investigations forced to deterministic mode.
- Decisions recorded on the public demo are open to anyone with the URL and ephemeral: they are written inside the
  container (`data/decisions/`) and are lost on a redeploy or restart. Do not enter confidential information.
- Document text (protocol PDFs, web pages) is treated as data, never as instructions.
- Dependency audit: `cd web-next && npm audit --omit=dev` reported `found 0 vulnerabilities` (exit 0) on
  2026-10-18 at 00:29 ET.
