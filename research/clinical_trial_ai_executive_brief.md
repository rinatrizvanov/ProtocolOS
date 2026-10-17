# Executive Brief — Clinical-Trial AI for HackHarvard 2026

**Build:** an **Eligibility-Criteria Accrual-Risk Auditor**. Input: a protocol's eligibility text or NCT ID. Output: structured criteria, a back-tested accrual-failure risk score, the specific criteria driving it, comparable *earlier* trials with looser criteria, and FDA-guidance citations. Scored against baselines on a temporal held-out set of real trials. Not a generic "protocol analysis agent."

**Build order matters:** the evidence/guidance linter (extraction → comparables → FDA citations) is the core. Build it first, then add the risk score on top. Prediction is a supporting signal, not the headline: on my test, length + metadata reached only AUROC 0.58.

**Why this, not the alternatives** (score /100, judgment ±5; A's lead over the Linter is within noise, so A wins because it contains the Linter): Accrual-Risk Auditor **75** · Criteria/Guidance Linter 67 (low-risk fallback) · original protocol-analysis agent 65 · open Trial-Pathfinder emulation 63 (best upside, needs EHR we can't get) · trial matching 63 (TrialGPT + Deep 6/Tempus already cover it) · site accessibility 58 · amendment risk 50 (data closed). The original idea has no measurable target and overlaps Faro/Citeline/Medidata drafting tools.

**Strongest evidence**
- NCI Phase II/III trials (n=1,197, 2008–18): 19.3% failed to accrue; failure rose 11.8% → 29.4% from shortest to longest criteria decile; criteria length roughly doubled over the decade. Retrospective, confounded. [Peterson 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC9972031/)
- Insufficient accrual is the leading documented reason for termination: 39% of all 905 terminated trials, and 57% of non-data-driven ones (Williams 2015, full text checked). [PMC4444136](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4444136/)
- Trial Pathfinder (Nature 2021, 61,094 EHR patients, 10 NSCLC trials): relaxing ~9 criteria, mostly lab thresholds, doubled the eligible pool (+107%) with an average OS hazard-ratio change of −0.05. [PMC9007176](https://pmc.ncbi.nlm.nih.gov/articles/PMC9007176/)
- FDA finalized three oncology guidances on July 27, 2026: performance status, washouts/concomitant meds, and lab values (per trade press). [RAPS](https://www.raps.org/resource/fda-finalizes-three-guidances-to-broaden-cancer-clinical-trial-eligibility.html)
- A delay day costs ~$800k in lost sales plus ~$40k in direct trial cost for Phase II/III (Tufts 2024 PDF, read directly).
- My own data (2,125 Ph2/3 cancer trials): longer criteria still predicted accrual failure after adjusting for phase, sponsor and year (coef +0.19, CI +0.04 to +0.34). A 25-label audit found ≈84% label precision.

**Biggest uncertainty:** whether LLM-extracted criterion categories beat a **0.58 AUROC** length + metadata baseline (words only 0.57, metadata only 0.56, temporal test n=653). Also: ClinicalTrials.gov overwrites planned enrollment with actual for terminated trials (97.9% ACTUAL in my sample), so labels come from free-text `WhyStopped`, and design-time eligibility text isn't recoverable (history endpoints returned 403/404). Chalk's point-in-time queries protect comparables and labels, not text versions. Also unverified: Regeneron track criteria (page lists none), Chalk sandbox/eval enablement for hackathon accounts, and any buyer demand (no customer research done).

**Datasets:** ClinicalTrials.gov API v2 (no key; 607k studies; works now). Optional: AACT (signup), PubMed, FDA OCE guidance text, TrialBench (Zenodo).
**Chalk components:** `chalkpy` features + Python resolver for `Trial`; offline `input_times` for cutoff-safe comparables; Sandbox with egress allowlist + `knowledge_cutoff`; Model Gateway for LLM calls/judge; `chalkcompute.Evaluation` with datasets and scorers (`numeric_close`, `json_match`, `llm_judge`, custom citation checker); traces. Judging: "impact, use of data, how rigorously you evaluate."

**Build / pivot / abandon:**
- **Build:** feature prediction if it beats 0.58 by ≥0.03 with a CI above zero (test within ~4h).
- **Pivot:** if lift ≈ 0, keep the Linter as the product and show prediction only as an honest scoreboard.
- **Abandon:** drop the accrual-label claim if label precision falls below 70%. Exclude sponsor-strategy phrasing, the failure mode the audit found.

**First 2 hours:**
1. `chalk login`, ask Slack whether Compute/sandboxes/Evals are enabled and which gateway models exist; deploy one `Trial` resolver.
2. Pull ~5k oncology Ph2/3 trials from the API to JSON; fix the criteria schema.
3. Build labels + temporal split (train ≤2015, test 2016–19) and fit the length baseline for a first AUROC.
4. Start hand-labeling 30 trials' criteria for extraction gold, split across the team.

**Never claim:** causal speed-ups, dollar savings, clinical validity, or "true recruitment performance."

Full detail and sources: `research/clinical_trial_ai_opportunity_deep_dive.md`
