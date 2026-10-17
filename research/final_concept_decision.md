# Final Concept Decision — HackHarvard 2026

Date: 2026-10-17. Builds on `clinical_trial_ai_opportunity_deep_dive.md` (incl. §11 review log) and `clinical_trial_ai_executive_brief.md`, which are left unchanged.

**Labels used throughout:**
- **[Measured]** — I computed it this session from real data.
- **[Source]** — read in a primary document.
- **[Reported]** — secondary source.
- **[Modeled]** — an estimate from a model.
- **[Illustrative]** — an example output, not a result.
- **[Unavailable]** — cannot be known from accessible data.

---

## 0. Decision in one paragraph

**Build an *Eligibility Justification Review* agent.** It reads a real oncology protocol, extracts each restrictive criterion (lab thresholds, ECOG, washouts), and makes every criterion *earn its place*. Each one is checked against four things:
1. The drug's and the comparator arm's mechanism, as stated in the protocol itself.
2. Peer protocols of the same design.
3. The exact text of FDA's July 2026 guidances.
4. Real population lab distributions from NHANES.

An adversarial verifier then attacks every recommendation and downgrades the unsupported ones. The output is a per-criterion verdict — **Justified / Contested / Flag for review** — with citations, and a measured demographic-impact number for lab criteria.

This is *not* Regeneron/Keiji's drafting system. Theirs builds criteria from what similar trials do most often. Ours questions whether each inherited criterion is justified, which is the template carry-forward the 2026 FDA lab guidance explicitly warns against. It also drops the weak accrual-risk score (AUROC ≈0.58) as a headline.

---

## 1. Top three concepts and trade-offs

| | **D. Eligibility Justification Review (selected)** | A. Evidence-backed redesign agent | C. Adversarial multi-role review (generic) |
|---|---|---|---|
| Core | Per-criterion justification audit: protocol mechanism + comparator arm + peer protocols + FDA text + NHANES impact, with a deterministic + LLM verifier | Retrieve comparables, cross-reference FDA guidance, propose alternative criteria | Safety / access / regulatory / ops personas debate; verifier checks for hallucination |
| Overlap with Regeneron/Keiji | Low. Shares trial retrieval and LLM extraction only. Different question: "is this justified?", not "what do peers use?" | **High**: comparable-trial retrieval, extraction, clustering, drafting all exist in Keiji | Medium: personas are new, content is generic |
| Scientific substance | High: grounded in FDA III.A/III.B text, comparator-arm reasoning, measured NHANES numbers | Medium: proposals risk being "do what peers do" | Low–medium: persona debate is LLM theater without grounded checks |
| Wow moment | The agent catches its own plausible-but-wrong recommendation (§6) | Weak: a list of suggestions | Visually busy; hard to verify |
| Evaluation | Objective: extraction exact-match, injected-error catch rate, citation validity | Hard: no ground truth for "good redesign" | Hard: persona outputs are subjective |
| Feasibility (36h) | Medium–high (scope: ~6 lab analytes + ECOG + washout, oncology Ph3) | High | Medium |
| Data reliability | Protocol PDFs + registry + NHANES: real; coverage ~50% (§4) | Registry text only (lab values often missing) | Same as A |

**B. Counterfactual eligibility impact** is not a standalone finalist. I found no public, de-identified **oncology patient-level** dataset usable within 36 hours.
- **NHANES** is public and patient-level, so it supports **population lab-distribution** analysis [Measured, §4]. It cannot give trial-eligible NSCLC patient counts [Unavailable].
- **Project Data Sphere** (oncology control arms) and **MIMIC** need registration or credentialing. Not verified as obtainable in time.
- **Synthea** is synthetic and can't support real claims.
- So B survives as a **component** of D: lab-threshold impact by age, sex and race/ethnicity, explicitly labelled as general-population, not cancer patients.

**Rejected as centerpiece:**
- Accrual-risk prediction: weak signal (AUROC 0.58).
- Trial matching: crowded.
- Amendment risk: data mostly closed. Note: protocol PDFs do list amendment histories (EMPOWER-Lung 3 lists Amendments 2–5 with dates), but that's a post-hackathon idea.

---

## 2. Verified differentiation from Regeneron / Keiji.AI (ISPOR 2026, MSR149)

[Source: ISPOR abstract page, read 2026-10-17. Li (Regeneron), Theodorou & Sun (Keiji.AI).]

**What it does:**
1. The user enters a protocol summary.
2. It retrieves reference trials (ClinicalTrials.gov or proprietary), ranked by embeddings.
3. GPT-4.1 mini extracts entities and maps them to UMLS CUIs; an agentic LLM clusters criteria into topics **ranked by frequency across the selected trials**.
4. GPT-4.1 drafts criteria per topic.
5. It exports the draft with provenance.

**Evaluation:** static, on 3 gold-standard trials (NCT04835519, NCT06787612, NCT07187401). Precision@10 for similarity was 83.3%; topic recall was 75.7% (28/37). The drafting step was **not evaluated**.

**Overlap (do not rebuild):** retrieving similar trials from ClinicalTrials.gov, LLM criterion extraction and normalization, provenance links to source trials.

**Defensible differentiation** (each tied to something verifiable, not "they didn't mention it"):
1. **Opposite objective.** Keiji ranks topics by frequency across peer trials, so it tends to reproduce common criteria [Inferred from their method]. The FDA lab guidance §III.A says lab restrictions "should not be carried forward automatically," and §II notes industry lab criteria show "little variation" over time [Source]. D tests justification; it does not draft. The two tools are complementary: D could be applied to Keiji's draft.
2. **Comparator-arm and mechanism reasoning.** D checks a criterion against the *investigational drug and the control arm* described in the protocol (FDA §III.A: "customized to the drug(s) under investigation"). Nothing in the Keiji abstract describes this [Source: absent from abstract — absence, not proof].
3. **Quantified demographic impact** from patient-level NHANES (FDA §III.B: "The impact on trial eligibility, enrollment, and generalizability should be assessed"). Keiji lists real-world data as *future work* [Source].
4. **Adversarial verification with a measured catch rate.** Keiji's drafting step was unevaluated [Source]. D's core metric is how often the verifier rejects wrong recommendations.
5. **Full protocol PDFs, not registry summaries.** Lab thresholds are often missing from registry text (§4). Keiji's abstract mentions ClinicalTrials.gov/proprietary trials, not protocol documents.

**Framing for Regeneron judges:** "Your ISPOR system drafts criteria from precedent. We built a reviewer that turns each restriction into an evidence-backed review question. We demonstrate it on public EMPOWER-Lung protocols, applying FDA's July 2026 guidance *retrospectively*: those trials were designed in 2017–2018, before the guidance existed, so differences are review questions, not mistakes."

---

## 3. Selected MVP and value proposition

**One sentence:** *An auditable AI reviewer that tells an oncology protocol team which eligibility criteria are justified by the drug, the comparator and the evidence — and which are inherited templates that FDA's 2026 guidance says to revisit — with the population each one excludes.*

**User:** clinical scientist or protocol author at a sponsor, at protocol review before finalization or at a Phase 2→3 transition.

**Decision improved:** keep / loosen / justify-in-protocol for each lab, ECOG and washout criterion.

**Not an LLM wrapper, because:**
- Thresholds are parsed into structured values.
- Peer comparison is a deterministic diff.
- Population impact is a survey-weighted computation on real data.
- The verifier runs rule-based checks (citation existence, quote match, comparator-arm consistency) before any LLM judgment.
- Every claim carries a typed provenance tag.

---

## 4. Real demo evidence (inspected this session)

### Primary demo protocol: **NCT03409614 — EMPOWER-Lung 3** (Regeneron; cemiplimab + platinum doublet vs chemo, 1L NSCLC)
- COMPLETED; started 2018-03-06; 789 enrolled (actual). The protocol PDF on ClinicalTrials.gov is "R2810-ONC-16113 Amendment 5"; Amendments 2–5 are dated Jan 2018–Jan 2019 [Source].
- **The registry eligibility text lists no lab thresholds**; the protocol PDF does [Source]:
  - ECOG ≤1
  - **Hemoglobin ≥10.0 g/dL**
  - ANC ≥1.5×10⁹/L
  - Platelets ≥100,000/mm³
  - Total bilirubin ≤1.5×ULN (≤3×ULN with liver metastases)
  - AST/ALT ≤3×ULN (≤5× with liver metastases)
  - ALP ≤2.5×ULN

### Comparators
- **NCT03088540 — EMPOWER-Lung 1** (Regeneron; cemiplimab monotherapy vs platinum chemo; 712 enrolled; started 2017-05-29). Protocol [Source]: ECOG ≤1, **Hgb ≥9.0**, ANC ≥1.5×10⁹/L, Plt ≥100k, bilirubin ≤1.5×ULN, AST/ALT ≤3×ULN.
- **NCT02578680 — KEYNOTE-189** (Merck; pembrolizumab + pemetrexed-platinum; 616 enrolled; started 2016-01-15). Protocol [Source]: ECOG 0–1, ANC ≥1,500/µL, Plt ≥100k, **Hgb ≥9.0 g/dL**, **CrCl ≥50 mL/min**, bilirubin ≤1.5×ULN, **AST/ALT ≤2.5×ULN**.
- **NCT02383212** (cemiplimab Phase 1): ECOG 0–1 in the registry text. No protocol PDF is posted.

### Concrete, verifiable observations

| # | Observation | Evidence | What we can and can't say |
|---|---|---|---|
| O1 | EMPOWER-Lung 3 requires **Hgb ≥10.0**; KEYNOTE-189 (PD-1 + platinum doublet, same indication) and EMPOWER-Lung 1 use **≥9.0** | Protocol PDFs [Source] | **Contested, not "wrong."** The EL3 protocol background discusses higher grade 3–4 anemia with chemo combinations (line ~2420 of the extracted text), a candidate rationale. EL3 also includes squamous patients on paclitaxel regimens, so KEYNOTE-189 is only a partial comparator. Output: "flag for review — justify in protocol." The posted EL3 protocol is Amendment 5; nothing here shows whether Hgb changed across amendments, or that EMPOWER-Lung 1 influenced EL3's design. |
| O2 | Raising Hgb from 9 to 10 changes who is excluded unevenly. NHANES 2017–18, adults ≥60, weighted: Hgb<10 is 0.3% (White men), 1.1% (White women), **4.4% (Black men)**, 2.7% (Black women); Hgb<9 is 0.1 / 0.2 / 0.7 / 0.8% | [Measured]: n=419/393/234/228 | General-population, not NSCLC. Cancer patients have far more anemia (FDA cites Knight 2004) [Source]. Absolute NSCLC counts [Unavailable]; only the **relative** disparity is defensible. Small cells, wide CIs: report CIs. |
| O3 | ANC ≥1.5×10⁹/L in all three Phase 3s. NHANES adults, weighted: ANC<1.5 is **4.6% of non-Hispanic Black** vs **0.3% of non-Hispanic White**; ANC<2.0 is 12.5% vs 3.0% | [Measured]: n=1,190 / 1,831. FDA lab §II and §III.B name Duffy-null ANC explicitly [Source]. Hibbs 2024: 221/289 (76.5%) of Phase 3 trials exclude the Duffy-null-associated ANC range (LLN 1,200/µL) [Source] | **The trap:** "PD-1 is not myelosuppressive → relax ANC" is **wrong** here, because every comparator/combination arm is platinum chemotherapy. The verifier must catch this. A defensible output: "ANC 1.5 is justified by chemo exposure; consider a Duffy-null-specific threshold as Hibbs and FDA §III.B suggest — clinical judgment required." The disparity itself is *already published* (Hibbs 2024), so we claim **operationalization per protocol**, not discovery. |
| O4 | ECOG ≤1 in all three Phase 3s and the Phase 1 | Registry/protocols [Source]. FDA PS guidance §IV.A: Phase 2/3 "should generally mirror the intended use population and ECOG PS2 … should be included, unless safety concerns have manifested in earlier phase trials … rationale … stated explicitly in the protocol" [Source] | **Guidance-driven flag, no peer precedent**: all comparators use ≤1. The tool must say so. Whether PS2 safety signals existed for cemiplimab is [Unavailable] from these documents. |
| O5 | AST/ALT ≤3×ULN (EMPOWER) vs ≤2.5×ULN (KEYNOTE-189) | [Source] | Shows the diff works in the *other* direction too: the Regeneron trial is the less restrictive one. Good for credibility. |
| O6 | Time-based washouts: steroids >10 mg prednisone within 14 days (EL1/EL3); investigational agent within 30 days (EL1) / 4 weeks (KN-189) | [Source] | FDA washout §III.A: time-based washouts "should be scientifically justified"; prefer clinical/lab recovery parameters [Source]. Steroid exclusion with a PD-1 has a mechanistic rationale (immunosuppression) → expect **Justified**; the investigational-agent window → **Flag: justify**. |

**Fairness note:** these trials *succeeded* and were written in 2017–2018, before the 2026 guidances (the 2020 guidances also post-date them). Use Chalk's `knowledge_cutoff` to show the review **as of the protocol date** and **as of 2026**. The point is generalizability, not criticism.

### FDA July 2026 guidance text used (exact)

**Laboratory Values** (fda.gov/media/178013):
- §I, lines 37–39: "Unnecessarily restrictive eligibility criteria may slow subject accrual, limit patients' access…"
- §II, lines 74–77: Duffy null "associated with lower absolute neutrophil counts but not with greater risk of infection."
- §II, lines 82–85: lab criteria show "little variation… carried forward from early-phase to late-phase trials."
- §III.A, p. 4:
  - "should be customized to the drug(s) under investigation"
  - PD-1/PD-L1 class "pharmacology and toxicity profiles are similar across agents"
  - "should not be carried forward automatically"
  - "only as restrictive as necessary" (prefer "above the lower limit of normal" over "within normal limits")
  - account for inter-laboratory variation
- §III.B, p. 5:
  - "The impact on trial eligibility, enrollment, and generalizability should be assessed"
  - "consider broadening… absolute neutrophil count in patients with the Duffy null phenotype"
  - allow repeat tests
- §III.C, p. 6: reassess criteria Phase 1→3.

**Performance Status** (fda.gov/media/178018):
- §IV: include lower-PS patients; any exclusion rationale must be "described in the trial protocol."
- §IV.A, p. 5: include ECOG PS2 / KPS 60–70 unless justified; Phase 2/3 should mirror intended use.
- §IV.B, p. 6: prespecified low-PS cohorts exempt from the primary analysis.
- §IV.C: geriatric assessment and PROs.

**Washout Periods and Concomitant Medications** (fda.gov/media/178016):
- §III, p. 3: avoid vague exclusions, e.g. "Exclude patients taking concomitant medications expected to increase the risk…"
- §III.A, p. 4: prefer lab/clinical recovery parameters over time-based washouts; time-based ones "should be scientifically justified."
- §III.B: exclude for concomitant medications only for known or predicted DDIs; consider dose modification instead.

### Coverage and data limitations [Measured]
- Phase 3 oncology trials started 2015–2022 on ClinicalTrials.gov: **3,568**.
- Only **984 (28%)** mention neutrophil/ANC in the registry eligibility text.
- **809** more have a protocol PDF but no ANC in the registry text. So protocol PDFs roughly add ~50% more lab coverage: ~1,793, about **50%** of trials.
- 1,002 of 3,568 (28%) have a protocol PDF at all.
- ECOG/PS appears in 2,365 (66%) of registry texts.
- Protocol PDFs are usually the *final amendment*, not the design-time version.
- NHANES is general-population, cross-sectional, and US-only; it has no ancestry/Duffy genotype, so race is a proxy.

---

## 5. Required data and Chalk components

**Data:**
- ClinicalTrials.gov API v2: metadata, arms/interventions, registry eligibility, `LargeDocumentModule`.
- Protocol PDFs via `cdn.clinicaltrials.gov/large-docs/{last2}/{NCT}/{file}`; verified for 3 trials.
- NHANES 2017–18 `DEMO_J`, `CBC_J`, `BIOPRO_J`, `MCQ_J` (public XPT; downloaded and analyzed). Later: add a BMX weight file for Cockcroft-Gault CrCl, and the 2021–23 cycle.
- The 3 FDA guidance PDFs, plus the 2020 ones as text corpus.
- Optional: Hibbs 2024 for the Duffy-null lower limit (1,200/µL).

**Chalk (does real work):**

| Component | Role | Status |
|---|---|---|
| Features + Python resolvers | Entities `Trial`, `Criterion` (trial × analyte: operator, threshold, unit, conditions such as "if liver mets"), `PopulationImpact` (analyte × threshold × stratum → weighted % excluded with CI, computed from NHANES) | Verified in docs |
| Offline/point-in-time (`input_times`) + sandbox `knowledge_cutoff` | "Review as of protocol date" vs "as of 2026": which guidance and peer trials were knowable | Docs verified; hackathon enablement unverified |
| Sandbox (`chalkcompute`) | Runs agent tools with egress limited to clinicaltrials.gov / cdn / fda.gov | Docs verified; enablement unverified |
| Model Gateway | LLM calls for extraction, reviewer and verifier, plus `llm_judge` | Docs verified |
| Evaluations + datasets + scorers | `exact_match`/`numeric_close` (threshold extraction), `json_match` (criterion schema), custom scorers (citation/quote validity, injected-error catch) | Docs verified |
| Traces | Judges inspect each tool call behind a verdict | Docs verified |

---

## 6. Judge-facing interaction sequence (90 s live, plus a 30 s challenge)

1. **(0–10 s) Authentic input.** Type `NCT03409614`. The app shows that the registry has no lab thresholds, then fetches the 200+ page protocol PDF (Amendment 5) and extracts 8 criteria into a table. Each value is tagged [Source] with a page/line anchor.
2. **(10–30 s) Agent work, visible in the Chalk trace.** For each criterion it pulls the arms/regimens from the protocol, retrieves peer PD-1 + chemo NSCLC protocols (KEYNOTE-189, EMPOWER-Lung 1), diffs thresholds, and attaches FDA text.
3. **(30–50 s) The non-obvious catch.** The reviewer first proposes: "ANC ≥1.5 is unnecessary for a PD-1 inhibitor (FDA §III.A)." The **verifier rejects it**: the protocol's arms include platinum doublet chemotherapy, so the recommendation contradicts the comparator. The verdict becomes **Justified**, with an optional note citing Hibbs 2024 and FDA §III.B on Duffy-null-specific thresholds. The rejected draft stays visible.
4. **(50–70 s) A surviving flag.** Hgb ≥10.0 vs peers' ≥9.0 → **Contested**:
   - Evidence for: KEYNOTE-189 and EMPOWER-Lung 1 use 9.0.
   - Evidence against: EL3's own background text on combination anemia; paclitaxel arm not matched.
   - Impact panel: NHANES ≥60, Hgb 9–10 band by sex and race [Measured, general population, CI shown].
5. **(70–80 s) Guidance-only flag.** ECOG ≤1 → "Flag: FDA §IV.A recommends PS2 unless justified; **no peer precedent** among comparators; earlier-phase safety data [Unavailable]."
6. **(80–90 s) Evaluation tile.** Live Chalk Evals results: extraction exact-match on the held-out protocol set, verifier catch rate on injected errors, citation validity, each with n.
7. **Judge challenge (open):**
   - Edit a threshold (e.g. ANC → 1.2): the impact panel recomputes and the verifier re-runs.
   - Toggle "as of 2018": FDA 2026 citations disappear and verdicts are re-labelled.
   - Paste any NCT with a protocol PDF.
   - Click any citation to see the exact quoted span.

**Labels on screen:** every number is badged [Measured] / [Source] / [Modeled]; anything unknowable reads "Unavailable." No accrual predictions, no dollar figures.

---

## 7. Quantitative evaluation plan

| Test | Data and sample | Baseline | Metric | Success / failure |
|---|---|---|---|---|
| **E1. Lab/ECOG threshold extraction** | 30 Phase 3 oncology protocol PDFs (stratified by sponsor). Gold: hand-labeled analyte, operator, value, unit, conditional clause (~8 fields each, ~240 values), 2 annotators on 10 for agreement | Regex extractor (the one used this session) | Field-level exact match; numeric_close with unit normalization | Success ≥90% exact and clearly above regex; fail <80% → restrict to registry text + ECOG |
| **E2. Verifier injected-error catch rate** (core) | 60 reviewer outputs on 10 protocols, 30 with *injected* faults: fabricated NCT, misquoted FDA span, wrong threshold, recommendation contradicting comparator arm (as O3), guidance cited for the wrong topic | Same pipeline with no verifier, and an LLM-only verifier | Catch rate (recall) on faults; false-rejection rate on clean outputs | Success ≥80% catch with ≤15% false rejection, beating LLM-only; report per fault type |
| **E3. Citation and quote validity** | All citations in E2 outputs | — | % NCT IDs exist and predate cutoff; % quoted guidance spans that string-match the PDF | ≥98% (deterministic; failures are bugs) |
| **E4. Peer diff correctness** | 20 trial pairs | Manual diff | Precision/recall of "stricter/looser" calls per analyte | ≥90% |
| **E5. NHANES impact reproducibility** | Unit tests vs hand-computed weighted %; external check against a published NHANES neutropenia prevalence by race (to be verified) | — | Absolute difference | Within 0.5 percentage points |
| **E6. Consistency** | 5 protocols × 3 runs | — | Verdict agreement per criterion | Report; no threshold |

**Not evaluated, and we say so:** whether clinicians agree verdicts are correct (no expert panel); whether any change would improve accrual or safety (unknowable here).

**Confounders and limits:**
- Protocol PDFs are final amendments.
- Peer trials differ in regimen.
- NHANES is not a cancer cohort, and race is a proxy for Duffy-null phenotype.
- Small subgroup n.

---

## 8. Technical architecture and core algorithms

```
NCT ID ─► CT.gov API (arms, regimens, docs) ─► protocol PDF ─► section locator ─► criterion extractor
                                                                                       │ (LLM → strict JSON schema; regex cross-check; page/line anchors)
                                                                                       ▼
                                            Chalk features: Trial, Criterion, PopulationImpact
                                                                                       ▼
 Reviewer (LLM via Gateway, in Sandbox) ── tools: peer_retrieve(cutoff), threshold_diff, guidance_lookup(span), nhanes_impact
                                                                                       ▼
 Verifier: (1) deterministic: NCT exists / pre-cutoff; quoted span ∈ PDF text; threshold matches extraction;
                              recommendation direction vs comparator-arm drug classes (rule table)
           (2) LLM critic: argues against each recommendation using only retrieved evidence
                                                                                       ▼
 Verdict per criterion: Justified / Contested / Flag + provenance tags ─► UI + Chalk traces ─► Chalk Evals
```

**Core algorithms:**
- **Criterion schema:** `{analyte, comparator, value, unit, ULN_multiple, condition(e.g. liver_mets), source_page, source_line}`, with unit normalization (g/dL, ×10⁹/L, /µL, /mm³).
- **Peer retrieval:** same condition + phase + overlapping intervention class (PD-1/PD-L1, platinum) from arms, pre-cutoff. Only peers *with* protocol PDFs give lab thresholds.
- **Comparator-aware rule table (small, hand-curated):**
  - myelosuppressive classes (platinum, taxanes, pemetrexed) → hematologic thresholds are expected;
  - renally cleared (pemetrexed, cisplatin) → CrCl expected;
  - immunotherapy → steroid and autoimmune exclusions expected.
  Recommendations contradicting the table are auto-rejected. This is the deterministic heart of the verifier, kept auditable and small; it is not clinical advice.
- **NHANES impact:** survey-weighted % below the threshold (MEC weights), by age band × sex × race/ethnicity, with a CI. Optional cancer-history subset (MCQ220), flagged small-n.
- **Guidance lookup:** guidance PDFs chunked by section with line numbers. Quotes must string-match.

---

## 9. Scope

**Must-build:**
- PDF fetch + extraction for ~6 analytes + ECOG + washouts on oncology Phase 3.
- Peer diff for ≥2 peers.
- FDA span lookup (3 guidances).
- NHANES impact for ANC, Hgb and platelets.
- Deterministic verifier + LLM critic.
- Chalk features/resolvers, Model Gateway, Evals (E1, E2, E3), traces.
- A single-page UI with demo trial NCT03409614.

**Nice-to-have:**
- `knowledge_cutoff` "as of protocol date" toggle (high demo value; do it if the sandbox works).
- CrCl via Cockcroft-Gault from NHANES BMX.
- Bilirubin/AST/ALT impact.
- The 2020 guidances (brain metastases, organ dysfunction).
- Judge "paste any NCT."

**Cut:**
- Accrual-risk score.
- Criterion drafting (Keiji's lane).
- Multi-persona debate UI.
- Amendment analysis.
- Non-oncology support.
- Patient matching.
- Any dollar or time-savings estimate.

---

## 10. Evidence gaps and go/no-go

**Gaps:**
- No clinician validation.
- The Regeneron track judging criteria were not found.
- Chalk sandbox/eval enablement for hackathon accounts is unverified.
- Coverage: protocol PDFs exist for only ~28% of recent Phase 3 oncology trials.
- PDF layouts vary.
- NHANES ≠ cancer population.
- Duffy-null phenotype isn't in NHANES.
- The verifier rule table is our own simplification.
- Whether sponsors value a justification audit over drafting is unverified.

**Go / no-go:**

| Hour | Check | Go | No-go → action |
|---|---|---|---|
| H3 | Chalk login, resolver deployed, an Evals run on a dummy task, Gateway call | All work | No sandbox → run the agent locally but keep Features + Evals + Gateway. No Evals → reconsider the Chalk prize |
| H8 | E1 on 10 gold protocols | ≥85% exact | <75% → drop PDFs, use registry text only (ECOG + washout + whatever labs appear) and narrow claims |
| H16 | End-to-end on NCT03409614, verifier catches the O3 trap unaided by hard-coding | Yes | If it only works with a demo-specific rule → disclose, generalize the rule table, test on 3 other protocols |
| H24 | E2 catch rate | ≥80% / ≤15% false rejections | Below → present it honestly as a baseline result; don't hide it |

**Abandon** the selected concept if by H8 neither PDF nor registry extraction is reliable: fall back to concept A with registry text, clearly limited.

---

## 11. Questions to ask today

**Regeneron:**
1. What are the track's judging criteria, and is it judged by clinical development, data science or both?
2. Would reviewing your own public EMPOWER-Lung protocols in the demo be welcome, or should we use other sponsors' trials?
3. In protocol review, where do eligibility criteria actually get challenged (medical monitor, clin pharm, regulatory)? Is "justify each criterion" a step teams actually do?
4. How does the ISPOR/Keiji EC-design platform hand drafts to reviewers? Would a justification-audit step complement it?
5. Which criterion types cost you most in practice: labs, ECOG, washouts, prior therapy, CNS metastases?
6. Is Duffy-null-aware ANC already in Regeneron's protocol templates since the 2026 guidance?

**Chalk:**
1. Are `chalkcompute` Sandbox and Evaluations enabled on HackHarvard accounts? Any quotas?
2. Which models does the Model Gateway expose, with what rate limits? Is it OpenAI-compatible?
3. Can a Python resolver call external HTTPS (clinicaltrials.gov, cdn, fda.gov) from the managed environment? How do we set the egress allowlist?
4. Best practice for storing large text blobs (protocol PDFs) as features vs external storage?
5. Does `knowledge_cutoff` apply to our own resolvers' data, or only to MCP-gateway tools?
6. How should we present eval runs and traces to judges: shareable links, dashboard?

---

## Sources (opened this sprint)
- ISPOR 2026 MSR149 (Regeneron/Keiji.AI): https://www.ispor.org/conferences-education/conferences/past-conferences/ispor-2026/program/program/presentation/ispor-2026/poster-session-3-3/enhancing-clinical-trial-eligibility-criteria-design-with-generative-artificial-intelligence-and-machine-learning
- FDA, Cancer Clinical Trial Eligibility Criteria: Laboratory Values (July 2026): https://www.fda.gov/media/178013/download
- FDA, … Washout Periods and Concomitant Medications (July 2026): https://www.fda.gov/media/178016/download
- FDA, … Performance Status (July 2026): https://www.fda.gov/media/178018/download
- Hibbs et al., JAMA Netw Open 2024 (Duffy-null ANC): https://pmc.ncbi.nlm.nih.gov/articles/PMC11391325/
- Protocols: https://cdn.clinicaltrials.gov/large-docs/14/NCT03409614/Prot_000.pdf · https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf · https://cdn.clinicaltrials.gov/large-docs/80/NCT02578680/Prot_SAP_001.pdf
- ClinicalTrials.gov API v2: https://clinicaltrials.gov/api/v2/studies
- NHANES 2017–2018 data files: https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2017/DataFiles/ (DEMO_J, CBC_J, BIOPRO_J, MCQ_J)
- Prior reports: `research/clinical_trial_ai_opportunity_deep_dive.md`, `research/clinical_trial_ai_executive_brief.md`

*Analysis scripts (scratch, not part of the project): NHANES and protocol extraction in the session scratchpad.*
