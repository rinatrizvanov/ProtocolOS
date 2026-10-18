# ProtocolOS: Every exclusion deserves a rationale

ProtocolOS (formerly TrialLens).

**Tracks:** Regeneron "Reinvent Clinical Trials & Drug Development" · Chalk "Best Data-Driven Agent Built on Chalk"

**Try it:** https://protocolos-web.vercel.app (guided demos: `/tour` and `/tour/draft`) · API: https://protocolos-api-production.up.railway.app (`/docs`) · Code (MIT): https://github.com/rinatrizvanov/ProtocolOS

## Inspiration
Eligibility criteria decide who can join a trial, and they are mostly written from precedent and habit. Regeneron's starter material describes protocol teams that rarely get evidence-based feedback before a draft is locked, and late changes are expensive: Getz et al. (2016) found that 57% of protocols had at least one substantial amendment, and 45% of those amendments were judged avoidable. FDA's final guidance (July 2026) on laboratory values, performance status and washout periods says lab restrictions from earlier trials "should not be carried forward automatically". When ProtocolOS reviews older trials, it applies this guidance retrospectively as today's review standard and labels it that way. It is not a judgment of what those trials' designers could have known.

Restrictions also exist for good reasons: safety, enrichment, statistical power. So "loosen everything" is the wrong answer. We wanted a tool that shows a protocol team the rationale behind each restriction, which ones deserve a second look, and what the public record says about each.

## What it does
ProtocolOS has two modes.

**Finishing a trial** (review an existing protocol). Enter an oncology trial's NCT ID; ProtocolOS reads the real protocol PDF posted to ClinicalTrials.gov. That matters: for Regeneron's EMPOWER-Lung 3 the registry never mentions the neutrophil threshold, which lives only on page 67 of the protocol. For each lab, performance-status and washout criterion it shows:
- **Rationale:** badges for the likely rationale (safety, efficacy enrichment, regulatory precedent; labelled as inferred) and an arm line saying which arm (investigational or comparator) drives a safety rationale. The exact protocol line and page are quoted.
- **Compare:** earlier comparable trials (same disease, setting and histology, overlapping drug classes, started before the reviewed trial) and the threshold each used, with regimen coverage.
- **Ask:** questions such as "Why was it flagged?", answered from the evidence graph; every statement is checked against the sources.
- **Redraft workspace:** type a new limit and a one-line rationale; the deterministic verifier re-runs as you type and flags any mismatch with precedents or FDA guidance. (The guided tour's Verify step shows the verifier rejecting a made-up citation.)
- **Decide:** a decision per criterion with a structured reason (safety concern, regulatory requirement, efficacy enrichment, prior trials, operational reason, other), and an exportable review packet for the protocol meeting.

Each criterion is classified *Review recommended*, *Rationale supports keeping* or *Insufficient evidence*. On EMPOWER-Lung 3 (hemoglobin ≥10 g/dL), ProtocolOS first looks at the trial itself: every arm includes chemotherapy, and the protocol (p. 51) notes higher grade 3–4 anemia with pemetrexed, so a plausible safety rationale exists. A toxicity rationale supports having *a* threshold, not this exact number. Among earlier comparable trials, CheckMate 9LA, CheckMate 227 and KEYNOTE-042 used ≥9 g/dL and eNERGY used >10. The result is *Review recommended*: a review question for the team, not evidence that the threshold was a mistake. The posted protocol is Amendment 5, so ProtocolOS makes no claim about how the threshold evolved.

**Create criteria from an idea** (a new trial concept). Enter a condition, drugs, setting, phase and a cutoff date. ProtocolOS finds comparable trials that started before the cutoff and drafts each criterion only from a verified precedent; with none, the criterion is *Insufficient evidence* and gets no value. Each draft shows its checks and "Why this value", a self-critique flags the drafts that deserve review, and a before/after compares the draft with a real protocol. The preset "EMPOWER-Lung 3 at design time" drafts from EMPOWER-Lung 3's own idea at its start date, with its own protocol left out, and then compares the draft with the protocol as written.

## How we built it
- **Python engine (FastAPI):** fetches and caches registry records and protocol PDFs; rule-based, page-anchored extraction (tables, Symbol-font glyphs, image-only pages); a curated drug-class table; registry-driven comparator discovery; an FDA passage index verified verbatim against the official PDFs; transparent classification; a provenance graph with score attribution; a bounded investigator whose answers pass an answer checker; a draft module built on the same comparators, extractor, guidance index and unchanged verifier; review-packet export; a public-demo guard.
- **Next.js app** (primary UI) with both modes and two guided demos, deployed on Vercel; the engine and a vanilla-JS dashboard run in one container on Railway.
- **NHANES** survey-weighted lab distributions as secondary, clearly labelled general-population context.
- **Chalk:**
  - A deployed `Trial` feature set whose resolver pulls ClinicalTrials.gov records inside Chalk; the app queries it live to show whether the registry even contains the thresholds.
  - The verifier runs as a **Chalk Compute** function graded by **Chalk Evaluations** (39 cases, run succeeded, 0 task errors).
  - The **Chalk Model Gateway** powers the optional model mode: a model may only downgrade a flag, and every statement passes the deterministic checks. The public deploy stays deterministic.

The evidence engine is deterministic on purpose: every output can be traced to a source page, and the verifier is the authority over any model output.

## How we evaluated it
All numbers come from committed result files in the repository; gold labels are from a single annotator. None of this is clinical validation.
- **Real protocols:** 122/128 hand-labelled criteria extracted correctly across 19 protocols. The first run on unseen protocols scored 15/21, kept on record; a fix brought it to 21/21. A second unseen set of six protocols scored 29/33 on its only run. FDA quotes 32/32 verbatim.
- **Planted issues** (the Regeneron starter-sheet method): we made thresholds stricter on 5 real, previously unseen protocols (24 variants). 24/24 were never classified as "Rationale supports keeping"; 16–22/24 were explicitly escalated, depending on whether precedent is limited to trials that started earlier; 0/10 loosened thresholds were falsely flagged. The first run exposed three bugs, which are documented.
- **Verifier:** 24/24 developer-designed faults rejected and 0/10 valid recommendations rejected, both locally and on Chalk Evaluations. The developer wrote both the faults and the verifier.
- **Investigator answer checker** (local evaluation `protocolos-investigator`): 336/336 planted defects rejected (unknown trial IDs, changed numbers, causal phrases, misquotes, dropped counter-evidence, injected instructions), 44/44 of the investigator's own answers not rejected. The developers wrote both the mutants and the checker.
- **Drafting, leave-one-out** on 4 cached trials (each drafted from its own idea at its start date, itself excluded): 0 criteria drafted without a verified precedent, 0 overclaim failures, and 22/31 drafted values equal to the trial's own value. Agreement shows a value was used before, not that it is right.

## Challenges
- Protocol PDFs are messy: wrapped table cells, Symbol-font glyphs instead of ≥ and µ, image-only pages, and synopsis sections that look like eligibility sections.
- Comparator relevance: a "small cell lung cancer" search also returns non-small-cell trials, which is a different disease.
- Absence of evidence: a drug missing from our table must not count as "no toxicity". The planted-issue test caught us doing this.
- Drafting without inventing: a drafted value must come from a verified precedent, never from a guess or a model.
- Chalk's feature-serving runtime needs pydantic < 2 while our web app needs 2, so we isolated the feature deployment.

## Accomplishments we're proud of
A deployed, working pipeline on real Regeneron, Merck, BMS and Roche protocols, where every value links to its source page. Two modes that share one deterministic verifier. Evaluation numbers we didn't tune away. A verifier that rejects a plausible-but-wrong argument whose premise is true.

## What we learned
Eligibility criteria are trade-offs (safety, enrichment, heterogeneity), not obstacles. A peer trial's looser threshold is precedent, not proof. The most useful output for a clinical team is a defensible question with its rationale, not an answer. And the blind spot has to be said out loud: rationale in non-public sources (preclinical toxicology, internal development data, regulator correspondence) cannot be seen by ProtocolOS.

## What's next
- Run on internal draft protocols with internal precedent (past amendments, lessons learned), inside the sponsor's own environment.
- Read structured protocols (ICH M11 / CDISC USDM) instead of PDFs.
- Get clinician review of the classification rules and the drafting rules.
- Run the `protocolos-investigator` evaluation on Chalk and add a model-based baseline.

## Built with
Python, FastAPI, pandas, pypdf/poppler, Next.js, React, Tailwind CSS, ClinicalTrials.gov API v2, FDA guidance PDFs, NHANES, Chalk (features and resolvers, Compute, Evaluations, Model Gateway), Railway, Vercel.

**Not clinical, regulatory or safety advice.** ProtocolOS is a research prototype; the team decides.
