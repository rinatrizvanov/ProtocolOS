# Evidence provenance graph + bounded investigation agent: implementation plan

**Status:** proposal for `feature/evidence-graph-agent`. Nothing in this document is implemented yet.

**Scope:** additive. Do not rewrite the application, replace the deterministic verifier, or rebuild ingestion.

**Goal:** most clinical-trial "AI reviewers" are retrieval plus a paragraph of prose. ProtocolOS already has typed, sourced evidence per criterion. This feature makes that structure *visible and interrogable*:
- which claim rests on which passage
- what contradicts it
- what was inferred rather than read
- what a verifier rejected

**Target demo:** EMPOWER-Lung 3 (NCT03409614), hemoglobin ≥10 g/dL. Build for this example first; generalize only when it works.

Read [TEAMMATE_ONBOARDING.md](TEAMMATE_ONBOARDING.md) first. It documents the `run_review()` schema that everything here builds on.

---

## 1. Provenance graph

### Design principles

1. **Built from stored evidence.** The input is the existing review result (`api.get_review()`, cached in `data/reviews/`). The graph never re-runs retrieval.
2. **Every evidence node points to a real source.** Each one carries a document URL and, where available, page, line and verbatim quote, plus the document version or date.
3. **Facts are separated from inferences.** Every node carries `epistemic`, one of:
   - `source_fact`: verbatim text from a document
   - `curated`: drug-class table
   - `rule_inferred`: ProtocolOS rules (classification, purpose tags)
   - `model_generated`
   - `human`: reviewer decision
4. **Contradictions are preserved.** Stance `challenges` becomes a challenge edge. `context` becomes a context edge, never folded into support.
5. **No causal edges between trials.** There is no `INFLUENCED`, `CAUSED`, `DERIVED_DESIGN_FROM` or similar. Peer trials connect to a criterion only through the comparison that ProtocolOS made. Co-occurrence is not causality.
6. **Scope is explicit.** Regimen toxicity evidence has `strength: "existence only"`, so its edge carries `scope: "existence_of_threshold"`, never `scope: "threshold_value"`. This stops the graph from implying that a toxicity rationale proves a specific cutoff.
7. **No duplicates or orphans.** Node IDs are content hashes, so the same passage (for example protocol p.51, which is cited for both hemoglobin and ANC) is one node with two edges. A validator rejects orphan nodes and dangling edges.

### Node types (refined to the real data)

| Type | Built from | Key fields | `epistemic` |
|---|---|---|---|
| `Trial` | `target.study`, `comparators[].study` | nct_id, acronym, sponsor, start_date, status, role (`reviewed` \| `comparator`) | source_fact |
| `Document` | `study.protocol_docs[0]`, comparator `criterion.source.url`, FDA guidance | url, filename, **version/date** (protocol doc `date`; FDA `issued`), kind (`protocol` \| `fda_guidance`) | source_fact |
| `Drug` | `target.regimen.drugs` | name, class, flags, `sources[]` (where the drug was found) | curated (flags) / source_fact (presence) |
| `Criterion` | `reviews[].criterion` | id, label, operator, value_norm, unit_norm, page, line, verbatim text | source_fact |
| `Claim` | one per criterion: *"{label} {threshold} is adequately justified for this trial"*; plus purpose tags from `purposes[]` | text, classification, scores | rule_inferred |
| `Passage` | protocol and comparator evidence (`quote`, `page`, `url`) and the criterion's own source line | quote, page, line?, doc_id | source_fact |
| `GuidancePassage` | `evidence[kind=fda]` | quote, citation, link, issued, **retrospective**, timing_note, specific/general | source_fact |
| `CuratedFact` | `evidence[kind=regimen]` | summary, drugs, property | curated |
| `Recommendation` | `suggested_action` | action, text | rule_inferred |
| `VerificationResult` | output of `verifier.verify()` (from `/api/verify` or the agent) | status, outcome, checks[] | rule_inferred |
| `ReviewerDecision` | `packet.load_decisions(nct)` | decision, reason, reviewer, recorded_at | human |
| `MissingEvidence` | `missing_evidence[]` | text | rule_inferred |

The type list deliberately has no separate "supporting" or "contradictory" passage type. Support and contradiction are **edge** properties, because the same passage can support one claim and contextualize another.

### Edge types

| Edge | From → To | Notes |
|---|---|---|
| `TRIAL_HAS_CRITERION` | Trial → Criterion | |
| `TRIAL_USES_DRUG` | Trial → Drug | `sources` = where in the protocol/registry |
| `CRITERION_STATED_IN` | Criterion → Passage | the criterion's own source line (p.67 for EL3 Hgb) |
| `CRITERION_HAS_CLAIM` | Criterion → Claim | |
| `CLAIM_SUPPORTED_BY` | Claim → Passage / CuratedFact / GuidancePassage | `strength`, `scope` (`existence_of_threshold` \| `threshold_value`) |
| `CLAIM_CHALLENGED_BY` | Claim → Passage / CuratedFact / GuidancePassage | `strength`; comparator edges carry `comparator_nct`, `direction`, `coverage` |
| `CLAIM_CONTEXTUALIZED_BY` | Claim → Passage / GuidancePassage | stance `context` (e.g. EL3 p.51 anemia passage; same-threshold comparators) |
| `PASSAGE_FROM` | Passage / GuidancePassage → Document | carries page/line |
| `DOCUMENT_OF` | Document → Trial | |
| `COMPARED_WITH` | Criterion → Trial (comparator) | `direction`, `coverage`, `basis: "registry similarity + regimen classes"`; **not** influence |
| `RECOMMENDATION_FOR` | Recommendation → Criterion | |
| `RECOMMENDATION_REQUIRES_REVIEW` | Recommendation → Claim | when classification is *Review recommended* |
| `CLAIM_LACKS` | Claim → MissingEvidence | |
| `VERIFIED_BY` | Recommendation/agent Claim → VerificationResult | |
| `VERIFIER_REJECTED_CLAIM` | VerificationResult → Claim | one per failed check, `check`, `category` (`factual` \| `clinical-logic`) |
| `DECIDED_BY` | Criterion → ReviewerDecision | |

**Forbidden edge types** (enforced by the validator): anything expressing causality or design influence between trials.

### Stable IDs and dedup

```python
def node_id(kind, *parts):  # parts normalized with guidance.normalize()
    return f"{kind}:{hashlib.sha1('|'.join(map(str, parts)).encode()).hexdigest()[:12]}"

Passage:  node_id("passage", url, page, normalize(quote))
Document: node_id("doc", url)
Trial:    f"trial:{nct_id}"
Criterion:f"crit:{nct_id}:{criterion_id}"
Claim:    f"claim:{nct_id}:{criterion_id}:justified"
```

### JSON shape

```json
{
  "nct_id": "NCT03409614",
  "built_from": {"review_cache": "data/reviews/NCT03409614_auto.json", "computed_at": "...", "as_of": "2018-03-06"},
  "nodes": [{"id": "passage:ab12…", "type": "Passage", "label": "p.51: …grade 3 to 4 toxicities of anemia…",
             "epistemic": "source_fact", "data": {"quote": "…", "page": 51, "url": "…Prot_000.pdf", "doc_date": "2020-04-16"}}],
  "edges": [{"source": "claim:NCT03409614:hemoglobin:justified", "target": "passage:ab12…",
             "type": "CLAIM_CONTEXTUALIZED_BY", "data": {"strength": "weak"}}],
  "warnings": ["Protocol is the posted version (Amendment 5), not necessarily the design-time version."]
}
```

### UI

- Add an **Evidence graph** tab next to the existing tabs. Add a "View as graph" link in the criterion detail card only if it is a one-line change.
- **Layout:** a deterministic, column-based SVG drawn in a new `web/graph.js`, with no dependency and no CDN (demo reliability). Columns: *Supports · Criterion/Claim · Challenges*. *Context* sits below, and Documents/Trials sit on the outer edge.
- **Visual encoding:** node shape or colour by `type`; border style by `epistemic` (solid = source_fact, dashed = inferred, dotted = model).
- **Click a node:** a side panel shows the verbatim quote, citation, page, document date, and a link that opens the page via the existing `GET /api/protocol/{nct}/page/{page}` and the PDF deep link (`url#page=N`).
- **Filters:** by criterion, by stance, and "show only source facts".

---

## 2. Bounded evidence-investigation workflow

The user selects a criterion and asks one of four fixed questions:

| `question` | Meaning |
|---|---|
| `why_flagged` | Why was this flagged? |
| `support_retaining` | What evidence supports retaining it? |
| `contradicting` | What evidence contradicts this recommendation? |
| `what_would_change` | What additional information would change this conclusion? |

Free-text questions are mapped to one of these four. Anything else is rejected with a "can't answer" response.

### Execution, bounded

1. **Resolve** `nct`, `criterion_id` and `question`. Load the review (cached) and build the graph.
2. **Gather the existing evidence** for the claim: all `supports`, `challenges` and `context` edges, plus the `MissingEvidence` nodes. **Counterevidence is always gathered**, whatever the question.
3. **Decide whether more retrieval is needed.** Deterministic rules, for example:
   - a cited comparator page has no quote yet → fetch that page
   - the question is `what_would_change` → no new retrieval
4. **Call only whitelisted tools.** Maximum **4 tool calls**, **2 model calls**, **60 s**. There are no loops beyond these budgets.

   | Tool | Wraps |
   |---|---|
   | `get_review_item(criterion_id)` | `api.get_review` |
   | `get_protocol_page(nct, page)` | `sources.fetch_protocol(...).pages[page-1]` |
   | `get_comparator_threshold(nct, analyte)` | `verifier.default_resolvers()["nct_threshold"]`; **only for NCT IDs already in the review** |
   | `get_fda_passages(analyte)` | `guidance.passages_for` |
   | `search_protocol(nct, terms)` | read-only regex over the cached protocol, reusing the `review.protocol_rationale` style |
   | `registry_profile(nct)` | `chalk_bridge.registry_profile` (Chalk feature read) |

5. **Synthesize** a structured answer:
   - **Deterministic mode (default):** templated from graph edges.
   - **Model mode (feature-gated):** `llm._json_call` with a strict schema. The model may only cite `evidence_ids` that it was given.
6. **Run deterministic checks** on the answer:
   - **Citation check:** every `evidence_id` exists in the graph, and every quoted string is verbatim (`guidance.verify_quote` for FDA; `normalize(quote) in normalize(doc.full_text)` for protocols).
   - **Threshold check:** every number in the answer matches the criterion or the cited comparator value (reuse the `verifier.verify` comparator logic).
   - **Contradiction check:** a statement labelled "supports" must not cite only challenge edges. If challenge edges exist, the answer must mention them.
   - **Language check:** reject causal phrasing between trials (`caused|led to|because of <trial>|influenced|resulted in`). Reject approval or safety claims (reuse `verifier.OVERCLAIM`, `verifier.NECESSITY`). Reject any NCT ID not present in the graph.
7. **Label every statement:**
   - `supported`: cites at least one verified source fact
   - `uncertain`: only rule-inferred or contextual support
   - `unsupported`: failed a check; shown struck through, never silently dropped

   "Insufficient evidence" is a valid overall answer.
8. **Update the graph.** Agent statements become `Claim` nodes with `epistemic: model_generated` or `rule_inferred`, linked to their evidence and to a `VerificationResult`. They are stored as an **overlay** in `data/graph_overlays/{nct}.json` (gitignored), never written into the review cache.
9. **Keep an audit trail** in `data/investigations/{nct}/{timestamp}.json`: question, tool calls (name, args, duration, result summary), model calls (provider, model, token counts), checks and final labels.

### Hard constraints

The model must never:
- invent trial IDs
- quote passages that don't exist
- infer causation from comparisons
- approve or recommend a specific eligibility change ("approve", "safe to lower", and so on fail the language check)

The deterministic verifier stays the authority.

### `what_would_change`, deterministically

Derive the answer from the classification rule in `review.review_criterion`:
- A value-specific protocol rationale adds +2 support and prevents *Review recommended*.
- Regimen-matched comparators at the same or a stricter value add support.
- Outcome data comparing thresholds is listed in `missing_evidence`.

Show these as "evidence that would change the classification", not as advice.

---

## 3. Chalk involvement

**Verify the account first.** This could not be re-checked when this plan was written:

```bash
~/.chalk/bin/chalk user                 # which environment / team
~/.chalk/bin/chalk router model list    # is Model Gateway access enabled for the team?
```

You can also use the Chalk MCP `whoami` / `list_functions`.

| Chalk capability | Use in this feature | Status today |
|---|---|---|
| Feature resolvers (`Trial`) | The `registry_profile` tool provides registry-level facts as graph nodes, e.g. "registry does not mention ANC" with `source: Chalk query <id>` | Deployed, works |
| Model Gateway | Question interpretation and answer synthesis in **model mode**, via the existing `llm._json_call` (it already routes to the Chalk router when `CHALK_ROUTER_API_KEY` is set) | **Never called.** Feature-gate on `llm.provider() == "chalk_router"`; the deterministic mode must work without it |
| Chalk Evaluations | New evaluation **`protocolos-investigator`** (do not touch `trialforge-verifier`). Dataset: ~12 (criterion, question) pairs on EL3 plus planted variants. Scorers: citations valid, counterevidence mentioned, no causal or approval language, NCT IDs all known. Compare **model answer before vs after the deterministic checks** | Not built. Follow `chalk_project/build_eval_bundle.py`: a self-contained file plus a frozen-context dataset; keep generated files gitignored |
| Chalk Compute | Optional: run the answer checker as a Chalk function, as `tf_verify` does. Only worth it for the evaluation | Not needed for the MVP |
| Traces / reproducibility | Store Chalk query IDs and evaluation run IDs in the audit trail and on graph nodes | — |

If Model Gateway access is still blocked, ship the graph and the deterministic investigator only, and show "model mode: not configured", as the critic does today. Never substitute canned model output.

---

## 4. Technical handoff

### New files

| File | Contents |
|---|---|
| `trialforge/graph.py` | `build_graph(review: dict, decisions: dict \| None = None, criterion_id: str \| None = None) -> dict`, `validate_graph(g) -> list[str]`, `node_id(...)` |
| `trialforge/investigate.py` | `investigate(nct, criterion_id, question, as_of="auto", mode="deterministic") -> dict`, tool whitelist, budgets, `check_answer(answer, graph, review) -> list[check]` |
| `web/graph.js`, optional `web/graph.css` | Graph tab rendering and the node side panel |
| `tests/test_graph.py`, `tests/test_investigate.py` | See below |
| later: `evals/investigator_cases.py`, `chalk_project/build_investigator_eval.py` | Chalk evaluation |

### Existing files to touch (small, append-only)

- `trialforge/api.py`: add the endpoints below at the end of the file. Reuse `get_review()`.
- `web/index.html`: one tab button `data-tab="graph"`, one container `<section id="graph">`, one `<script src="/static/graph.js">`.
- `.gitignore`: `data/graph_overlays/`, `data/investigations/`.

### API

```
GET  /api/graph/{nct}?as_of=auto&criterion_id=hemoglobin
  -> {nct_id, built_from, nodes[], edges[], warnings[], validation: []}

GET  /api/graph/{nct}/node/{node_id}
  -> {node, neighbours[], source: {url, page, quote, page_text?}}

POST /api/investigate
  {nct, criterion_id, question: "why_flagged"|"support_retaining"|"contradicting"|"what_would_change", as_of: "auto", mode: "deterministic"|"model"}
  -> {
       question, criterion,
       answer: {summary, overall: "supported"|"uncertain"|"insufficient_evidence",
                statements: [{text, status: "supported"|"uncertain"|"unsupported", evidence_ids: [], failed_checks: []}]},
       counterevidence: [evidence_id],
       tool_calls: [{tool, args, ms, result_summary}],
       checks: [{check, result: "pass"|"warn"|"fail", detail}],
       graph_delta: {nodes: [], edges: []},
       budget: {max_tool_calls: 4, used: n, max_model_calls: 2, used_model: m},
       mode, audit_path
     }
```

### Data flow

```
get_review(nct) ──► build_graph() ──► /api/graph ──► graph.js (click ► /api/protocol/{nct}/page/{p})
        │                 │
        └──► investigate(): gather edges (incl. counterevidence) ► ≤4 whitelisted tools ► synthesize
                            (template | Chalk router) ► check_answer() + verifier.verify() ► label
                            ► overlay + audit file ► graph_delta to UI
```

### Minimal tests (use the same cached EL3 review as `tests/test_core.py`)

- The EL3 hemoglobin `Criterion` node exists with page 67 and the verbatim line.
- The p.51 anemia passage is linked by `CLAIM_CONTEXTUALIZED_BY`, **not** `CLAIM_SUPPORTED_BY`.
- The regimen `CuratedFact` edge has `scope == "existence_of_threshold"`.
- The p.51 passage is a single node even though several criteria cite it (no duplicates).
- `validate_graph()` returns `[]`: no orphans, no dangling edges, every Passage and GuidancePassage has a URL, no forbidden edge types.
- FDA guidance nodes for EL3 have `retrospective == True`.
- Four comparator `Trial` nodes (CheckMate 9LA, eNERGY, CheckMate 227, KEYNOTE-042) connect via `COMPARED_WITH`, and no edge links two trials directly.
- In deterministic mode, `investigate(..., "why_flagged")` cites at least one challenge edge **and** mentions the safety-rationale context; every statement is `supported` or `uncertain`.
- `check_answer` rejects:
  - an NCT ID not in the graph
  - "EMPOWER-Lung 1 caused…"
  - "9 g/dL is safe"
  - a quote not found in the protocol
- The budget is enforced: a fake planner requesting 10 tools stops at 4.

### Avoiding merge conflicts

- Work only on `feature/evidence-graph-agent`; rebase on `main` daily; open small PRs.
- Don't edit the files listed under "Working in parallel" in the onboarding doc. If the graph needs a field the review doesn't provide, derive it in `graph.py`. If that is impossible, ask for the change to be made on `main`.
- The cached review JSON may predate engine changes. Make `build_graph` tolerant of missing optional keys (`retrospective`, `issued`, `timing_note`).

### Smallest working demonstration

1. Load NCT03409614 and switch to **Evidence graph**, filtered to hemoglobin.
2. The claim node "Hemoglobin ≥10 g/dL is adequately justified" shows:
   - **Left:** curated regimen fact (scope: existence of a threshold).
   - **Right:** three comparator passages at ≥9 g/dL (CheckMate 9LA, CheckMate 227, KEYNOTE-042), with regimen coverage on the edges.
   - **Below:** the p.51 anemia passage (context), eNERGY >10 (context), and the retrospective FDA passages.
3. Click p.51 to see the verbatim sentence and a link to the protocol page (Amendment 5, dated 2020-04-16).
4. Click **Why was this flagged?** to get a deterministic answer with every statement labelled. Checks pass, the tool-call trail is shown, and the answer says the evidence is a review question, not a finding of error.

### Cut list (cut from the top if time runs short)

1. Chalk `protocolos-investigator` evaluation.
2. Model mode (keep deterministic).
3. `what_would_change`.
4. Overlay persistence (show `graph_delta` without saving).
5. `ReviewerDecision` and `VerificationResult` nodes.
6. Filters in the graph UI.

**Never cut:** the graph for EL3 hemoglobin, click-to-source, `validate_graph`, and deterministic `why_flagged` with counterevidence.
