# TrialLens web app (Next.js)

The reviewer-facing app: pick a trial, select an eligibility criterion, and see how it compares with similar trials, why it
was flagged, a checked answer to "why", verification of suggested changes, and the team's decision. `/tour` is the guided
7-step demo of the same live data.

It is a front end only. Every number comes from the TrialLens FastAPI engine in the repository root, which must be running.

```bash
# 1. engine (from the repository root; see the root README for setup)
.venv/bin/uvicorn trialforge.api:app --port 8765

# 2. app (from web-next/)
npm ci
npm run dev -- -p 3765          # http://localhost:3765, guided demo at /tour
```

`/api/*` is proxied to `TRIALLENS_API_URL` (default `http://127.0.0.1:8765`, see `next.config.ts`). Checks before a commit:
`npm run build` (includes the TypeScript check), `npx tsc --noEmit`, `npm run lint`.

Next.js 16 changed APIs and conventions: read `AGENTS.md` in this folder before editing.
