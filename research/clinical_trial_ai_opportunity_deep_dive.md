# Clinical-Trial AI Opportunity Deep Dive (HackHarvard 2026)

Research date: 2026-10-17. Method: skeptical, time-boxed desk research. Live ClinicalTrials.gov API queries (read-only), ~8 web searches/fetches by me, plus two delegated sub-researchers (Chalk/HackHarvard docs; competitor landscape). The Venture Scout skill's financial-model pipeline was **not** run (this is a hackathon-scoping task, not a startup financial model); its evidence rules were applied: **[Verified]** = seen in a cited source or my own query this session; **[Inferred]** = reasoned from that; **[Unverified]** = needs checking.

**Source caveat:** the first pass took many web facts from search-result summaries. A review pass (§11) re-checked the load-bearing ones against primary sources and corrected four errors. Competitor claims are still mostly vendor marketing. Citeable primary pages are listed in §10.

---

## 1. Executive decision summary

**Do not build a generic "protocol analysis agent."** It is the weakest-differentiated version of the idea: protocol drafting/optimization is already marketed by Faro, Citeline, Medidata, Formation Bio and Phesi, and a chat-style analysis has no testable output.

**Build instead: an *Eligibility-Criteria Accrual-Risk Auditor*** — paste a protocol's eligibility section (or an NCT ID) and the agent (1) extracts criteria into a structured schema, (2) retrieves comparable *earlier* trials from ClinicalTrials.gov, (3) estimates accrual-failure risk and *which specific criteria* drive it vs. a transparent baseline, and (4) proposes evidence-cited relaxations (comparable trials that enrolled with looser criteria; FDA oncology eligibility guidance). It is evaluated on a **temporal held-out set of real terminated/completed trials** against a simple criteria-length baseline.

Why this wins:
- **Real, documented, costly problem.** Low accrual is the leading documented termination reason; eligibility content has grown ~2x in a decade among NCI trials, and accrual failure rises with it (§2).
- **FDA just finalized guidance saying restrictive eligibility slows accrual.** The July 2026 finals cover performance status, washout periods/concomitant medications, and laboratory values — the same lab thresholds Trial Pathfinder found could be relaxed with little survival effect. That makes a timely hook for the Regeneron track.
- **Measurable.** Chalk judges on "impact, use of data, and how rigorously you evaluate" — this concept has a real label (terminated for accrual) and a baseline to beat or honestly fail to beat.
- **Public data suffices** (ClinicalTrials.gov API v2). Competitors' equivalent data (EHR, Medidata/Citeline) is closed.

**Honest caveat:** *design-time text is not recoverable* from the public API, and **the predictive signal is weak**. On my temporal test set (653 trials), criteria length alone reached AUROC 0.57, metadata alone 0.56, and both together 0.58 (§4). Treat prediction as a supporting signal, not the product. The pitch must be "criterion-level risk-flagging + evidence retrieval, with an honest scoreboard," never "predicts recruitment" or "saves $X."

**Build order follows from that:** the Guidance/Precedent Linter (concept G) is the core of A — extraction, comparables, guidance citations. Build it first, then layer the risk model on top. If the model adds no lift, the linter still ships.

Ranked options (details §5; A's lead over G is within the ±5 scoring noise, so the choice rests on A containing G, not on the points): **A. Accrual-Risk Auditor 75** · G. Criteria–Guidance/Diversity Linter 67 (low-risk) · B. Original protocol-benchmark agent 65 · C. Open Trial-Pathfinder-style emulation 63 (highest upside, data-blocked) · D. Explainable matching 63 (crowded) · E. Site accessibility 58 · F. Amendment risk 50 (avoid).

---

## 2. Problem / gap map

Bottleneck evidence (population, period, definition noted). Rows 1, 2, 4 and 5 were re-checked against primary sources in the review pass; rows 3 and the Tufts complexity figures in row 2 still rest on press coverage.

| # | Bottleneck | Stakeholder / stage | Evidence | Label |
|---|---|---|---|---|
| 1 | **Accrual failure / termination for low enrollment** | Sponsor, trial ops; design → recruitment | Williams 2015 (PLoS ONE; data pulled Feb 2013, 97% with primary completion ≤ Dec 2011): ~12% of 7,646 trials with posted results were terminated (905). Two raters coded `WhyStopped` (κ=0.86). Insufficient accrual was 57% (350/619) of terminations for *non-data-driven* reasons, and 39% (350/905) of all terminations. A 2010–21 GlobalData analysis gives 25.4%; denominators differ. NCI-affiliated Phase II/III trials started 2008–18 (n=1,197): 19.3% failed to accrue ([Peterson 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC9972031/)). | Verified (ranges 25–57% depending on denominator) |
| 2 | **Eligibility criteria growth & restrictiveness** | Protocol authors, medical monitors; design | Peterson 2023: unique content words in criteria rose from median 214 (2008) to ~417 (2018); accrual failure 11.8% (shortest decile) → 29.4% (longest); adj. OR 1.09/decile (1.03–1.15); retrospective, residual confounding, NCI-only. Tufts (secondary source): typical Ph III 50 criteria in 2012 vs 31 in 2002. Trial Pathfinder (Liu et al., Nature 2021; Flatiron EHR, 61,094 aNSCLC patients, 10 Phase III trials emulated): data-driven relaxation of ~9 rules on average raised eligible patients from 1,553 to 3,209 (+107%), and the overall-survival HR fell by 0.05 on average. Three other cancers gave +53% with HR −0.13. Lab thresholds (bilirubin, platelets, hemoglobin, alkaline phosphatase) were among the criteria with little effect. | Verified (association; Pathfinder full text read); causal effect Unverified |
| 3 | **Site under-performance** | Sponsor/CRO; site selection | Tufts 2013: of ~16,000 sites in 150+ trials, 11% enrolled zero, 37% under-enrolled, 39% met, 13% exceeded targets. 2012 data — old. | Verified but dated |
| 4 | **Protocol amendments** | Sponsor; during trial | Getz et al., Ther Innov Regul Sci 2016 (Tufts; 836 Phase I–IIb/IV protocols for prevalence, 52 for cost): 57% had ≥1 substantial amendment, 45% judged avoidable; median direct cost $141k (Ph II) / $535k (Ph III) per amendment. A "76%" later figure appears only in secondary sources. | Verified from abstract (full text paywalled, 403); 76% Unverified |
| 5 | **Cost of delay** | Everyone | Tufts CSDD white paper (Aug 2024), read directly: ~$800k lost prescription sales per delay day (legacy $4–5M called "a gross overestimate"). Direct trial cost per day ~$40k mean for Phase II/III; Phase III $55,716, Phase II $23,737, Phase I $7,829. | Verified (primary PDF) |
| 6 | **Under-representation from exclusions** | Regulators, sponsors | Two FDA waves. **2020-era finals** (drafted March 2019 with ASCO/Friends): brain metastases; HIV/HBV/HCV (final 2020 confirmed); organ dysfunction and prior malignancies; minimum age. Final dates for the others are Unverified. **July 27, 2026 finals** (FDA OCE; RAPS/OncLive/ASCO Post): performance status (include ECOG 2 unless justified), washout periods and concomitant medications, and laboratory values. I did not read FDA's own guidance pages. | Verified (trade press) |
| 7 | **Patient-to-trial matching** | Sites, patients | Real but crowded (§3). | Verified, commoditized |
| 8 | **Fragmented data / outcome prediction** | Analysts | HINT/SPOT/TrialBench predict success/failure from ClinicalTrials.gov; they don't say *what to change*. | Verified (via search) |

**Cause separation (important):** accrual failure has design causes (eligibility, burden, endpoints), operational causes (site activation, staffing, competing trials), and market/biology causes (rare disease, sponsor strategy: ~17% of terminations mention sponsor/business/funding in my query). Only the first is addressable from the protocol text — and even it is confounded by tumor type, phase, and competing trials. An AI tool can *flag design risk*, not guarantee faster recruitment.

**Top gaps (ranked by evidence × addressability):**
1. Criteria → accrual-risk with *criterion-level* attribution and recommended relaxations; no open validated tool found (Verified absence in my search; the NCI paper used logistic regression/XGBoost on text features only).
2. Open, non-EHR approximation of Trial Pathfinder criterion-impact analysis (needs EHR; blocked).
3. Cross-checking criteria against newly finalized FDA broadening guidance (timely, low-data).
4. Comparable-trial benchmarking with citations (vendors do this in closed data).
5. Temporal, leak-free benchmark of accrual-failure prediction (HINT-family weak on oncology per search summary of arXiv 2411.17595).

---

## 3. Competitor and white-space analysis

(From the competitor sub-agent, WebSearch-only; vendor numbers are self-reported. "Not shown" ≠ "doesn't exist.")

| Product | What it actually does | Doesn't demonstrably do | Data / access |
|---|---|---|---|
| **TrialGPT** (NIH) | Patient-note → trial retrieval, criterion-level matching, ranking. Evaluated on 183 synthetic patients (SIGIR + TREC 2021/2022). 87.3% criterion accuracy on 1,015 patient-criterion pairs vs 88.7–90.0% experts. The 42.6% screening-time reduction comes from a pilot of 6 oncology trials, 6 semi-synthetic vignettes and 2 physicians. Authors note no EHR, lab or structured-data testing. | Design/feasibility (opposite direction); real-EHR performance | Open paper/code |
| **Trial Pathfinder** (Nature 2021) | Emulated 10 completed aNSCLC Phase III trials on 61,094 Flatiron EHR patients; per-criterion effect on OS hazard ratio (numbers in §2) | Productized; works outside a few cancers; open data | Proprietary EHR |
| **TriNetX** | Cohort counts for feasibility across vendor-claimed 250M+ EHR records; site lists | Free-text criteria; auto-translating protocols into queries (analyst-assisted) | Licensed |
| **Deep 6 / Tempus** | Mines EMR (structured + text) to find eligible patients; acquired by Tempus (Mar 2025). Self-reported ≥25% more eligible patients | Independent evaluation; protocol-side feasibility | Closed |
| **Unlearn.AI** | EMA-qualified PROCOVA covariate adjustment (digital twins) | Anything about eligibility/enrollment | Closed |
| **Medidata** | Protocol simulation, site ranking, enrollment forecasting on its trial database; Claude connector exists | Independent accuracy evidence | Customers only |
| **IQVIA** | NVIDIA-based agents for site selection/recruitment | Details unverified | Closed |
| **Citeline** | Protocol SmartDesign (suggests criteria/endpoints), SmartSelect, Trial Health Calculator | Outcome evidence | Subscription |
| **Faro, Paradigm, Formation Bio (Muse), Phesi** | Protocol authoring; site/patient infrastructure; recruitment content; patient-burden scores | Independent outcome evidence | Closed |
| **Criteria2Query / OHDSI; arXiv 2502.21107** | Free-text criteria → OMOP cohort queries | Risk estimation | Open |
| **Academic**: Peterson 2023; TrialBench; HINT/SPOT; ClinicalReTrial; POET; CTBench | Accrual-failure association; benchmark datasets; outcome prediction; redesign/criteria-generation agents | Calibrated accrual-risk + criterion attribution + citations | Open (arXiv/Zenodo) |

**Verified gaps** (absence of public evidence in my search, not proof of absence): no public, temporally validated, criterion-level accrual-risk tool; no independent evaluation of vendor protocol-optimization claims.
**Hypothetical gaps:** that sponsors would pay for a standalone tool when they already license Citeline/Medidata (Unverified — **no customer interviews were conducted**).

**Avoid:** LLM patient matching (TrialGPT + commercial); EHR cohort counts (TriNetX); generic "chat with a protocol"; pure protocol drafting (Faro/Citeline/Formation); digital-twin stats (Unlearn); amendment-cost prediction (data closed); any claim of clinical validity or dollar savings.

---

## 4. Public data feasibility

All queries run 2026-10-17 against the live API (data timestamp 2026-10-16). Note: sample statistics here are exploratory.

### ClinicalTrials.gov API v2 — primary dataset
- Docs/API: https://clinicaltrials.gov/api/v2/studies (no key, JSON; `pageSize` ≤1000, `countTotal`, `fields`, `filter.overallStatus`, `filter.advanced=AREA[...]`). **Verified working.**
- Size: 607,349 studies. Interventional 463,466. Terminated 34,506 (29,957 interventional). Withdrawn 16,895. Completed interventional 259,970.
- `WhyStopped` text matches (regex-ish `accrual|enroll|recruit…`) among terminated: 10,682 (~31%); sponsor/business/funding/strategic: 5,814 (~17%). Free-text, so these are noisy upper-bound counts.
- Fields confirmed present: `OverallStatus`, `WhyStopped`, `EnrollmentInfo{count,type}`, `StartDateStruct`, `PrimaryCompletionDateStruct`, `Phase`, `EligibilityCriteria` (free text), `MinimumAge`, `Sex`, `LeadSponsorClass`, locations, conditions.

**Critical data limitations I verified or inferred:**
1. **Registered target vs actual enrollment is lost.** In my 1,500-trial terminated sample, 1,468 (97.9%) report `EnrollmentInfo.type = ACTUAL` — the planned target was overwritten. So "enrolled X% of target" **cannot be computed from the current record** for terminated trials. Labels must come from `WhyStopped` text. [Verified]
2. **No look-ahead-safe text.** Eligibility text in the API is the *latest* version, possibly edited after enrollment trouble (amendments). Version history exists on the website, but programmatic endpoints I tried (`/api/int/studies/{nct}/history`, `?history=true`) returned 403/404. [Verified failure; web-UI history Unverified]. Mitigation: treat the **temporal split on start date** as protecting against *label/comparable* leakage only, and disclose text-version leakage as a limitation.
3. **`WhyStopped` is missing for 9.5%** of terminated (142/1,500) and is free text, written by sponsors (selection bias, euphemism).
4. **No true recruitment rate.** No dated enrollment curve; only start, primary completion, final count.
5. Sponsor-class, industry trials report less.

### Exploratory empirical check (my own run)
Sample: 3,000 interventional Phase 2/3 cancer trials started 2008–2019, **1,500 COMPLETED + 1,500 TERMINATED (case-balanced — not population rates)**. Criteria complexity = count of bullet lines in `EligibilityCriteria` (480 trials with no parseable bullets excluded from this analysis). Share terminated with an accrual-like `WhyStopped` (regex) by bullet-count quartile:

| Quartile (bullets) | n | Terminated-for-accrual-ish % of sample |
|---|---|---|
| ≤11 | 678 | 17.1 |
| 12–19 | 591 | 20.6 |
| 20–30 | 652 | 23.3 |
| >30 | 599 | 23.4 |

Monotone but modest gradient, qualitatively consistent with Peterson (11.8%→29.4% across word-count deciles). **Not adjusted** for phase, tumor type, sponsor, era; regex labeling is noisy; sample is balanced by design. This is feasibility evidence that signal exists, not a finding. [Inferred]

Other: median bullets: industry 15, NIH 35, other 21 — sponsor type is a major confounder.

**Review-pass follow-up (adjusted model and temporal test).** Same sample, restricted to completed trials (0) vs. terminations whose `WhyStopped` matches accrual/enroll/recruit (1). Non-accrual terminations and missing reasons were dropped, leaving n=2,125 with 625 positives. Feature: log unique words in the criteria (Peterson-style, so no bullet-parsing exclusions).
- Logistic regression adjusted for phase, sponsor class (industry/NIH/other) and start year: the log-words coefficient is +0.19, bootstrap 95% CI +0.04 to +0.34. **The association survives this adjustment.** Industry sponsorship was the strongest covariate (−0.74).
- Temporal split (train start 2008–2015, test 2016–2019, test n=653), AUROC: **words only 0.572 · metadata only 0.559 · words + metadata 0.583.**
- Interpretation: there is a real but small signal. Any agent claim must beat roughly **0.58**, and the headline must stay modest. Tumor type was not adjusted for (`cancer` covers all sites), so this sets a lower bar than a tumor-adjusted baseline would.

**Label audit (25 random accrual-labelled `WhyStopped` strings).** About 21 of 25 were clearly accrual-driven. Two were wrong: sponsor discontinuation ("Discontinued development of rociletinib… stopped enrollment") and reprioritization ("terminated the study to prioritize enrollment in a randomized Phase 3"). Two were ambiguous: "recruitment will not recommence", and a mix of COVID and funding reasons. Precision is ≈84%, above the 70% abandon threshold. The regex must exclude sponsor/strategy phrasing, or an LLM classifier must replace it. Recall (accrual terminations the regex misses) was not checked.

### AACT
https://aact.ctti-clinicaltrials.org/ (redirects to a landing page; account-based Postgres/flat-file downloads — **Unverified**, did not sign up). Same underlying data as the API, but joins (eligibilities, outcomes, facilities) are easier and bulk pulls avoid API paging. Peterson et al. used AACT. Recommend API for the hackathon (no signup), AACT as optional bulk upgrade.

### Other datasets (not tested, status Unverified)
- TrialBench (Zenodo, 23 datasets) — pre-built ClinicalTrials.gov-derived tasks (per search summary).
- PubMed/PMC E-utilities — for citation grounding of rationale (not queried).
- FDA OCE eligibility guidances — text source for the guidance linter (I did not open FDA's pages).
- Census/CDC for geographic work — not examined.
- EHR/MIMIC-type data for Pathfinder-style emulation: credentialed access — **not available within 36 hours**.

### What the data can and cannot support
- Can: criteria-text features vs. accrual-like termination, with a temporal split; comparable-trial retrieval; guidance-based flags.
- Cannot: true recruitment rate, causal effect of any criterion, patient-level eligible-pool counts, per-site performance, amendment history.

---

## 5. Ranked AI solution concepts

Scores use the requested weights; they are **judgment calls with ±5 uncertainty**, not measurements, and were not produced by the Venture Scout scoring script. Missing evidence/inaccessible data is penalized explicitly. Two weaknesses to keep in mind: "Problem" and "Regeneron relevance" partly double-count, and no score rests on customer evidence.

**Review-pass change:** A was lowered from 78 to 75. Problem went 16→15 because the evidence is associational, and my adjusted effect is small. Demo went 16→14 because the prediction scoreboard will show an AUROC near 0.58, which is honest but not a dramatic number. The gap to G (8 points) sits inside the combined uncertainty. A stays first because it contains G: if prediction fails, A degrades to G rather than to nothing.

| Rank | Concept | Problem (20) | Demo (20) | AI need (15) | Chalk/eval (15) | Regeneron (10) | Data (10) | Impact (5) | Startup (5) | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **A. Accrual-Risk Auditor** | 15 | 14 | 11 | 13 | 8 | 7 | 4 | 3 | **75** |
| 2 | G. Criteria–Guidance & Representation Linter | 12 | 14 | 9 | 10 | 9 | 7 | 4 | 2 | 67 |
| 3 | B. Original protocol-benchmark agent | 12 | 14 | 9 | 9 | 8 | 7 | 3 | 3 | 65 |
| 4 | C. Open Pathfinder-style criterion-impact emulation | 17 | 6 | 13 | 8 | 8 | 3 | 4 | 4 | 63 |
| 4 | D. Explainable trial matching | 10 | 16 | 8 | 10 | 7 | 6 | 4 | 2 | 63 |
| 6 | E. Site/geographic accessibility optimizer | 9 | 15 | 6 | 9 | 6 | 7 | 4 | 3 | 58 |
| 7 | F. Amendment-risk analyzer | 14 | 3 | 10 | 6 | 8 | 2 | 3 | 4 | 50 |

**Per-concept (condensed):**

**A. Accrual-Risk Auditor (recommended).** *User:* clinical-operations / protocol-design lead, or academic PI. *Workflow:* LLM extracts criteria → schema (lab thresholds, comorbidity/prior-therapy exclusions, washouts, ECOG, brain mets, count); embeddings + metadata filters retrieve comparable earlier trials (same condition/phase, `start < cutoff`); a transparent model (logistic/GBM on structured features) outputs risk + top contributing criteria; agent writes rationale citing comparable NCT IDs and FDA guidance. *Data:* ClinicalTrials.gov API (open). *Demand:* Peterson 2023; FDA guidance; Tufts amendment/delay costs; **no direct customer evidence — Unverified.** *Alternatives:* Citeline SmartDesign, Medidata (closed, no independent evidence); academic regression. *Differentiation:* open, temporally validated, criterion-level, cited. *Demo:* paste an NCT of a held-out trial that was terminated for accrual; show flagged criteria, the 5 comparable trials with looser criteria, and the baseline-vs-agent scoreboard. *Limit:* label noise + text-version leakage + confounding. *36h:* feasible. *Post-hackathon:* pharma/CRO feasibility add-on — needs private protocols and customer validation.

**G. Guidance & Representation Linter (low-risk; also A's core).** Extract exclusions and check them against FDA broadening guidance. The 2020-era topics are brain mets, HIV/HBV/HCV, organ dysfunction/prior malignancy and minimum age; the 2026 topics are performance status, washout/concomitant meds and lab values. Report the % of comparable trials that exclude the same group. Easier; less predictive claim; weaker "AI necessity" and no prediction metric (eval = extraction accuracy + guidance-citation correctness).

**B. Original protocol-analysis agent.** Weak: no measurable target, crowded, hallucination-prone. Subsumed into A.

**C. Open Pathfinder-style emulation (highest upside).** Needs EHR; the only open stand-ins (synthetic data) would not support real claims. Do as roadmap, not demo.

**D. Explainable matching.** TrialGPT is open and strong; Deep 6/Tempus commercial. Differentiating requires prospective data we lack. Avoid as primary.

**E. Site accessibility.** CT.gov location data exists but site *performance* isn't public; analysis would be geographic descriptives (no AI necessity). Possible add-on map.

**F. Amendment risk.** Amendment data not public. Avoid.

**Best overall:** A. **Best low-risk:** G (or A with prediction removed). **Highest-upside ambitious:** C (data-blocked). **Strongest alternative if original is weak:** A already is; fallback = G.

---

## 6. Chalk integration and evaluation strategy

### Official facts (hhuh.io fetched by sub-agent)
- Prize: "Best Data-Driven Agent Built on Chalk" — "Build an agent that runs on real-world or contextual data, and prove it works." Judged on **impact, use of data, how rigorously you evaluate**. Requirement: use any part of Chalk "as long as it does real work." Highlights: sandboxes, AI Gateway, Federated Queries, Agent Evals. Prize: $1,500+ Apple Store credits, swag, new-grad interviews. Onboarding: chalk.ai/hackharvard + community Slack. No credits stated.
- **Regeneron track page shows only "Healthcare · presented by Regeneron" — no criteria, prize or requirements found.** [Unverified: check Devpost/Discord.]

### Chalk capability checklist
| Capability | Status | Source |
|---|---|---|
| Python `@features` classes, `@online` resolvers | Verified | docs.chalk.ai/docs/features, /what-is-chalk |
| SQL sources (Postgres, Snowflake, BigQuery, Databricks…) | Verified | docs.chalk.ai/docs/sql |
| REST as a native source | Unverified (Python resolvers can call any API) | — |
| Offline queries with `input_times` (latest value before each row's time) | Verified | docs.chalk.ai/docs/query-offline; param named `as_of`: not found |
| Sandboxes (`chalkcompute.Sandbox`, `knowledge_cutoff`, egress allowlist) | Verified (blog/docs); hackathon enablement Unverified | chalk.ai/blog/chalk-compute |
| Model Gateway (LLM judge needs no key; `chalk router model list`) | Verified; OpenAI-compatible endpoint Unverified | docs.chalk.ai/docs/evaluations/scorers |
| Hosted MCP server (66 tools incl. online query, SQL, traces) | Verified | docs.chalk.ai/docs/mcp-server |
| Evaluations (`chalkcompute.Evaluation`, datasets, 12 built-in scorers incl. numeric_close, json_match, llm_judge) | Verified | docs.chalk.ai/docs/evaluations/quick-start |
| Account / quotas / pricing | Unverified (`chalk login`; Slack) | — |

**Ask in Slack in hour 0:** are Compute/sandboxes + Evaluations enabled for hackathon accounts; Gateway model list/limits.

### Substantive architecture
**Real data → Chalk-powered agent → grounded decision → quantitative evaluation**

- **Entity `Trial` (key `nct_id`)** with features: raw fields (ClinicalTrials.gov resolver, Python `@online` calling the API or a Chalk SQL source over a Postgres load), derived features (LLM-extracted criteria schema; bullet counts; exclusion categories), label features (`stopped_for_accrual`).
- **Point-in-time use (be precise about what it buys):** `input_times` / sandbox `knowledge_cutoff` set to the target trial's start date so retrieval/benchmarks only see trials with outcomes known by then. This guards comparables/labels. It does **not** recover historical eligibility text (§4).
- **Agent in a Chalk sandbox** calls tools: `get_trial_features`, `retrieve_comparables(cutoff)`, `score_risk`, `lookup_guidance`; LLM calls via Model Gateway; egress restricted to clinicaltrials.gov/PubMed.
- **Traces** show tool calls/queries per recommendation (judges can inspect).
- **Evaluation via `chalkcompute.Evaluation`**: dataset of held-out trials, task = agent function, scorers = `numeric_close`/`exact_match` (risk vs label), `json_match` (extraction vs gold), `llm_judge` (rationale groundedness, with a rubric), plus custom scorer for citation validity (do cited NCT IDs exist, are they pre-cutoff, do they contain the claimed criterion).

### Evaluation design (the core deliverable)
1. **Risk prediction (objective).** Population: interventional Phase 2/3 oncology trials (extend later), start 2008–2019, status COMPLETED or TERMINATED with `WhyStopped` populated or completed. Positive = terminated with accrual-related reason (label via LLM classification of `WhyStopped`, spot-checked on ~50 by hand). Split: train ≤2015 start, test 2016–2019 start (temporal). **Baselines:** (a) majority/prevalence; (b) criteria word-count logistic regression (Peterson-style; **0.572 AUROC** on my split); (c) metadata-only (phase, sponsor class, condition; **0.559**); (d) words + metadata (**0.583**). These numbers come from a single regex-labelled sample, so re-establish them on the team's final dataset. Metrics: AUROC, PR-AUC, calibration (Brier), top-decile lift. **Success** = agent features beat baseline (b) on AUROC with bootstrap CI excluding zero; **honest failure** = no lift → report that and pivot the claim to retrieval/linting.
2. **Extraction accuracy.** Hand-label ~30 trials' criteria into the schema (split across the team); metric = field-level F1.
3. **Comparable retrieval.** Precision@5 vs. a keyword baseline using hand-judged relevance on ~20 queries.
4. **Citation groundedness.** % cited NCT IDs that exist, predate cutoff, and contain the claimed property (automatic).
5. **Consistency.** Re-run same input 3×; report agreement of top flagged criteria.
6. **Case studies.** 3–5 held-out terminated trials: what the tool would have flagged.

**Confounders:** tumor type, phase, sponsor class, competing trials, era, rare disease, text-version leakage, label noise, survivorship (completed trials mostly not recorded as accrual-troubled). **Claims we must not make:** that relaxing criteria causes faster accrual; any dollar/time savings; clinical validity or safety of relaxing a criterion; that scores reflect "real recruitment performance"; generalization beyond oncology Phase 2/3 unless tested; any prospective use.

---

## 7. Recommended MVP and architecture

**A. Proposition.** *"An evidence-grounded auditor that reads a protocol's eligibility criteria, benchmarks them against comparable earlier trials, flags the criteria most associated with accrual failure, and cites precedents and FDA guidance for possible relaxations."* Target user: protocol author / clinical-ops lead. Not an LLM wrapper because the output is a calibrated, back-tested risk score from structured features and retrieved evidence, scored against baselines — the LLM only extracts and explains.

**B. MVP (essential only).** (1) Ingest ~3,000–10,000 oncology Ph2/3 trials via API; (2) LLM extraction → criteria schema; (3) retrieval of comparables with cutoff; (4) risk model + feature attribution; (5) rationale with citations; (6) one-page UI: NCT/paste box → risk gauge, flagged-criteria table, comparables list, eval scoreboard tab. *Real example:* pick a held-out Phase 3 oncology trial terminated for slow accrual (select from the data once the model is trained; I did not preselect one).

**C. Evaluation.** As §6.

---

## 8. Hackathon build and demo plan

**Sequence (36h)** (linter core before prediction, so a working product exists by H16 whatever the model does):
- H0–2: Chalk login + Slack questions; pull 5k trials to JSON; define schema; skeleton of Trial features/resolver. Deliverable: query a trial's features through Chalk.
- H2–8 (parallel): (W1) extraction prompt + gold labels (30 trials); (W2) label construction + temporal split + baselines; (W3) retrieval index; (W4) Chalk Evaluation harness skeleton with dummy task.
- H8–12: **linter core end to end** — extraction → comparables → guidance citations → citation-validity scorer in Chalk Evals.
- H12–16: risk model on extracted features vs the 0.58 baseline, attribution, rationale generation; run first full eval.
- H16–26: UI, traces, case studies, guidance lookup; iterate on failures.
- H26–32: freeze eval; bootstrap CIs; write limitations slide.
- H32–36: demo rehearsal, fallback recordings.

**Dependencies:** labels → eval → claim wording; Chalk sandbox availability (fallback: run agent locally, keep Features + Evaluations).
**Risks/fallbacks:** noisy labels → use only trials with explicit `WhyStopped` + completed; no lift over baseline → pivot to concept G with extraction-F1 and retrieval precision as headline; Chalk Compute not enabled → use `chalkpy` features + local evals, state clearly.
**Cut first:** map/site view, multi-phase generalization, UI polish.

**Demo narrative (2–3 min):** (1) 20s: "Low accrual ends a large share of terminated trials; eligibility text has doubled; FDA just told sponsors it slows accrual." (2) 60s: paste a held-out trial; show flagged criteria, precedent trials, FDA citation, Chalk trace. (3) 45s: scoreboard — agent vs baselines, CI, including where it fails. (4) 20s: limitations + roadmap (private protocols, EHR emulation).

---

## 9. Critical risks, unsupported assumptions, pivot triggers

**Three biggest uncertainties and fastest experiments**
1. *Does structured criteria content carry signal beyond length?* — Partly answered. Length carries a small adjusted signal (AUROC 0.57–0.58 on a temporal split). The open question is whether LLM-extracted criterion categories beat **0.58**. Fit an XGBoost on bag-of-categories in the first 4 hours. **Build** if AUROC lift ≥0.03 over baseline (d) with bootstrap CI > 0. **Pivot to G** (prediction shown only as a secondary, honest scoreboard) if lift ≈ 0 but extraction F1 ≥ 0.8.
2. *Label quality.* — Partly answered. A 25-label precision audit came out at ≈84%. Still to do: audit 50 more with the final LLM classifier, and check recall on 50 non-matching terminations. **Abandon the accrual-prediction claim** if precision falls below 70%.
3. *Chalk access.* — Slack question + `chalk login` + deploy one resolver (1 hr). If sandboxes/evals unavailable, fall back to features + local eval; if nothing works by H3, reconsider whether the Chalk prize is realistic.

**Unsupported assumptions:** customers will adopt/pay; criteria-level attribution is actionable; ClinicalTrials.gov text suffices; Regeneron's judging favors this (criteria unknown); competitor tools lack this feature (only absence of public evidence).

**Time/process disclosures:**
- Primary sources now checked: Williams, Peterson, Trial Pathfinder, TrialGPT and the Tufts delay paper (§11). Still unchecked: FDA's own guidance pages, the Getz 2016 full text, and the Tufts 2013 site-enrollment study.
- Not tested: AACT, TrialBench, PubMed and the Chalk APIs.
- No customer discovery was done.
- Regeneron track criteria: a search for them on 2026-10-17 found nothing.

---

## 10. Source links

*Seen directly (fetched or in my queries):*
- ClinicalTrials.gov API v2: https://clinicaltrials.gov/api/v2/studies (queries 2026-10-17); stats: https://clinicaltrials.gov/api/v2/stats/size
- AACT: https://aact.ctti-clinicaltrials.org/
- Peterson et al., Cancer Med 2023: https://pmc.ncbi.nlm.nih.gov/articles/PMC9972031/
- Williams et al., PLoS ONE 2015: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4444136/
- Tufts amendments (Getz 2016): https://journals.sagepub.com/doi/10.1177/2168479016632271 ; secondary: https://www.precisionformedicine.com/blog/the-amendment-trap-why-76-of-clinical-trials-face-six-figure-protocol-changes
- Tufts day-of-delay white paper (2024): https://csdd.tufts.edu/sites/default/files/2025-02/Aug2024%20Day%20of%20Delay%20White%20Paper%20Final.pdf ; summary: https://www.appliedclinicaltrialsonline.com/view/how-much-does-a-day-of-delay-in-a-clinical-trial-really-cost-
- Site non-enrollment (Tufts 2013): https://www.raps.org/resource/study-clinical-trial-site-activation-enrollment.html ; https://www.appliedclinicaltrialsonline.com/view/enrollment-performance-weighing-facts
- Protocol complexity: https://pharmatimes.com/news/protocol_complexity_is_increasing_trial_burden_tufts_study_says_985956/
- Trial Pathfinder (Liu et al., Nature 2021), full text: https://pmc.ncbi.nlm.nih.gov/articles/PMC9007176/ (doi 10.1038/s41586-021-03430-5)
- TrialGPT (Jin et al., Nat Commun 2024), full text: https://pmc.ncbi.nlm.nih.gov/articles/PMC11574183/
- FDA 2026 eligibility guidances (reporting): https://ascopost.com/news/july-2026/fda-releases-final-guidances-to-expand-participation-in-cancer-clinical-trials/ ; https://www.appliedclinicaltrialsonline.com/view/fda-finalizes-three-guidances-broaden-cancer-clinical-trial-eligibility ; https://www.raps.org/resource/fda-finalizes-three-guidances-to-broaden-cancer-clinical-trial-eligibility.html ; https://www.onclive.com/view/fda-finalizes-3-guidance-documents-to-broaden-cancer-clinical-trial-eligibility-criteria
- FDA 2019-draft/2020-era eligibility guidances (reporting): https://friendsofcancerresearch.org/clinical-trial-eligibility-criteria/ ; https://www.raps.org/resource/fda-finalizes-guidance-on-broader-cancer-trial-eli.html
- Urologic cancer termination: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10793983/
- HackHarvard: https://hhuh.io/ ; https://chalk.ai/hackharvard
- Chalk docs: https://docs.chalk.ai/docs/features · https://docs.chalk.ai/docs/what-is-chalk · https://docs.chalk.ai/docs/sql · https://docs.chalk.ai/docs/query-offline · https://docs.chalk.ai/docs/mcp-server · https://docs.chalk.ai/docs/evaluations/quick-start · https://docs.chalk.ai/docs/evaluations/scorers · https://chalk.ai/blog/chalk-compute

*Seen via sub-agent search results (not independently opened):*
- TrialGPT project page: https://www.ncbi.nlm.nih.gov/research/trialgpt/
- Zou interview on Trial Pathfinder (J Clin Transl Sci 2022 — *not* the paper; the first draft linked this by mistake): https://pmc.ncbi.nlm.nih.gov/articles/PMC9794967
- TriNetX: https://trinetx.com/?p=139332
- Tempus/Deep 6: https://www.genomeweb.com/cancer/tempus-ai-acquires-clinical-trial-patient-matching-firm-deep-6-ai
- Unlearn: https://www.clinicaltrialsarena.com/news/ema-qualifies-unlearn-approach/
- Medidata: https://www.medidata.com/en/optimize-enrollment-through-ai-powered-site-selection-study-forecasting/
- Citeline: https://www.citeline.com/en/solutions/clinical/clinical-planning-and-protocol-optimization
- Phesi: https://www.clinicalresearchnewsonline.com/news/2026/06/02/phesi-highlights-disconnect-between-protocols-and-outcomes--warns-of-ai-repetition
- Criteria2Query: https://pmc.ncbi.nlm.nih.gov/articles/PMC6402359 · https://arxiv.org/html/2502.21107v1
- TrialBench: https://arxiv.org/pdf/2407.00631 · https://zenodo.org/records/14975339
- HINT/SPOT & oncology weakness: https://arxiv.org/pdf/2304.05352 · https://arxiv.org/pdf/2411.17595
- ClinicalReTrial: https://arxiv.org/html/2601.00290v2 · POET: https://arxiv.org/pdf/2602.00370

---

## 11. Review log (2026-10-17, second pass)

The review targeted the two weakest parts of the first draft: the claims taken from search summaries and the judgment-based scores.

| Claim | Result | Change |
|---|---|---|
| Williams 2015: accrual 57% (350/619) | **Confirmed** from full text. But 619 is the *non-data-driven* category, not "terminations with stated reasons" | Wording fixed |
| Trial Pathfinder numbers | **Confirmed** from full text (PMC9007176) | Draft linked PMC9794967, which is an *interview*, not the paper. Link fixed, exact numbers added |
| TrialGPT 87.3% / 42.6% | **Confirmed**. The 42.6% comes from a tiny pilot (6 trials, 6 vignettes, 2 physicians) | Caveat added |
| Tufts delay: $800k/day | **Confirmed** from the PDF. Also found the direct cost: ~$40k/day for Ph II/III ($55,716 Ph III) | Upgraded to Verified; draft had called the direct cost uncertain |
| Tufts amendments 57% / 45% / $141k / $535k | **Consistent** with abstract snippets (full text 403) | Labelled "verified from abstract" |
| FDA "finalized guidance on brain mets/HIV/organ dysfunction" in July 2026 | **Wrong.** The July 2026 finals cover performance status, washout/concomitant meds and lab values. Brain mets, HIV/hepatitis, organ dysfunction and age are earlier (2019 drafts; HIV final 2020) | Corrected in §1, §2, §5 |
| My quartile gradient (unadjusted) | **Holds after adjustment** (log-words coef +0.19, CI +0.04 to +0.34), but the predictive power is weak (temporal AUROC 0.57–0.58) | Added to §4; lowered A's score; reordered the build |
| Label noise | ≈84% precision on 25 samples; the sponsor-strategy phrasing is the failure mode | Added to §4 and §9 |
| Regeneron track criteria | Still not found | Unchanged (Unverified) |

**Net effect on the recommendation:** same winner, weaker framing. The draft implied prediction was the centrepiece. The data says prediction is a modest supporting signal, so the evidence-retrieval/guidance linter is the core deliverable and the scoreboard is honest context. Score uncertainty (±5 each) means A over G is a structural choice (A contains G), not a points win.

**Still weakest after review:**
1. No customer or user evidence of any kind.
2. Scores remain judgment calls.
3. Unknown whether LLM-extracted criterion categories beat a 0.58 AUROC length + metadata baseline. This is the decisive hour-4 experiment.
4. Competitor "gaps" rest on absence of public evidence.
