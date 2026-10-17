# TrialLens

**Every exclusion deserves evidence.**

TrialLens is an evidence-grounded reviewer for clinical-trial eligibility decisions. Give it an oncology trial's NCT ID and it:

1. Reads the actual protocol PDF.
2. Extracts the laboratory, performance-status and washout criteria.
3. Checks each one against the trial's own regimen, comparable trials and FDA guidance.
4. Produces a review packet a protocol team can discuss and decide on.

A verifier checks every recommendation, and a reviewer can challenge any conclusion.

> Research prototype built at HackHarvard 2026 (Regeneron "Reinvent Clinical Trials" track; Chalk "Best Data-Driven Agent" prize). Not clinical, regulatory or safety advice. Classifications are prompts for expert review.

![Review of EMPOWER-Lung 3 hemoglobin criterion](docs/img/review_hemoglobin.png)

---

## The problem

Eligibility criteria are decided largely from precedent and habit. Regeneron's own starter material describes protocol teams that "rarely get evidence-based feedback on their draft until it's too late to change cheaply." In July 2026 FDA finalized three oncology guidances on exactly these criteria: laboratory values, performance status, and washout periods. They state that "unnecessarily restrictive eligibility criteria may slow subject accrual, limit patients' access to clinical trials, and lead to trial results that do not fully represent treatment effects…"

But restrictions exist for reasons: patient safety, predictive or prognostic enrichment, reduced heterogeneity, interpretability. "Loosen the criteria" misses most of the problem. The useful question is narrower: **which restrictions deserve reconsideration, and what evidence supports or contradicts each one?**

The evidence is scattered. For EMPOWER-Lung 3 (Regeneron, NCT03409614), the registry text never mentions a neutrophil threshold. The lab criteria exist only on page 67 of a 170-page protocol PDF, and comparable trials' thresholds sit in other sponsors' PDFs.

**Retrospective use of the 2026 guidance.** EMPOWER-Lung 3 and its comparators were designed years before FDA's July 2026 guidances. TrialLens applies that guidance as a present-day review standard. It does not judge what those teams could have known when they designed their trials.

### Worked example: EMPOWER-Lung 3 hemoglobin ≥10 g/dL

TrialLens examines the trial's own context before looking at peers:
- **Own arms.** The regimen contains carboplatin, cisplatin, paclitaxel and pemetrexed.
- **Own protocol.** Page 51 notes that grade 3–4 anemia was higher with pemetrexed.

A plausible safety rationale therefore exists. A toxicity rationale supports having *a* threshold, though, not this exact number, and the protocol does not say why 10 rather than 9 was chosen.

Among comparable trials started earlier:
- Three used ≥9 g/dL (CheckMate 9LA, CheckMate 227, KEYNOTE-042).
- One (eNERGY) used >10 g/dL.
- EMPOWER-Lung 1 (cemiplimab monotherapy vs platinum-doublet chemotherapy) and KEYNOTE-189 also used ≥9 g/dL. TrialLens did not select them as automatic comparators.

TrialLens classifies this as *Review recommended*: a clinical review question for the protocol team. It is **not** a finding that the threshold is a mistake or that it unjustifiably excludes patients.

Several things are not shown by this evidence:
- **Protocol version.** The posted protocol is Amendment 5, not necessarily the design-time version. Nothing here shows whether the threshold changed across amendments.
- **Influence from EMPOWER-Lung 1.** Nothing here shows that EMPOWER-Lung 1 shaped EMPOWER-Lung 3's design.
- **Optimal threshold.** No outcome data identify which threshold is best.

## Who it is for and where it fits

Clinical scientists, protocol authors, medical reviewers and cross-functional protocol-review teams. It fits **before protocol finalization**, as preparation for the protocol review meeting. TrialLens gathers and checks the evidence; the team decides.

## What it does

| Step | What happens | How |
|---|---|---|
| Ingest | NCT ID → ClinicalTrials.gov record + posted protocol PDF (cached) | Deterministic; registry text as a fallback |
| Extract | Hemoglobin, ANC, platelets, bilirubin, AST/ALT, renal function, ECOG, washouts, with operators, units, conditions (e.g. liver metastases) and the **verbatim source line and page** | Rule-based parser (handles tables, garbled PDF glyphs, image-only pages) |
| Regimen | Drugs in every arm, each with its source; agents unknown to the curated table are listed, never assumed harmless | Registry + protocol dosing context; curated class table |
| Comparators | Phase 3 trials in the same disease, setting and histology, with overlapping drug classes and posted protocols, **started before the reviewed trial** | Registry search, then the same extractor on their PDFs |
| Guidance | 32 passages from FDA's 2026 eligibility guidances and 2019 enrichment guidance, **verified verbatim against the PDFs** at startup, with section, page and line | Deterministic |
| Review | Each criterion: *Review recommended* / *Evidence supports retaining* / *Insufficient evidence*, plus likely scientific purpose (inferred), supporting, challenging and context evidence by tier, missing evidence, and a cautious next action | Transparent rules |
| Verify | Any recommendation (from a reviewer, a model, or a test case) is checked. **Factual** checks: source existence, verbatim quotes, values, units. **Clinical-logic** rules: regimen contradiction, direction, evidence sufficiency, overclaiming. Outcomes: *Supported*, *Supported with qualifications*, *Rejected*, *Needs medical review* | Deterministic |
| Packet | Exportable review packet (Markdown / printable PDF / JSON) with decision fields: accept / reject / **needs medical review** / defer | — |

Rules that keep the reasoning honest:
- A toxicity link supports having *a* threshold, never a specific value.
- A more permissive comparator shows a threshold was *used*, not that it was safe.
- Agreement among comparators may reflect template carry-forward (FDA lab guidance §II).
- When no comparable precedent exists, the answer is "Insufficient evidence", not "retain".

### Where AI is and is not used

The evidence engine is **deterministic and auditable**; it is not an autonomous AI scientist. A language model, when configured (the Chalk Model Gateway, or the Anthropic API), does two things:
- It critiques a flag, and may only *downgrade* it.
- It turns a reviewer's free-text challenge into structured claims, which then pass through the deterministic verifier.

Documents are treated as data. PDF text is never executed as instructions, the model has no tools or write access, and every displayed value links to its source page. This mitigates the OWASP prompt-injection and excessive-agency risks noted in Regeneron's mentor guidance.

![Verifier rejecting a plausible but invalid recommendation](docs/img/challenge.png)

## Chalk integration (what actually ran)

| Chalk capability | Role in TrialLens | Status |
|---|---|---|
| Features + online resolver | `Trial` features resolved live from ClinicalTrials.gov inside Chalk. The dashboard shows, per trial, whether the registry even mentions lab thresholds (usually not), which is why TrialLens reads the PDF | **Deployed; online queries succeed from CLI and app** |
| Chalk Compute + Evaluations | The verifier runs as a Chalk function over 39 test cases; Chalk scorers grade it | **Ran:** evaluation `cmvco3m0n01dw01y520oc80sq`, run `e61fce6c-…`, SUCCEEDED, 0 task errors |
| Model Gateway (router) | LLM critic, free-text challenges, LLM-only baseline | Implemented; **awaiting router key** |

Details and reproduction: [CHALK.md](CHALK.md).

## Evaluation

All numbers are produced by scripts in `evals/` from official documents and hand-labelled answer keys. Gold labels are from a single annotator (the developer). **None of this is clinical validation.**

**A. Original protocols (19 real protocols: NSCLC, SCLC, TNBC, gastric, HCC, head & neck, renal)**

| Measure | Result |
|---|---|
| Criterion extraction, all labelled criteria | 122/128 correct; precision 97.6% (3 extracted values known wrong) |
| — development protocols | 54/55 |
| — held-out (outputs seen once, no changes) | 18/19 |
| — unseen set 1, **first run** | **15/21** → 21/21 after one fix (synopsis vs full eligibility section). The first-run number is the honest estimate. |
| — unseen set 2 (6 protocols, measured once, not tuned) | **29/33**; CASPIAN labs missed (wrong section), 2 KEYNOTE-048 table values wrong |
| Comparator threshold direction | 1780/1802 correct where both values were extracted (22 errors, all from the wrong extractions above) |
| FDA quotes verified verbatim / protocol source lines on cited page | 32/32 · 157/157 |
| Regimen (developer-curated reference) | precision 98.2%, recall 100% (12 protocols) |

**B. Planted-issue variants: synthetic modifications to authentic, previously unseen protocols** (method from Regeneron's *Trial by Design, Part 2*). One threshold was made stricter (24 variants) or looser (10) on the protocol's own source line, across 5 protocols, with unmodified controls. A stricter criterion is not assumed wrong. The test is whether TrialLens notices and **escalates it for evidence review**.

| Run | Planted value extracted | Discrepancy surfaced | Escalated "Review recommended" | Never "supports retaining" | Looser plants falsely flagged |
|---|---|---|---|---|---|
| First run | 23/24 | 18/24 | 18/24 | 23/24 | 0/10 |
| After fixes, historical comparators only | 24/24 | 14/24 | 16/24 | 24/24 | 0/10 |
| After fixes, all comparators (reviewing a draft today) | 24/24 | 24/24 | 22/24 | 24/24 | 0/10 |

The first run found three bugs:
1. Agents outside the drug table (axitinib, sunitinib) were treated as "no myelosuppressive agent".
2. SCLC trials received NSCLC comparators.
3. A harness bug left "1,500/µL" unmodified.

Some first-run escalations came from bugs 1 and 2, which is why the historical-cutoff numbers went *down* after fixing them. Remaining misses are protocols with no comparable precedent before their start date, where TrialLens correctly answers "Insufficient evidence". Unmodified controls: 14–17 of 42 criteria flagged, mostly from criterion-specific FDA recommendations (ECOG PS2, Duffy-null ANC); these are not counted as errors.

**C. Developer-designed verifier faults** (24 injected faults, 10 valid/cautious, 5 ambiguous)

| Verifier | Faults rejected | Valid rejected | Ambiguous flagged |
|---|---|---|---|
| None (baseline) | 0/24 | 0/10 | 0/5 |
| Deterministic, local | 24/24 | 0/10 | 5/5 |
| Deterministic, **on Chalk Compute** | 24/24 | 0/10 | 5/5 |

The cases and the verifier were written by the same developer, and most faults are factual (misquotes, wrong values) rather than clinical reasoning errors. Treat this as a test of designed behaviour, not of robustness.

**D. Model-based evaluations:** not yet run (no model credentials at the time of writing). `python -m evals.run_evals --llm` adds the LLM-only verifier baseline when a key is present.

## Quick start (clean clone)

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/). `pdftotext` (poppler) is used if installed, pypdf otherwise.

```bash
uv sync --group dev
uv run python -m trialforge.sources NCT03409614 NCT03088540 NCT02578680   # fetch + cache source documents (first run: ~1 min)
uv run uvicorn trialforge.api:app --port 8765                             # open http://localhost:8765
uv run pytest -q tests/                                                   # 13 invariants
uv run python -m evals.run_evals                                          # A + C (downloads ~19 protocols on first run)
uv run python -m evals.planted.make_variants && uv run python -m evals.run_planted   # B
```

Optional: `CHALK_ROUTER_API_KEY=...` (Chalk Model Gateway) or `ANTHROPIC_API_KEY=...` in `.env` enables the LLM critic and free-text challenges. Never commit `.env`.

Third-party documents (protocol PDFs, FDA PDFs, NHANES files) are downloaded from their official sources at runtime and are not redistributed in this repository.

## Repository layout

| Path | Contents |
|---|---|
| `trialforge/` | Engine: `sources`, `extract`, `druglib`, `comparators`, `guidance`, `review`, `verifier`, `packet`, `llm`, `chalk_bridge`, `nhanes`, `api` (the Python package keeps its original name) |
| `web/` | Dashboard (vanilla JS, no build step) |
| `evals/` | Gold labels, verifier cases, planted-issue generator, answer key, and runners |
| `chalk_project/` | Chalk feature store and Chalk Evaluation bundle |
| `docs/` | Demo script, Devpost text, deck, screenshots, [teammate onboarding](docs/TEAMMATE_ONBOARDING.md), [evidence-graph/agent plan](docs/EVIDENCE_AGENT_PLAN.md) |
| `tests/` | Unit invariants |

## Limitations

- **Protocol versions.** Protocol PDFs on ClinicalTrials.gov are usually the final amendment, not the design-time draft (EMPOWER-Lung 3's posted protocol is Amendment 5). TrialLens does not track amendment history, so it cannot say whether or why a threshold changed.
- **Retrospective guidance.** FDA's July 2026 guidances post-date most reviewed trials and are applied retrospectively; FDA citations are marked "retrospective" when issued after the trial's start date.
- **Coverage.** Only about 28% of recent phase 3 oncology trials post one.
- **Extraction.** It is rule-based and misses unusual layouts; known failures are listed in the Evaluation tab.
- **Drug table.** The pharmacology table is curated at class level and not re-verified against current labels.
- **Purpose tags.** These are inferred, not read from the protocol.
- **Classification.** It is a transparent heuristic, not a validated model, and no clinician has reviewed the outputs.
- **Gold labels.** Single annotator.
- **NHANES panel (secondary).** It describes the US general population, not people with cancer. Race/ethnicity is not a proxy for Duffy-null phenotype.

**Claims TrialLens does not make:**
- That any threshold is safe to change.
- That a threshold differing from peer trials is a mistake.
- That one trial's results caused another trial's design choices.
- That a change would improve enrollment, timelines or cost.
- That any output is clinically validated.

## License

MIT (see [LICENSE](LICENSE)). Third-party data remains under its own terms.
