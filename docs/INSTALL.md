# Installing ProtocolOS

ProtocolOS is a Python + FastAPI engine with two UIs: the vanilla dashboard in `web/`
(served by FastAPI at `/`) and the Next.js app in `web-next/`. Public data only; no patient data.

## 1. Engine (pip, no uv needed)

Prerequisites: git; Python 3.12 or newer (tested on 3.13); Node.js 20.9 or newer with npm (Next.js 16's minimum; tested
on 22.19) for the Next.js app; preferably poppler (`pdftotext`, used for protocol text when present): `poppler-utils` on
Debian/Ubuntu, `brew install poppler` on macOS.

```bash
git clone https://github.com/rinatrizvanov/ProtocolOS.git && cd ProtocolOS
python3 -m venv .venv                                                              # Python 3.12+, e.g. python3.13
.venv/bin/pip install $(.venv/bin/python -c "import tomllib;d=tomllib.load(open('pyproject.toml','rb'));print(' '.join(d['project']['dependencies']+d['dependency-groups']['dev']))")
.venv/bin/python -m trialforge.sources NCT03409614 NCT03088540 NCT02578680        # optional: prewarm also fetches them
.venv/bin/python -m scripts.prewarm --drafts NCT03409614 NCT02578680 NCT03088540 NCT02819518  # cache reviews and draft presets
```

(uv users: `uv sync` does the same from `pyproject.toml`.) Model mode uses the visitor's own key, entered in the web
app. For local runs you may instead set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (names in `.env.example`); without a
key model mode says "not configured".

## 2. Run both UIs

Two long-running processes, each in its own terminal:

```bash
# terminal 1: the engine + vanilla dashboard on http://localhost:8765; pick one
.venv/bin/uvicorn trialforge.api:app --port 8765
PROTOCOLOS_PUBLIC=1 .venv/bin/uvicorn trialforge.api:app --port 8765    # with the public-demo guard, as deployed

# terminal 2: the Next.js app on http://localhost:3765 (/review, /draft, /tour = guided demo)
cd web-next && npm ci && npm run dev -- -p 3765
```

The Next.js app proxies `/api/*` to `PROTOCOLOS_API_URL` (legacy `TRIALLENS_API_URL`; default `http://127.0.0.1:8765`);
for an engine on another port: `PROTOCOLOS_API_URL=http://127.0.0.1:<port> npm run dev -- -p 3765`. In a production
build the proxy target is fixed when the app is built, so set it before building:
`cd web-next && PROTOCOLOS_API_URL=http://127.0.0.1:8765 npm run build && npm start`. Run `/tour` against the guarded
engine: its last step (7, Tested) probes the guard live.

API reference: FastAPI serves interactive docs at `http://localhost:8765/docs` and the schema at `/openapi.json`.
`GET /api/build` returns `{sha, web_next, built_at}` for the running build (`sha` is "unknown" unless `PROTOCOLOS_BUILD_SHA` is set).

## 3. Tests and checks

```bash
.venv/bin/python -m pytest -q tests/
(cd web-next && npm run build && npx tsc --noEmit && npm run lint)
.venv/bin/python -m evals.draft.run                     # draft guardrail eval: 0 drafted without a verified precedent
scripts/smoke_deploy.sh http://localhost:8765          # against a PROTOCOLOS_PUBLIC=1 engine or a deployed URL
scripts/clean_clone.sh "$(pwd)"                         # fresh clone of this checkout: venv, pytest, web-next build
```

`smoke_deploy.sh` checks the public-demo guard too, so run it against a guarded engine; it must print
`smoke: all checks passed`. `clean_clone.sh` without an argument clones GitHub main instead; it prints where its
logs go, and the clone is deleted afterwards (`KEEP=1` keeps it).

## 4. Docker (one container: engine + vanilla dashboard + poppler)

```bash
docker build -t protocolos .
docker run --rm -p 8765:8765 protocolos                  # PROTOCOLOS_PUBLIC=1 is set in the image
```

The image prewarms the demo trials at build time and again at start for anything missing. `web-next/` is not in the
image (`.dockerignore`); it is deployed separately.

## 5. Hosted deploy

The backend runs on Railway (project `protocolos-api`), the Next.js app on Vercel (project `protocolos-web`), which
proxies `/api/*` to the Railway URL. Exact commands: [DEPLOY.md](DEPLOY.md).

- Railway: `railway up --ci --no-gitignore` from a slim staging copy (the committed tree plus the warm `data/` caches
  the demo reads; `.railwayignore` keeps secrets out), with `PROTOCOLOS_PUBLIC=1` and `PROTOCOLOS_BUILD_SHA` set on
  the service.
- Vercel: from `web-next/`, set `PROTOCOLOS_API_URL` for production, then `npx -y vercel@latest deploy --prod --yes`.

## 6. Security notes

- `.env` (local model keys) is gitignored and never shipped: `.railwayignore` and `.dockerignore` exclude `.env`,
  `.env.*`, `.venv/`, `*.pem` and `.chalk.yml`. With `PROTOCOLOS_PUBLIC=1` the server ignores environment model keys
  altogether: model answers, new trials and new draft ideas use the visitor's own key, sent per request and never
  stored (`trialforge/llm.py`, `trialforge/access.py`). The deterministic verifier stays the authority on suggested
  changes.
- `PROTOCOLOS_PUBLIC=1` turns on the public-demo guard (`trialforge/demo_guard.py`): input validation, a 16 KB body
  limit, no `refresh=1`, the visitor's key for new work and model calls, and limits on new analyses.
- Decisions recorded on the public demo are stored per browser session in the state directory
  (`PROTOCOLOS_STATE_DIR`, a volume on the public deploy; without it `data/` inside the container, lost on a
  redeploy). Trials a visitor adds are kept there too and can be opened by anyone with the link. Do not enter
  confidential information.
- Document text (protocol PDFs, web pages) is treated as data, never as instructions.
- Dependency audit: `cd web-next && npm audit --omit=dev` reported `found 0 vulnerabilities` (exit 0) on
  2026-10-18. `npm ci` itself reports high-severity advisories; they are in development-only dependencies
  (the build toolchain), which the deployed app does not ship.
