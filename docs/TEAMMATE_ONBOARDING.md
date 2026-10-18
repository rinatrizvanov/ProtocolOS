# ProtocolOS: teammate onboarding

ProtocolOS (formerly TrialLens).

A 10–15 minute technical read. Everything below describes code that exists in this repository today. Where something has not run, this document says so.

Your task (the provenance graph and evidence-investigation agent) is specified in [EVIDENCE_AGENT_PLAN.md](EVIDENCE_AGENT_PLAN.md). Read this document first.

---

## A. Project overview

### The problem

Eligibility criteria (lab thresholds, ECOG limits, washout periods) decide who may join a trial. They are often carried forward from earlier protocols. FDA's July 2026 oncology guidances ask sponsors to make them "only as restrictive as necessary". Restrictions also exist for real reasons:
- safety
- enrichment
- lower heterogeneity
- interpretability

The useful question is therefore narrow: **which restrictions deserve reconsideration, and what evidence supports or contradicts each one?** That evidence is scattered across:
- the protocol PDF (often 150+ pages)
- other sponsors' protocol PDFs
- FDA guidance text

### Users and workflow

The users are clinical scientists, protocol authors, medical reviewers and protocol-review teams, working **before protocol finalization**.

1. Enter an NCT ID.
2. ProtocolOS reads the posted protocol, extracts criteria and assembles evidence per criterion.
3. A reviewer inspects the evidence and challenges any conclusion; the deterministic verifier checks the challenge.
4. The team exports a review packet and records a decision per criterion: accept, reject, needs medical review, or defer.

ProtocolOS prepares the evidence. **The team decides.**

### What the application does today

- **Ingest.** Fetches the ClinicalTrials.gov record and the posted protocol PDF, and caches both.
- **Extract.** Pulls out hemoglobin, ANC, platelets, bilirubin, AST/ALT, renal function, ECOG and washouts, each with the verbatim source line and page.
- **Regimen.** Identifies the drugs in every arm, each traced to its source. Agents missing from the curated drug table are listed, never assumed harmless.
- **Comparators.** Finds comparable phase 3 trials that started before the reviewed trial, parses their PDFs, and diffs thresholds with regimen coverage.
- **Guidance.** Attaches FDA guidance passages, each verified verbatim against the official PDFs.
- **Classify.** Labels each criterion *Review recommended*, *Evidence supports retaining* or *Insufficient evidence*. It shows supporting, challenging and context evidence by tier, plus missing evidence and a cautious next action.
- **Verify.** Checks any structured recommendation and returns *Supported*, *Supported with qualifications*, *Rejected* or *Needs medical review*.
- **Packet.** Exports the review packet as Markdown, printable HTML or JSON, with decision fields.

### Why it must stay evidence-grounded

The output goes to a clinical team deciding who may enrol in a trial. One unsupported leap could push a team to loosen a safety threshold. Examples:
- "a peer trial used 9, so 10 is unnecessary"
- "the PD-1 drug isn't myelosuppressive, so relax ANC"

The engine therefore enforces these rules, which you must preserve:
- A toxicity link supports having *a* threshold, never a specific value.
- A more permissive comparator shows a threshold was *used*, not that it was safe.
- Agreement among comparators may be template carry-forward.
- No comparable precedent means "Insufficient evidence", not "retain".
- FDA guidance issued after a trial started is labelled **retrospective**.
- Differences from peers are **review questions, not mistakes**. No output may claim that one trial's results caused another trial's design choices.

**Reference example: EMPOWER-Lung 3 hemoglobin.** EMPOWER-Lung 3 (NCT03409614) requires hemoglobin ≥10 g/dL. Several peers used ≥9.
- **Own context first.** ProtocolOS looks at the trial's own regimen (platinum doublets with pemetrexed or paclitaxel) and the protocol's anemia discussion (p. 51).
- **Conclusion.** A plausible safety rationale exists, but the precise threshold is not established by the available evidence.
- **Classification.** *Review recommended*.
- **Protocol version.** The posted protocol is Amendment 5. We make no claim about how the threshold evolved, or that EMPOWER-Lung 1 influenced it.

### Deterministic vs model-driven

| Component | Deterministic? |
|---|---|
| Ingestion, extraction, regimen, comparator discovery, comparison | Yes (rules + curated tables) |
| FDA passage index and quote verification | Yes |
| Classification, purposes, suggested action | Yes (transparent rules in `review.py`) |
| Verifier | Yes (`verifier.py`; also runs on Chalk) |
| Review packet | Yes |
| LLM critic (`/api/critique`) | Model. May only *downgrade* a flag. Optional. **Never run against a live model so far** |
| Free-text challenge parsing (`/api/parse`) | Model output, then the deterministic verifier. Optional. **Not run** |
| LLM-only verifier baseline (`evals.run_evals --llm`) | Model. Evaluation only. **Not run** |

### Known limitations and non-claims

**Limitations:**
- Posted protocols are usually the final amendment, and ProtocolOS does not track amendments.
- Extraction is rule-based and misses unusual layouts.
- The drug table is curated at class level.
- Purpose tags are inferred.
- Classification is a heuristic, not a validated model.
- Gold labels come from a single annotator, and no clinician has reviewed the outputs.
- NHANES describes the general population, not people with cancer.

**ProtocolOS never claims:**
- that a threshold is safe to change
- that a difference from peers is a mistake
- that one trial caused another's design
- that a change would improve enrollment or cost
- that any output is clinically validated

---

## B. Repository architecture

```
trialforge/        Python engine (package keeps its original name)
web/               Dashboard: index.html, app.js, styles.css (vanilla JS, no build step)
evals/             Gold labels, verifier cases, planted-issue generator and runners
chalk_project/     Chalk feature store + Chalk Evaluation bundle builder
tests/             pytest invariants (tests/test_core.py)
data/              Committed eval results + gitignored caches (protocols, registry, reviews, decisions)
docs/              Demo script, Devpost text, deck, this file, the evidence-agent plan
research/          Background research and the concept decision record
```

### Engine modules (`trialforge/`)

| Module | Reuse these | Notes |
|---|---|---|
| `sources.py` | `fetch_study(nct)`, `fetch_protocol(nct) -> PdfDoc \| None`, `search_studies(params)`, `fetch_guidance(key)`, `PdfDoc` (`.pages`, `.full_text`, `.url`), `FDA_GUIDANCES`, `DATA` | Downloads and caches everything under `data/`. `python -m trialforge.sources NCT...` pre-fetches. Uses `pdftotext` if installed, otherwise pypdf. |
| `extract.py` | `analyze_trial(nct, doc_override=None)` → `{study, criteria, regimen, _doc}` | Rule-based criterion and regimen extraction. Each criterion dict has `id, analyte, category, label, section, operator, value_norm, unit_norm, conditions, exceptions, source{doc,url,page,line,text}, item_text, method`. |
| `druglib.py` | `drugs_with(names, prop)`, `classes(names)`, `LAB_RELEVANCE` | Curated drug-class table (myelosuppressive / hepatic / renal / immunotherapy). |
| `comparators.py` | `load_comparators(target, k, as_of, fixed)`, `compare(target, comps)`, `direction(analyte, target_val, comp_val)`, `coverage(...)` | Registry-driven discovery of earlier, similar trials; threshold diff with regimen coverage. |
| `guidance.py` | `load_passages() -> (passages, failed)`, `passages_for(analyte)`, `verify_quote(guidance_key, quote)`, `normalize(text)`, `Passage.to_dict()` | 32 FDA passages verified verbatim at load. `to_dict()` gives `citation`, `link` and `issued` (YYYY-MM). |
| `review.py` | `run_review(nct, k=4, as_of="auto")`, `review_criterion(...)`, `protocol_rationale(doc, crit, elig_pages)`, constants `CLASS_*`, `TIERS` | **The core result object** (schema below). Evidence order: regimen, then protocol, then comparators, then FDA. |
| `verifier.py` | `verify(rec, ctx, resolvers=None)`, `default_resolvers()`, `OVERCLAIM`, `NECESSITY`, `FACTUAL_CHECKS` | Pure function over the review dict. Also bundled into the Chalk Evaluation. **Do not change its behaviour** without re-running the verifier evals. |
| `packet.py` | `build_packet(review, decisions)`, `to_markdown`, `to_html`, `load_decisions(nct)`, `save_decision(...)` | Decisions are stored in `data/decisions/{nct}.json` (gitignored). |
| `llm.py` | `available()`, `provider()`, `critique(item, regimen)`, `parse_recommendation(text, ctx)`, `llm_only_verify(rec, ctx)`, `_json_call(system, user, schema)` | Prefers the Chalk router when `CHALK_ROUTER_API_KEY` is set, otherwise Anthropic. Output is schema-checked. |
| `chalk_bridge.py` | `registry_profile(nct)` | Live Chalk online query of the deployed `Trial` features. Returns `status: unavailable` rather than faking data. |
| `nhanes.py` | `below_threshold(analyte, threshold, ...)` | Survey-weighted general-population context (secondary). |
| `api.py` | `get_review(nct, as_of, refresh)` | FastAPI app. Reviews are memoised in memory and cached at `data/reviews/{NCT}_{as_of}.json`. |

**`run_review()` result schema.** This is what `/api/review/{nct}` returns, and what the graph should be built from:

```
{
  "target": {
    "study": {nct_id, title, sponsor, status, start_date, protocol_docs[{filename,type,date,url}], eligibility_pages, ...},
    "criteria": [criterion, ...],
    "regimen": {"drugs": {name: {class, myelosuppressive, hepatic, renal, immunotherapy, sources[]}}, "unrecognized": [...]}
  },
  "as_of": "2018-03-06",                       # comparator cutoff (the trial's start date by default)
  "comparators": [{study, regimen, similarity, tags, criteria}],
  "comparison": {criterion_id: [{nct_id, acronym, criterion, direction, coverage}]},
  "reviews": [{
     "criterion": {...},
     "purposes": [{purpose, status: "inferred"|"not indicated"|..., basis, fda_context?}],
     "classification": "Review recommended" | "Evidence supports retaining" | "Insufficient evidence",
     "scores": {support, challenge},
     "explanation": "...",
     "evidence": [{
        kind: "regimen"|"protocol"|"comparator"|"fda",
        stance: "supports"|"challenges"|"context",
        strength, summary, tier,
        page?, quote?, url?, nct_id?,                                  # protocol / comparator
        key?, citation?, link?, issued?, retrospective?, timing_note?  # fda
     }],
     "missing_evidence": ["..."],
     "suggested_action": {action, text}
  }]
}
```

Evidence items have **no stable IDs**. The graph plan explains how to derive them.

### API endpoints (`trialforge/api.py`)

| Method & path | Purpose |
|---|---|
| `GET /api/status` | LLM availability, FDA passage verification, Chalk status (from `data/chalk_status.json`), evals present |
| `GET /api/review/{nct}?as_of=auto\|none\|YYYY-MM-DD&refresh=0\|1` | Full review (cached) |
| `POST /api/verify` `{nct, recommendation, as_of, with_llm_baseline}` | Deterministic verification of a structured recommendation |
| `POST /api/whatif` `{nct, criterion_id, value, as_of}` | Compare an alternative threshold with comparators, plus auto-verification |
| `POST /api/parse` `{nct, text, as_of}` | Free text to structured recommendation, then verify (503 without an LLM key) |
| `POST /api/critique` `{nct, criterion_id, as_of}` | LLM critic (503 without an LLM key) |
| `GET /api/protocol/{nct}/page/{page}` | Raw text of one protocol page plus a PDF deep link. **Use this for click-to-source** |
| `GET /api/chalk/registry/{nct}` | Chalk online query (registry profile) |
| `GET /api/packet/{nct}?format=json\|md\|html` | Review packet |
| `POST /api/decision` `{nct, criterion_id, decision, reason, reviewer}` | Record a reviewer decision |
| `GET /api/evals`, `GET /api/planted` | Saved evaluation results for the Evaluation tab |

### Frontend (`web/`)

`index.html` has four tabs (`data-tab="review" | "packet" | "evals" | "method"`). `app.js` holds all rendering:
- `loadReview`, `renderStudy`, `renderCriteria`, `renderDetail` (evidence columns by stance)
- `challengeForm` / `verifyForm` (verifier UI)
- `loadPacket`, `loadEvals`
- helpers `api(path)`, `post(path, body)`, `esc()`, `srcLink(nct, page, quote, label)`

There is no build step and there are no dependencies.

### Chalk code (`chalk_project/`)

- `feature_store/src/trial_features.py`: the `Trial` feature class and the `resolve_trial` online resolver, which calls the ClinicalTrials.gov API inside Chalk. Features include:
  - `has_protocol_pdf`
  - `registry_mentions_anc`
  - `registry_ecog_max`
  - `registry_eligibility_chars`
  - …

  Its docstring mentions "review-level features"; those were **not** implemented.
- The root `chalk.yaml` deploys only the feature store, with `chalk_project/feature_store/requirements.txt`. Chalk's runtime pins `pydantic<2`, which conflicts with FastAPI, so this isolation is deliberate. `.chalkignore` excludes the app code.
- `build_eval_bundle.py` writes `chalk_project/trialforge_chalk_eval.py` (from `chalk_eval_template.py` plus the inlined `verifier.py`) and `eval_dataset.jsonl`. Both are **gitignored**, because the dataset embeds protocol text; rebuild them locally.

### Tests and evaluation datasets

| Path | Contents |
|---|---|
| `tests/test_core.py` | 13 invariants (FDA quotes verbatim, EMPOWER-Lung 3 extraction, verifier rejections, classification guardrails, NHANES) |
| `evals/gold/criteria.json` | Hand-labelled criteria, regimens and classifications (19 protocols; dev / held-out / unseen splits) |
| `evals/verifier_cases.py` | 39 verifier cases (24 faults, 10 valid, 5 ambiguous) |
| `evals/planted/` | Planted-issue variants, answer key, first-run results |
| `evals/run_evals.py` | Writes `data/eval_results.json` |
| `evals/run_planted.py` | Writes `data/planted_results*.json` |

---

## C. Local setup

Requirements:
- Python 3.12
- [uv](https://docs.astral.sh/uv/)
- Optional: `brew install poppler` (provides `pdftotext`; the pypdf fallback works but may extract slightly differently)

```bash
git clone https://github.com/rinatrizvanov/ProtocolOS.git && cd ProtocolOS
uv sync --group dev

# fetch and cache source documents (first run ~1 min; tests read these caches)
uv run python -m trialforge.sources NCT03409614 NCT03088540 NCT02578680

uv run uvicorn trialforge.api:app --port 8765         # open http://localhost:8765, load NCT03409614
uv run pytest -q tests/                               # 13 invariants (first run also discovers/fetches comparators)
uv run python -m evals.run_evals                      # extraction + verifier evals (downloads ~19 protocols first time)
uv run python -m evals.planted.make_variants && uv run python -m evals.run_planted
```

### What needs credentials

| Feature | Needs | Without it |
|---|---|---|
| Review, verifier, packet, evals, tests | Nothing (public internet for ClinicalTrials.gov / FDA / CDC on first run) | — |
| Chalk registry profile in the dashboard | `chalk login` to the team's Chalk environment (ask the repo owner for an invite) | Shows "unavailable"; everything else works |
| Chalk deploy / Chalk Evaluation | Same Chalk login, plus an environment with Evaluations enabled | — |
| LLM critic, free-text parsing, LLM baseline | `CHALK_ROUTER_API_KEY` (preferred) or `ANTHROPIC_API_KEY` in `.env` | Endpoints return 503; the UI shows "not configured" |

**Never commit `.env`**; it is gitignored. No credentials or tokens appear in this repository or its docs.

### Connecting to Chalk

```bash
~/.chalk/bin/chalk login && ~/.chalk/bin/chalk user        # pick an environment of the Chalk team `triallens`
~/.chalk/bin/chalk query --in trial.nct_id=NCT03409614 --out trial.registry_mentions_anc --out trial.has_protocol_pdf
uv run python -m trialforge.chalk_bridge NCT03409614       # the same query through the app's code path
```

Do **not** run `chalk apply` unless you intend to redeploy the feature set; it is already deployed (see D). Optionally, `chalk mcp configure-claude --claude-scope local` registers the Chalk MCP server for your own Claude Code; it writes nothing to the repo.

### Troubleshooting

- **Tests error with network or `None` protocol.** Run the `trialforge.sources` fetch command first; tests read cached documents.
- **Dashboard shows old explanation text after an engine change.** The review is cached. Open `/api/review/NCT03409614?refresh=1`, or delete `data/reviews/*.json`.
- **"Chalk registry profile unavailable".** You are not logged in, not on the team, or offline. This is harmless for everything else.
- **pydantic version errors around Chalk.** Never add the feature-store requirements to the app environment, and deploy only via the root `chalk.yaml`.
- **`/api/parse` or `/api/critique` return 503.** No LLM key; this is expected. (The error text mentions `ANTHROPIC_API_KEY`, but `CHALK_ROUTER_API_KEY` also works.)
- **ClinicalTrials.gov 403/429 or timeouts.** Retry; registry responses and searches are cached under `data/registry/` and `data/search_cache/`.
- **Different extraction numbers from the README.** Check whether `pdftotext` is installed; the published numbers were produced with it available.

---

## D. Current Chalk integration

This is the state recorded on 2026-10-17; `CHALK.md` is the authoritative current state, and `data/chalk_status.json` is the committed snapshot behind the dashboard's Chalk chip, not a live check. It was **not re-verified live** when this document was written.

| Component | Status | Identifiers |
|---|---|---|
| `Trial` feature set + `resolve_trial` online resolver | **Deployed; online queries succeed** from the CLI and the app | Environment `trllf247b678` (project `Default`); deployment `cmvco4ewl01ct014wpkr04aev` (later redeployed with explicit resolver outputs); example query `cmvcog6jd001d0g9avt2v2jvr` for NCT03409614, about 0.1–0.9 s |
| Verifier on Chalk Compute + Chalk Evaluations | **Ran successfully**: 39 rows, 0 task errors; 24/24 faults rejected, 0/10 valid rejected, 5/5 ambiguous flagged; `verdict_correct` mean 1.0 | Evaluation `cmvco3m0n01dw01y520oc80sq`; run `e61fce6c-892f-4215-9122-48ad77c42df6`; functions `tf_verify`, `verdict_correct`, `rejected_fault`, `false_rejection`, `valid-json` |
| Model Gateway (router) | **Implemented in `llm.py`, never called.** The endpoint returns `401 invalid_api_key` without a key | `https://api.chalk.ai/v1/router`, model `openai/gpt-6.1-sol`. The `llm.py` default `X-Chalk-Env-Id` is `clkdcdaf84e`, which differs from the feature environment above; confirm which environment a router key belongs to before relying on it |
| Sandboxes, traces | Not used | — |

No dashboard URLs were recorded. Find the evaluation and deployment by these IDs in the Chalk web UI.

**Do not recreate any of this.** Reuse:
- `chalk_bridge.registry_profile()` for Chalk feature reads
- `llm._json_call()` for model calls (it already routes through the Chalk gateway when the key exists)
- the `build_eval_bundle.py` pattern if you add a new Chalk Evaluation, **under a new name**, so the existing `trialforge-verifier` evaluation is untouched

---

## Working in parallel

- **Branch:** `git checkout -b feature/evidence-graph-agent`, and open a PR into `main`. Rebase on `main` daily (`git fetch && git rebase origin/main`).
- **Your area:** new files (`trialforge/graph.py`, `trialforge/investigate.py`, `web/graph.js`, `tests/test_graph.py`, …) plus small, append-only hooks in `trialforge/api.py`, `web/index.html` and `.gitignore`.
- **Owned on `main` by the other workstream** (scientific correctness, demo reliability, submission). Avoid editing:
  - `trialforge/review.py`, `verifier.py`, `extract.py`, `sources.py`, `comparators.py`, `guidance.py`, `packet.py`
  - `web/app.js` (beyond a one-line hook)
  - `README.md`, `CHALK.md`, `docs/DEVPOST.md`, `docs/DEMO_SCRIPT.md`, `docs/deck/`
  - committed `data/*.json` results
- **Do not** replace the deterministic verifier or rebuild the protocol-ingestion pipeline. If you need a change there, describe it in the PR and it will be made on `main`.
