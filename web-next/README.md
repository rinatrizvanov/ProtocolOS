# ProtocolOS web app (Next.js)

The primary user interface of ProtocolOS. Deployed at https://protocolos-web.vercel.app.

| Route | What it shows |
|---|---|
| `/` | Landing page: the two modes and a short "how it works" |
| `/review?nct=&c=&tab=` | Finishing a trial: criteria list and the tabs Rationale, Compare, Ask, Redraft and Decide, with review packet export |
| `/draft?preset=` | Create criteria from an idea: presets, idea form, drafted criterion cards with self-critique, before/after against a protocol as written |
| `/tour` | Guided tour of mode A in seven steps, on live data |
| `/tour/draft` | Guided tour of mode B in six steps, on live data |

It is a front end only: every number comes from the ProtocolOS FastAPI engine in the repository root, which must be
running.

```bash
# 1. engine (from the repository root; setup in docs/INSTALL.md)
.venv/bin/uvicorn trialforge.api:app --port 8765

# 2. app (from web-next/)
npm ci
npm run dev -- -p 3765          # http://localhost:3765
```

Use `localhost`, not `127.0.0.1`, with the dev server: Next.js blocks its dev resources for `127.0.0.1` and the page
does not hydrate.

`/api/*` is rewritten to `PROTOCOLOS_API_URL` (default `http://127.0.0.1:8765`; the legacy `TRIALLENS_API_URL` is
still read), see `next.config.ts`. In a production build the target is fixed at build time, so set it before
`npm run build`. Checks: `npm run build`, `npx tsc --noEmit`, `npm run lint`.

Stack: Next.js 16, React 19, Tailwind CSS 4, TypeScript.
