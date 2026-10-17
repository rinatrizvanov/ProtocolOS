# TrialLens: Every exclusion deserves evidence

**Tracks:** Regeneron "Reinvent Clinical Trials & Drug Development" · Chalk "Best Data-Driven Agent Built on Chalk"

## Inspiration
Eligibility criteria decide who can join a trial, and they are mostly written from precedent and habit. Regeneron's starter material describes protocol teams that rarely get evidence-based feedback before a draft is locked. In July 2026 FDA finalized three oncology guidances on exactly the criteria that are most often templated: laboratory values, performance status and washout periods.

Restrictions also exist for good reasons: safety, enrichment, statistical power. So "loosen everything" is the wrong answer. We wanted a tool that helps a protocol team see *which* restrictions deserve reconsideration, and what evidence says so.

## What it does
TrialLens takes an oncology trial's NCT ID and reads the real protocol PDF posted to ClinicalTrials.gov. That matters: for Regeneron's EMPOWER-Lung 3 the registry never mentions the neutrophil threshold, which lives only on page 67 of the protocol.

For each lab, performance-status and washout criterion it:
- **Quotes the exact protocol line and page.**
- **Identifies the regimen in every arm**, and flags agents its drug table doesn't know.
- **Finds comparable trials automatically**: same disease, setting and histology, overlapping drug classes, started before the reviewed trial. It parses their protocols and compares thresholds, checking whether each comparator's regimen covers the same toxicity-relevant drug classes.
- **Cites FDA guidance** verified word-for-word against the official PDFs, with section, page and line.
- **Classifies the criterion** as *Review recommended*, *Evidence supports retaining* or *Insufficient evidence*. It shows supporting, challenging and context evidence by tier (protocol, peer precedent, regulatory guidance, curated pharmacology), the likely purpose of the restriction (labelled as inferred), what evidence is missing, and a cautious next action.
- **Lets a reviewer challenge any recommendation.** A verifier separates factual checks (source exists, quote matches, value correct) from clinical-logic rules (e.g. you can't relax a neutrophil floor because the PD-1 drug isn't myelosuppressive when the other arms contain carboplatin and paclitaxel). Outcomes include *Needs medical review*.
- **Exports a review packet** for the protocol meeting, with a decision for each criterion (accept / reject / needs medical review / defer).

On EMPOWER-Lung 3, TrialLens finds that three comparable PD-1 + chemotherapy trials used hemoglobin ≥9 g/dL while EMPOWER-Lung 3 used ≥10. One academic trial (eNERGY) also used 10, and the protocol itself discusses higher anemia with pemetrexed. It surfaces that as a review question, not a recommendation to change the threshold.

## How we built it
- **Python engine:** fetches and caches registry records and protocol PDFs; rule-based, page-anchored extraction (it handles tables, Symbol-font glyphs and image-only pages); a curated drug-class table; registry-driven comparator discovery; verbatim-verified FDA passage index; transparent classification; deterministic verifier; review-packet export.
- **FastAPI** backend and a no-build vanilla-JS dashboard.
- **NHANES** survey-weighted lab distributions as secondary, clearly labelled general-population context.
- **Chalk:**
  - A deployed `Trial` feature set whose resolver pulls ClinicalTrials.gov records inside Chalk. The dashboard queries it live to show whether the registry even contains the thresholds.
  - The verifier runs as a **Chalk Compute** function graded by **Chalk Evaluations** (39 cases, run succeeded, 0 task errors).
  - The **Chalk Model Gateway** is wired for the optional LLM critic and free-text challenges.

The evidence engine is deterministic on purpose: every output can be traced to a source. Any model output can only downgrade a flag and must pass the verifier.

## How we evaluated it
- **Real protocols.**
  - 122/128 hand-labelled criteria extracted correctly across 19 protocols.
  - The first run on unseen protocols scored 15/21, kept on record; a fix brought it to 21/21.
  - A second unseen set of six protocols scored 29/33 on its only run.
  - FDA quotes 32/32 verbatim.
- **Planted issues** (the Regeneron starter-sheet method). We made thresholds stricter on 5 real, previously unseen protocols (24 variants) and checked whether TrialLens escalates them for review:
  - 24/24 never classified as "supports retaining".
  - 16–22/24 explicitly escalated, depending on whether precedent is limited to trials that started earlier.
  - 0/10 loosened thresholds falsely flagged.
  - The first run exposed three bugs, which are documented.
- **Verifier:** 24/24 developer-designed faults rejected and 0/10 valid recommendations rejected, both locally and on Chalk. We say clearly that the developer wrote both the faults and the verifier.

## Challenges
- Protocol PDFs are messy: wrapped table cells, Symbol-font glyphs instead of ≥ and µ, image-only pages, and synopsis sections that look like eligibility sections.
- Comparator relevance: a "small cell lung cancer" search also returns non-small-cell trials, which is a different disease.
- Absence of evidence: a drug missing from our table must not count as "no toxicity". The planted-issue test caught us doing this.
- Chalk's feature-serving runtime needs pydantic < 2 while our web app needs 2, so we isolated the feature deployment.

## Accomplishments we're proud of
A working pipeline on real Regeneron, Merck, BMS and Roche protocols, where every value links to its source page. Evaluation numbers we didn't tune away. A verifier that rejects a plausible-but-wrong argument whose premise is true.

## What we learned
Eligibility criteria are trade-offs (safety, enrichment, heterogeneity), not obstacles. A peer trial's looser threshold is precedent, not proof. And the most useful output for a clinical team is a defensible question with evidence, not an answer.

## What's next
- Run on internal draft protocols with internal precedent (past amendments, lessons learned).
- Learn from the accept/reject decisions teams record.
- Read structured protocols (ICH M11 / CDISC USDM) instead of PDFs.
- Get clinician review of the classification rules.

## Built with
Python, FastAPI, pandas, pypdf/poppler, ClinicalTrials.gov API v2, FDA guidance PDFs, NHANES, Chalk (features and resolvers, Compute, Evaluations, Model Gateway), vanilla JavaScript.

**Not clinical, regulatory or safety advice.** TrialLens is a research prototype.
