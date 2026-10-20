# ProtocolOS architecture

This document describes how ProtocolOS is built: the engine, its HTTP API, the two user interfaces, the
deterministic verifier, the evidence sources and the evaluation suite. Every module named here exists in this
repository. The Python package is called `trialforge` (its original name).

## 1. Overview

ProtocolOS is a Python engine (FastAPI) with two front ends:

```
                      ClinicalTrials.gov API v2      FDA guidance PDFs      NHANES 2017-2018
                                 |                          |                      |
                                 v                          v                      v
 trialforge/sources.py   registry records, protocol PDFs, guidance PDFs and NHANES files, cached under data/
                                 |
          extract.py  ->  comparators.py  ->  guidance.py  ->  review.py  ->  verifier.py (authority)
          criteria,       earlier, similar     FDA passages      evidence,       checks any suggested
          regimen         trials + diffs       verified          classification  change
                                 |
          rationale.py, redraft.py, draft.py, graph.py, investigate.py, packet.py   (built on the review)
                                 |
 trialforge/api.py + routes_*.py      FastAPI: /api/*, /docs, and the vanilla dashboard (web/) at /
                                 |
 web-next/                            Next.js app; proxies /api/* to the engine
```

Everything a reviewer sees is computed by deterministic, rule-based code. A language model is optional, can
only downgrade a flag, and every statement it returns passes the same deterministic checks (section 7). The
public deployment runs without a model.

## 2. Engine modules (`trialforge/`)

| Module | Role |
|---|---|
| `sources.py` | Fetches and caches ClinicalTrials.gov records (API v2), the protocol PDFs posted there, the FDA guidance PDFs and the NHANES files. Per-page PDF text comes from poppler's `pdftotext` when installed, otherwise pypdf; Symbol-font glyphs are decoded. |
| `extract.py` | Rule-based extraction of eligibility criteria (hemoglobin, ANC, platelets, bilirubin, AST/ALT, renal function, ECOG, washouts) with operator, value, unit, conditions and the verbatim source line and page. Also extracts the regimen (drugs in every arm) from registry interventions and protocol dosing context. |
| `druglib.py` | Curated, class-level pharmacology table (myelosuppressive, hepatic, renal, immunotherapy). Used only to ask whether an arm contains an agent for which a lab criterion has an obvious safety rationale, never to choose a value. |
| `comparators.py` | Discovers comparable phase 3 trials from the registry (same condition, matching setting and lung-cancer histology, overlapping drug classes, protocol PDF posted, started before the reviewed trial), ranks them by drug-class overlap, runs the same extractor on their protocols and diffs thresholds with direction and regimen coverage. With `PROTOCOLOS_SEMANTIC_COMPARATORS=1` the nearest trials in the semantic index are added as candidates that pass the same rules plus stricter disease and setting rules; each comparator records `found_by` (keyword or semantic). |
| `guidance.py` | Index of 32 hand-chosen FDA passages. At load time each quote must be found verbatim in the downloaded PDF; its page, FDA line numbers and section are computed from the PDF, and a quote that fails is dropped and reported. |
| `review.py` | Assembles evidence per criterion (regimen, protocol, comparators, FDA), scores it with transparent rules and classifies the criterion. `run_review(nct, as_of="auto")` is the core result (section 4). |
| `verifier.py` | Deterministic verification of a structured recommendation (section 5). A pure function over the review dict; network-backed resolvers are injected. |
| `rationale.py` | Rationale report: categories (safety, efficacy enrichment, precedent), which arms list the agents behind a safety rationale, and criteria most comparators state that this protocol lacks. |
| `redraft.py` | Redraft workspace: parses a reviewer's rewritten criterion with the protocol extractor, compares it with the protocol, comparators, the regimen's toxicity link, FDA guidance and NHANES, runs a changed value through the verifier and flags overclaiming language. No model call. |
| `draft.py` | Authoring mode: drafts lab, ECOG and washout criteria for a new trial idea. Every proposed value is copied from a regimen-matched precedent whose threshold the verifier matched to its protocol; otherwise the criterion is "Insufficient evidence" with no value. The review engine then critiques the draft. Presets include EMPOWER-Lung 3 at its design date with its own protocol excluded. |
| `trial_index.py`, `routes_trials.py` | Semantic index of the phase 3 interventional oncology trials with a protocol posted on ClinicalTrials.gov (about 1,400): title, conditions, interventions and brief summary embedded by a local model (fastembed, `BAAI/bge-small-en-v1.5`, ONNX on CPU; no model API), stored under `data/index/` and searched in process by dot product. Serves trial search and similar trials; a similarity score never decides a comparator or a value. |
| `graph.py` | Typed provenance graph built from a stored review: every evidence item is a sourced node, stances are edges, and score totals are attributed to the rules that produced them. Read-only. |
| `investigate.py` | Bounded investigator for one criterion and one of four fixed questions (why flagged, what contradicts it, what supports keeping it, what would change it). At most four whitelisted tool calls in a 60-second budget; every statement is checked by `check_answer` (cited ids exist, stances match, quotes verbatim, numbers present in cited nodes, no causal or instruction language, structured claims pass the verifier). Counterevidence is always gathered and cited. Each run appends one audit line under `data/investigations/`. |
| `packet.py` | Review packet (JSON, Markdown, printable HTML) built only from the review and reviewer decisions; decisions are stored in `data/decisions/<nct>.json`. |
| `llm.py` | Optional model components: a critic that may only downgrade a flag, free-text challenge parsing into the verifier's structured form, and an LLM-only verifier used as an evaluation baseline. Each call uses the visitor's own Anthropic or OpenAI key from the request headers (section 7); a key check uses the provider's models lookup. Without a key every caller reports "not configured". |
| `access.py` | Who may start work on the public deployment: visitor sessions, client addresses, key checks, and limits on new analyses and model calls (section 8). |
| `nhanes.py` | Survey-weighted share of US adults below a lab threshold (NHANES 2017-2018), with design-based standard errors and a fixed caveat. |
| `demo_guard.py` | Public-demo guard (section 8). |
| `api.py`, `routes_graph.py`, `routes_rationale.py`, `routes_redraft.py`, `routes_draft.py`, `web_next.py` | FastAPI app and its routes (section 3). |
| `settings.py` | Reads `PROTOCOLOS_<NAME>` settings, with the legacy prefix as a fallback. |

## 3. HTTP API

FastAPI serves interactive documentation at `/docs` and the schema at `/openapi.json`.

| Method and path | Purpose |
|---|---|
| `GET /api/review/{nct}?as_of=auto\|none\|YYYY-MM-DD` | Full review (cached in memory and in `data/reviews/<NCT>_<as_of>.json`) |
| `GET /api/rationale/{nct}` | Rationale report: categories, arm attribution, missing criteria |
| `GET /api/graph/{nct}?criterion_id=` | Provenance graph with score attribution |
| `POST /api/investigate` | Investigator answer for one criterion and one fixed question (`mode`: `deterministic` or `model`) |
| `POST /api/redraft` | Live checks for a rewritten criterion and an optional rationale note |
| `POST /api/verify` | Deterministic verification of a structured recommendation |
| `POST /api/whatif` | Compare an alternative threshold with comparators, with an auto-built recommendation and its verification |
| `GET /api/draft/vocabulary`, `GET /api/draft/presets` | Recognized drugs, setting tags and phases; cached draft presets |
| `POST /api/draft`, `GET /api/draft/{draft_id}` | Draft criteria for an idea; fetch a cached draft |
| `GET /api/packet/{nct}?format=json\|md\|html` | Review packet |
| `POST /api/decision` | Record a decision with a structured reason |
| `GET /api/protocol/{nct}/page/{page}` | Text of one protocol page and a PDF deep link (click-to-source) |
| `GET /api/nhanes?analyte=&threshold=` | NHANES share below a threshold |
| `POST /api/parse`, `POST /api/critique` | Model components (401 `key_required` without the visitor's key) |
| `GET /api/trials/search?q=&k=`, `GET /api/trials/similar/{nct}?k=` | Semantic trial search and similar trials, each marked `analysed` when this server holds its review |
| `POST /api/model/check` | Check the visitor's key (headers below) with the provider's models lookup |
| `GET /api/status`, `GET /api/evals`, `GET /api/planted`, `GET /api/build` | Component status (with the client address the limits see for the caller), committed evaluation results, running build |

## 4. Review result (`run_review`)

`GET /api/review/{nct}` returns this structure (essentials):

```
{
  "target": {
    "study":    {nct_id, title, acronym, sponsor, status, start_date, phases[], conditions[], protocol_docs[],
                 eligibility_pages[], ...},
    "criteria": [{id, analyte, category, label, operator, value_norm, unit_norm, conditions, exceptions,
                  source: {doc, url, page, line, text}}],
    "regimen":  {"drugs": {name: {class, myelosuppressive, hepatic, renal, immunotherapy, sources[]}},
                 "unrecognized": [...]}
  },
  "as_of": "2018-03-06",                 # comparator cutoff: the trial's start date by default
  "comparators": [{study, regimen, similarity, tags, criteria}],
  "comparison":  {criterion_id: [{nct_id, acronym, criterion, direction, coverage}]},
  "reviews": [{
    "criterion": {...},
    "purposes": [{purpose, status: "inferred" | ..., basis, fda_context?}],
    "classification": "Review recommended" | "Evidence supports retaining" | "Insufficient evidence",
    "scores": {support, challenge},
    "explanation": "...",
    "evidence": [{kind: "regimen" | "protocol" | "comparator" | "fda",
                  stance: "supports" | "challenges" | "context",
                  strength, summary, tier, page?, quote?, url?, nct_id?,
                  citation?, link?, issued?, retrospective?, timing_note?}],
    "missing_evidence": ["..."],
    "suggested_action": {action, text}
  }]
}
```

The engine label "Evidence supports retaining" is shown in both UIs as "Rationale supports keeping". The
suggested action is never "remove" and never asserts safety.

A draft (`POST /api/draft`) has `idea`, `precedents`, `criteria` (each with `status`, `proposed`,
`distribution`, `rationale`, `verification`, `critique`, `why_generated` or `insufficient_reason`), `summary`
(drafted, insufficient, precedents, candidates checked), `notes`, `warnings` and `exports`.

## 5. Deterministic verifier (`verifier.py`)

Any suggested change, from a reviewer, a model, the redraft workspace, the draft module or a test case, is a
structured recommendation:

```
{"criterion_id": "hemoglobin", "action": "relax" | "remove" | "tighten" | "retain" | "add_provision" | "justify_in_protocol",
 "proposed_value": 9.0, "proposed_unit": "g/dL",
 "claims": [{"type": "drug_property", "drug": "cemiplimab", "property": "myelosuppressive", "value": false},
            {"type": "comparator_threshold", "nct_id": "NCT02578680", "value": 9.0, "unit": "g/dL"},
            {"type": "fda_quote", "guidance": "lab", "quote": "..."},
            {"type": "protocol_quote", "quote": "..."}],
 "text": "free-text rationale"}
```

- **Factual checks** compare a claim with a source: the criterion exists, units, plausibility, the comparator
  exists and used that value, FDA and protocol quotes are verbatim, the drug is in the regimen, the drug property
  matches the curated table.
- **Clinical-logic checks** apply written rules: regimen contradiction (a claim that one agent is not myelosuppressive
  does not justify relaxing ANC when another agent in the regimen is), direction, evidence sufficiency,
  removal, a more permissive comparator is not evidence of safety, overclaiming and necessity language, and an
  as-of check that comparators started before the cutoff.
- **Outcomes:** *Rejected* (any failed check), *Supported with qualifications* (warnings), *Supported*. A change
  to a threshold that is not rejected is escalated to *Needs medical review*: changing a threshold is a clinical
  judgment even when every factual check passes.

## 6. Evidence sources

- **ClinicalTrials.gov** (API v2): registry records, search for comparators, and the protocol PDFs sponsors
  posted there. Registry text rarely states lab thresholds, so ProtocolOS reads the protocol PDF.
- **FDA guidance:** the three July 2026 oncology eligibility guidances (laboratory values, performance status,
  washout periods and concomitant medications) and the 2019 enrichment strategies guidance. A passage issued
  after a trial started is labelled retrospective.
- **NHANES 2017-2018** (`DEMO_J`, `CBC_J`): general-population context only. It describes US adults, not
  people with cancer, and is not an enrollment prediction.
- **Curated drug-class table** (`druglib.py`): class-level warnings, labelled as curated knowledge.

Documents are cached under `data/` (gitignored) and are always filled from the official URLs. Document text is
treated as data, never as instructions.

## 7. Model mode (the visitor's own key)

- **Model mode** (optional): the critic may only downgrade a flag; free-text challenges become structured
  claims that the verifier checks; investigator model answers draft statements only from the criterion's graph
  nodes, go through `check_answer`, and can only lower the answer's label. Without a key the app says
  "not configured" and never substitutes canned output.
- **Credentials** arrive with each request: `X-Model-Provider` (`anthropic` or `openai`), `X-Model-Key` and
  optionally `X-Model-Name` (one of `llm.PROVIDERS`; the first is the default). Anthropic calls use the SDK with
  structured output (`output_config.format`) and, for Opus and Sonnet 5.5, the server-side refusal fallback;
  OpenAI calls use the Responses API with a `json_schema` text format. The key is used for that request only,
  is never written to disk or logs, and provider error text is cut wherever it looks like a key. A local run
  without `PROTOCOLOS_PUBLIC=1` may use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` instead (evaluations); the
  public deployment never uses a server key.
- **Chalk** was used during HackHarvard (feature store, the verifier on Chalk Evaluations, the Model Gateway)
  and removed afterwards; the git tag `hackharvard-submission` keeps that state.

## 8. User interfaces and deployment

- **Next.js app (`web-next/`, primary):** `/` landing page with both modes; `/review?nct=&c=&tab=` for
  "Finishing a trial" (four preloaded trials, or any NCT id analysed with the visitor's key; criteria list; tabs
  Rationale, Compare, Ask, Redraft, Decide; packet export). The visitor's session id, key and added trials live
  in browser storage (`lib/visitor.ts`; the key in session storage only);
  `/draft` for "Create criteria from an idea" (presets, idea form, drafted criterion cards, self-critique,
  before/after against a protocol as written); `/tour` (seven steps, mode A) and `/tour/draft` (six steps,
  mode B). The browser talks only to the app's origin; `next.config.ts` rewrites `/api/*` to
  `PROTOCOLOS_API_URL`.
- **Vanilla dashboard (`web/`):** served by FastAPI at `/`, no build step. Tabs: protocol review, review
  packet, evaluation, evidence graph, method and limits, plus a guided demo mode.
- **Deployment:** the engine and the vanilla dashboard run in one Docker container on Railway; the Next.js app
  runs on Vercel. The container prewarms the demo trials at build and start. If a static export exists at
  `web-next/out/`, FastAPI also serves it at `/app` (single-container fallback). See [DEPLOY.md](DEPLOY.md).
- **Public-demo guard** (`PROTOCOLOS_PUBLIC=1`, `demo_guard.py`, `access.py`): validates NCT ids, `as_of`
  values and decision criteria; limits bodies to 16 KB; refuses `refresh=1`. Work that costs the server or a
  model needs the visitor's own key, confirmed with the provider: a review that is not cached (any review,
  packet, graph or rationale request, or a POST naming the trial), a new draft idea (presets stay open), and
  `/api/parse`, `/api/critique` and investigations in model mode. New analyses are limited per visitor (client address plus a hash of the key)
  per hour and per day overall, and stop when the disk is nearly full; uncached reviews are computed one at a
  time. A protocol page is served only for a trial that is a target or comparator of a cached review. Reviewer decisions are stored per
  visitor session (`X-ProtocolOS-Session`, or `?session=` on an export link) under
  `data/decisions/sessions/<session>/`; a decision without a session is refused. Errors carry
  `{"detail", "code"}`, so the app can ask for a key (`key_required`, `key_invalid`) or explain a limit
  (`rate_limited`, `daily_limit`, `storage_full`).

## 9. Guardrails

These rules are enforced in code and tested:

- A toxicity link supports having *a* threshold, never a specific value.
- A more permissive comparator shows a threshold was used, not that it was safe.
- Agreement among comparators may be template carry-forward.
- No comparable precedent means "Insufficient evidence", not "retain"; a drafted criterion without a verified
  precedent gets no value.
- FDA guidance issued after a trial started is labelled retrospective.
- Differences from peers are review questions, not mistakes. No causal claims between trials; no claims that a
  change is safe, improves enrollment or cost, or is clinically validated.
- Model output may only downgrade a flag and must pass the deterministic verifier, which stays the authority.
- Decisions and reasons are recorded in the packet; nothing is retrained on them.
- Blind spot: rationale in non-public sources (preclinical toxicology, internal development data, regulator
  correspondence) cannot be seen.

## 10. Evaluation and tests

| Suite | Command | Result file |
|---|---|---|
| Extraction, comparator direction, FDA quotes, regimen, verifier cases | `python -m evals.run_evals` (`--llm` adds the LLM-only baseline) | `data/eval_results.json` |
| Planted issues in previously unseen protocols | `python -m evals.planted.make_variants && python -m evals.run_planted` | `data/planted_results.json`, `data/planted_results_no_cutoff.json` |
| Investigator answer checker | `python -m evals.investigator.run` | `evals/investigator/results.json` |
| Semantic comparator candidates, keyword alone versus keyword plus index | `python -m evals.semantic.run` | `evals/semantic/results.json` |
| Draft guardrails, leave-one-out | `python -m evals.draft.run` | `evals/draft/results.json` |
| NHANES context numbers | `python -m scripts.impact_numbers` | `evals/impact/impact_numbers.json` |

Gold labels (`evals/gold/criteria.json`) cover 19 protocols in development, held-out and unseen splits;
`evals/first_run_snapshot.json` and `evals/planted/first_run_planted_results.json` keep the first-run numbers.
`scripts/check_numbers.py` fails if a fraction or percentage in the README, the Devpost text or the deck is not
backed by a committed result file.

Tests (`tests/`, `pytest -q tests/`) cover extraction, review guardrails, the verifier, the rationale report,
the redraft workspace, drafting, the graph, the investigator, the public-demo guard, visitor keys and limits
(`test_llm.py`, `test_demo_guard.py`; model calls are mocked) and the API.
Browser checks: `scripts/e2e_review_next.py` and `scripts/e2e_draft_next.py` (Next.js app),
`scripts/e2e_demo.py` (vanilla dashboard); `scripts/smoke_deploy.sh` checks a deployed API.
