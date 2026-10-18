# ProtocolOS demo and test guide

For judges and reviewers. ProtocolOS checks the rationale behind each eligibility criterion of an
oncology trial (mode A, "Finishing a trial") and drafts criteria for a new trial idea (mode B, "Create
criteria from an idea"). The team decides; ProtocolOS prepares the rationale.

## 1. Where to open it

| What | URL |
|---|---|
| Web app (Next.js) | https://protocolos-web.vercel.app |
| Engine API (FastAPI) | https://protocolos-api-production.up.railway.app |
| Guided tour, mode A | https://protocolos-web.vercel.app/tour |
| Guided tour, mode B | https://protocolos-web.vercel.app/tour/draft |

The public deploy runs with the demo guard on: cached reviews only, no recompute, no model calls.

## 2. Run it locally

From the repository root (Python virtual environment in `.venv`, see [INSTALL.md](INSTALL.md)):

```bash
# terminal 1: engine with the public-demo guard, port 8765
PROTOCOLOS_PUBLIC=1 .venv/bin/uvicorn trialforge.api:app --port 8765

# terminal 2: web app on port 3765, proxying /api/* to the engine
cd web-next && npm ci && PROTOCOLOS_API_URL=http://127.0.0.1:8765 npm run dev -- -p 3765
```

Open http://localhost:3765. Use `localhost`, not `127.0.0.1`: the Next.js dev server blocks its
dev resources for `127.0.0.1`, and the page does not hydrate.

## 3. Mode A: finishing a trial (EMPOWER-Lung 3, hemoglobin)

1. Open the app and pick "Finishing a trial". Choose NCT03409614 (EMPOWER-Lung 3).
2. Click the hemoglobin criterion in the list.
3. Read the Rationale badges (for hemoglobin: Safety, Enrichment: lower variability, Precedent) and the
   arm line. The arm line says which arm (investigational or comparator) drives the safety rationale.
4. Compare tab: earlier comparable trials and the threshold each one used. A looser comparator shows a
   threshold was used, not that it was safe.
5. Ask tab: pick a question ("Why was it flagged?"). Every statement in the answer is checked against
   the sources.
6. Redraft workspace: type a new limit (for example a different g/dL value) and a one-line rationale.
   The checks update as you type: the verifier re-runs and flags any mismatch with precedents or FDA
   guidance.
7. Decide tab: choose a decision and a structured reason (safety concern, regulatory requirement,
   efficacy enrichment, prior trial data, operational reason, other).
8. Export the review packet and open the file.

## 4. Mode B: create criteria from an idea

1. Pick "Create criteria from an idea".
2. Presets: choose "EMPOWER-Lung 3 at design time". The idea is EMPOWER-Lung 3's regimen and setting at
   its design date; only trials that started earlier count, and its own protocol is left out.
3. Read the summary: how many precedents matched and how many criteria were drafted.
4. Open a criterion card: proposed value, the precedents that used it, the verifier checks and
   "Why this value". A criterion with no verified precedent shows "Insufficient evidence" and no value.
5. Self-critique: each card carries a verdict (Review recommended, Rationale supports keeping,
   Insufficient evidence).
6. Before / after: the draft side by side with EMPOWER-Lung 3 as written. Each difference is a review
   question, not a mistake.
7. Download the draft.
8. Free idea: clear the form, type a condition, drugs, setting and phase, and run it. A drug outside the
   vocabulary is reported as unrecognized.

## 5. Guided tours

- `/tour`: seven steps on EMPOWER-Lung 3 hemoglobin (rules, compared, rationale, ask, verify, tested,
  decide).
- `/tour/draft`: six steps on the EMPOWER-Lung 3 design-time preset: the idea, the precedents found
  (with start dates before the cutoff), one drafted criterion card, the criterion the self-critique flags,
  the before / after against the protocol as written, and the guardrails. Every number in the captions is
  computed from the live draft.
- Both tours: Next / Back buttons, left and right arrow keys, and the step in the URL hash (`#1` to
  `#7` in `/tour`, `#1` to `#6` in `/tour/draft`), so a step can be opened directly. "Exit" leads to the full page.

## 6. Automated checks

Run from the repository root unless noted. The engine must run on 8765 and the web app on the port
named in `BASE_URL` for the browser checks. The browser checks need Playwright, for example in a separate
virtual environment:
`python3 -m venv /tmp/pw && /tmp/pw/bin/pip install playwright && /tmp/pw/bin/python -m playwright install chromium`.

| Command | What it proves |
|---|---|
| `.venv/bin/python -m pytest -q tests/` | Engine unit and API tests pass (extraction, review, verifier, draft, guard). |
| `cd web-next && npm run build && npx tsc --noEmit && npm run lint` | The web app builds, type-checks and lints clean. |
| `.venv/bin/python -m evals.draft.run` | Leave-one-out draft eval: for each cached trial, draft from its own idea at its start date with the trial excluded, and compare with the trial's own values. |
| `.venv/bin/python -m scripts.brand_check` | The product reads ProtocolOS wherever a person sees it; prints `unlisted_legacy=<n>` and fails on any unlisted legacy name. |
| `.venv/bin/python -m scripts.check_numbers` | Numbers in the README and docs match the committed eval results. |
| `BASE_URL=http://localhost:3765 /tmp/pw/bin/python scripts/e2e_review_next.py --strict` | Mode A in a real browser, every tab; `--strict` turns any skipped check into a failure. |
| `BASE_URL=http://localhost:3765 /tmp/pw/bin/python scripts/e2e_draft_next.py` | Mode B in a real browser: presets, cards and before / after match the API. |
| `BASE_URL=http://localhost:8765 /tmp/pw/bin/python scripts/e2e_demo.py` | The vanilla dashboard served by FastAPI works end to end. |
| `scripts/smoke_deploy.sh https://protocolos-api-production.up.railway.app` | The deployed API answers each route with the expected status and the public guard is active. |
| `scripts/clean_clone.sh` | A fresh clone installs, caches documents, passes pytest and builds the web app. Pass `"$(pwd)"` to check this checkout. |

## 7. What ProtocolOS does not claim

- No claim that a value is safe, improves enrollment or cost, or is clinically validated.
- Agreement among comparable trials may be template carry-forward.
- No verified precedent means "Insufficient evidence", never a guessed value.
- Rationale in non-public sources (preclinical toxicology, internal data) cannot be seen.
