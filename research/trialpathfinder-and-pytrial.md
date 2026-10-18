# TrialPathfinder and PyTrial: what they take in, what they produce, what TrialLens can reuse

Read-only study, 2026-10-17, after a Regeneron mentor pointed us to both projects. No third-party code was installed or
run. Both are references, not dependencies: TrialPathfinder needs longitudinal patient-level data (it was built on
Flatiron EHR data) that TrialLens does not have, and PyTrial embeds criteria as free text without structuring them.
Neither drafts eligibility criteria with traceable rationale, which is what TrialLens's planned "create criteria from an
idea" mode adds.

## TrialPathfinder (Stanford/Genentech, Liu et al., Nature 2021)

### TrialPathfinder: what it is
Trial Pathfinder is an MIT-licensed Python library and method from Stanford and Genentech (repo `LICENSE` reads "Copyright (c) 2020 RuishanLiu"; last commit 2022-01-05; `setup.py` version 1.1.0). The README says it does four things: "encoding eligibility criteria, emulating existing trials under combinations of eligibility rules, evaluating individual eligibility rule with Shapley value and suggesting data-driven criteria". The paper is Liu et al., *Nature* 592, 629-633 (2021), DOI 10.1038/s41586-021-03430-5. It emulated 10 completed aNSCLC phase 3 trials (4 first-line, 6 second-line) on a nationwide EHR-derived database of 61,094 patients (Flatiron Health). On average the original trials used 15 criteria (range 10-19) (PMC9007176; nature.com preview). The HAI release (Andrew Myers, 2021-04-16) calls it an algorithm that "combs electronic health records" to see which criteria include or exclude patients.

### Input representation
- One rule is one quoted CSV cell. Line 1 is the rule name. A `#inclusion` or `#exclusion` line follows, optionally with "(missing include)" or "(missing exclude)". The default includes patients whose data is missing (README "Standards of encoding"; `TrialPathfinder/cohort_select.py` lines 318-321 and 446-447).
- Data references use `Table['column']`. Operators: `== != < <= > >=`, `AND`, `OR`, `MIN`, `MAX`, `ABS`. Time is written `@DAYS(n)`, `@MONTHS(n)` or `@YEARS(n)` (README).
- Rows run in order. The earlier rows narrow the tables (line of therapy, lab name, date window, nearest record) and the last row selects patients. An exclusion is the negation of the match (`cohort_select.py`, `if ie == 'ex': select_all = ~select_all`). `selection()` ANDs the chosen rules (`cohort_select.py` lines 480-492).
- Thresholds can be absolute or relative to the upper limit of normal: `lab['value'] <= 1.5 * lab['maxnorm']`.
- Real example, `paper/criteria/Merck_Keynote189.csv` (KEYNOTE-189, the same trial as TrialLens's cached NCT02578680):
``
Hemoglobin
#inclusion
(treatments['linenumber']==1) AND (treatments['maintenance']==False)
lab['name'] == 'Hemoglobin, whole blood'
(lab['date'] >= treatments['startdate'] - @DAYS(28) ) AND (lab['date'] <= treatments['startdate'])
MIN(ABS(lab['date'] -treatments['startdate']))
lab['value'] >= 9
``
- The same file encodes platelets `>= 100`, ANC `>= 1.5`, bilirubin `<= 1.5 * maxnorm`, and AST and ALT `<= 2.5 * maxnorm`. The AST rule has no liver-metastasis branch. CNS metastasis uses diagnosis codes `'198.4'` and `'C79.4'`.
- Ten trial files are in `paper/criteria/`: FLAURA, LUX-Lung 8, CheckMate 017/057/078, KEYNOTE-010/189/407, BEYOND and OAK. A synthetic five-rule example is in `tutorial/data/criteria.csv`.
- Caveats I observed:
  - In `Roche_OAK.csv` the "Staging" rule has the same body as "Age", which looks like a copy error.
  - The repo's lab rules use a window of -28 to 0 days and its ECOG rules -30 to +7. The paper's Methods state "30 days before to 7 days after the start of the line of therapy" (PMC9007176). I did not resolve which applies to what.
  - The parser builds Python strings from rule text and runs them with `exec()` (`cohort_select.py` lines 374-376 and later).

### Outputs
- `emulate_trials(...)` returns `HR, CI, data_cox`. Under the hood (`TrialPathfinder/utils.py`):
  - stabilized IPTW weights from a logistic-regression propensity model (`generate_cox_data`);
  - a lifelines `CoxPHFitter` with `weights_col='weights', robust=True`;
  - the treatment hazard ratio and exponentiated confidence interval (`cox`).
  - Overall survival or PFS depends on which outcome date is supplied (README "Data Requirements").
- `shapley_computation(...)` returns one Shapley value per rule (`TrialPathfinder/shapley_computation.py`):
  - Monte Carlo over random rule orderings;
  - each rule's value is the mean of HR(prefix with the rule) minus HR(prefix without it);
  - it stops when SEM < `tolerance=0.001` or at `iter_max=1000`; `random_seed=1001`.
- Interpretation (PMC9007176):
  - negative means including the rule lowers the HR;
  - positive means it raises the HR;
  - near zero means little effect.
- "Data-driven criteria" keep only the rules with Shapley < 0 and drop the rest. README: `names_rules_relax = names_rules[shapley_values<0.]`. Paper: "subset of criteria used by the original trial that have a Shapley value smaller than 0".
- The authors compare three cohorts: original criteria, data-driven criteria and fully relaxed (`name_rules=[]`) (README; PMC9007176).

### Key findings relevant to TrialLens
All numbers below are from PMC9007176.
- In aNSCLC, average eligible patients went from 1,553 (HR 0.82) under the original criteria to 3,209 (+107%, HR 0.77) under data-driven criteria. Fully relaxed criteria gave 5,167 (HR 0.83). The data-driven sets dropped about 9 rules per trial on average.
- The paper relaxes "several common laboratory-based eligibilities—levels of bilirubin, platelets, haemoglobin and ALP". Cut-offs were varied "across the range used in actual trials", and relaxing them "does not significantly increase the hazard ratio of the overall survival in the Flatiron database" (Extended Data Fig. 7).
- Many other lab criteria and prior-treatment or biomarker criteria had near-zero Shapley values. This list comes from a tool paraphrase of Fig. 2; check the figure before quoting a specific analyte.
- Other cancers (colorectal, advanced melanoma, metastatic breast): data-driven criteria gave +53% eligible patients on average and an OS HR 0.13 lower.
- Safety: across 22 Roche trials (11,602 patients), trials with looser lab thresholds "did not have more treatment withdrawals due to adverse events" (Supplementary Table 35).
- Newly eligible patients "tend to include more women and more patients older than 75 years". The HAI release also says "minority". I found no race or ethnicity finding in the PMC text.
- The authors note heterogeneity: "Even trials with similar mechanisms that target the same disease often use different eligibility criteria" (Extended Data Fig. 2). Zou, in the HAI release: "Sometimes the criteria were just copied and pasted from previous studies."

### What TrialLens can reuse now without patient data
1. **Criterion schema.** TrialLens's `Criterion` (`trialforge/extract.py:53-68`) already has `section`, `operator`, `value_norm`, `unit_norm` (with `×ULN`, `extract.py:270`) and `conditions`. Two fields from the TP grammar are worth adding: an assessment window (days relative to first dose) and an explicit missing-data policy.
2. **Drafting mode ("Create criteria from an idea").** A drafted criterion should be a structured record in this schema, rendered to text only after `verifier.verify()` passes (`verifier.py:70`: units, plausibility from `PLAUSIBLE` at `verifier.py:28`, direction via `_looser` at `verifier.py:64-67`, overclaim check at `verifier.py:48`). A model fills fields; it never writes free-text criteria that skip the verifier.
3. **Export only.** Each criterion can be rendered deterministically into TP rule text (`#inclusion` / `lab['value'] >= 9`), so a sponsor with EHR access can run TP themselves. TrialLens should never parse or execute TP rules, because the parser uses `exec()`.
4. **KEYNOTE-189 cross-check.** Turn the `Merck_Keynote189.csv` values (Hgb >= 9, ANC >= 1.5, platelets >= 100, bilirubin <= 1.5x ULN, AST/ALT <= 2.5x ULN) into a hand-copied, MIT-attributed fixture. Compare it with TrialLens's extraction of NCT02578680. Treat it as a second opinion, not gold: TP drops the liver-metastasis branch and has at least one copy error (OAK "Staging").
5. **Rationale citation (fits the "Evidence" to "Rationale" rename).** For hemoglobin, platelets and bilirubin in aNSCLC targets only, add an unscored "literature context" item. Suggested wording: "In an EHR emulation of 10 aNSCLC trials, broadening bilirubin, platelet, haemoglobin and ALP cut-offs within the range used in trials did not significantly change the overall-survival hazard ratio (Liu et al., Nature 2021). This is an association in a different population; is this trial's threshold justified by its regimen?" This keeps the guardrails: no claim that a value is safe, and no enrollment claim for this trial.
6. **Relaxation as a review question.** Map TP's three tiers (original / data-driven / fully relaxed) to "current threshold / range used by comparable trials (`comparators.py`) / no threshold". The paper's own method varied cut-offs "across the range used in actual trials", which supports showing the comparator range as the question, not a recommended value.
7. **Wording to borrow and to avoid.** Borrow the authors' "one factor among several that can assist clinical trial specialists" (PMC9007176). Avoid the HAI line "without introducing additional risk to the patients": it breaks the TrialLens guardrails (docs/TEAMMATE_ONBOARDING.md).

### What it cannot do here
- **No data to run it.**
  - TP needs patient-level longitudinal records: drug, line start date, outcome (death) date, last-visit date, dated labs with ULN (`maxnorm`), ECOG history, diagnosis codes and biomarkers (README "Data Requirements"; table names in `paper/criteria/*.csv`).
  - The paper used licensed Flatiron and FH-FMI CGDB data, "available on request from the data providers" (nature.com).
  - Trial selection itself required "more than 250 patients in Flatiron" per arm (`paper/trial_selection/README.md`).
  - TrialLens has only protocols, registry records, FDA guidance and NHANES, with no treatment lines or survival outcomes. So there are no HRs, no Shapley values and no data-driven criteria.
- **No integration tonight.** As instructed, I did not install TP or run any of its code. Running it on `tutorial/data/` would produce synthetic numbers that must never reach the demo.
- **No transfer of numbers.**
  - Paper figures are averages over 10 aNSCLC trials in one US EHR population; they must not be stated as findings about NCT03409614 or NCT03088540.
  - For TNBC (KEYNOTE-355), I did not find which criteria the breast-cancer analysis covered.
  - The paper is not causal and "the real-world population can differ from the clinical trial samples" (PMC9007176).
- **Not read.** The nature.com full text is paywalled (I read only the abstract preview and figure legends). I did not open the Supplementary PDF or Extended Data Table 1. Paper figures come from the PMC author manuscript.

### Sources
- https://github.com/RuishanLiu/TrialPathfinder (shallow clone, read only, no code run):
  - `README.md`, `LICENSE`, `setup.py`
  - `TrialPathfinder/cohort_select.py`, `TrialPathfinder/emulate_trials.py`, `TrialPathfinder/shapley_computation.py`, `TrialPathfinder/utils.py`
  - `paper/criteria/Merck_Keynote189.csv`, `paper/criteria/Roche_OAK.csv`, `paper/criteria/README.md`
  - `paper/trial_selection/README.md`, `tutorial/data/criteria.csv`, `tutorial/README.md`
- https://www.nature.com/articles/s41586-021-03430-5 (abstract preview, figure legends; paywalled)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9007176/ (author manuscript; results, methods and quotes above)
- https://hai.stanford.edu/news/ai-expands-reach-clinical-trials-broadening-access-more-women-minority-and-older-patients
- TrialLens files:
  - `trialforge/extract.py`
  - `trialforge/verifier.py`
  - `trialforge/review.py`
  - `data/registry/NCT02578680.json`

## PyTrial (SunLab UIUC, hosted under Keiji-AI)

### PyTrial: what it is
- PyTrial is an academic Python package for "AI for drug development". It was written by Zifeng Wang, Brandon Theodorou, Tianfan Fu, Cao Xiao and Jimeng Sun at SunLab@UIUC (README.md, setup.py, LICENSE "Copyright (c) 2022, Zifeng"). Paper: arXiv 2306.04018.
- It is hosted at `Keiji-AI/PyTrial`. GitHub says it is not a fork; the repo was created 2022-11-29, and the Keiji AI Inc org was created 2023-11-25. An identical upstream is at `RyanWangZf/PyTrial`, and `setup.py` still points there. I read commit `a0d056e` (2024-01-07), the latest on `main`; the later pushes are dependabot branches only (gh api branches).
- It is a collection of task pipelines that reproduce published papers, all behind one API: "load data -> define model -> fit and predict", using `fit/predict/save_model/load_model` (README.md:72-84). There are six tasks under `pytrial/tasks/` (docs/source/index.rst:9-14).
- Keiji's commercial product is "TrialMind", per the keiji.ai homepage fetched 2026-10-17 through a summarizer. The page lists "Biostatistics & Trial Design" as a use case. It mentions eligibility criteria only once, in a customer story: "refining eligibility criteria by comparing them with registered trials". It does not describe drafting criteria from an idea, and it names no data sources.

### How a trial and its criteria are represented
- **One trial is one row of a pandas DataFrame.** The criteria are one free-text string column. Demo outcome data header (`demo_data/demo_trial_data/phase_I_train.csv`, 1044 rows): `nctid,status,why_stop,label,phase,diseases,icdcodes,drugs,smiless,criteria`.
- **Document fields for search** come from an AACT pipe-delimited export (`pytrial/utils/trial_utils.py:175-263`). The columns are `description, title, intervention_name, disease, keyword, outcome_measure, criteria, reference, overall_status`.
  - `load_trial_document_data` splits them into "attribute" fields `['title','intervention_name','disease','keyword']` and "context" fields `['description','criteria']`, keyed by `nct_id` (`pytrial/data/demo_data.py:272-273`).
- **Criteria parsing** is `TrialDatasetBase._split_protocol` (`pytrial/data/trial_data.py:102-130`; the same code is in `trial_outcome/model_utils/protocol_encode.py:19-54`):
  - The text is lowercased and split on newlines.
  - The first line containing "inclusion" starts the inclusion list, and the first line containing "exclusion" starts the exclusion list. If neither is found, every line counts as inclusion.
  - Each non-empty line becomes one "criterion". Unique criterion strings are indexed in a `Vocab` (`trial_data.py:79-100`) and embedded with Bio_ClinicalBERT into 768-d vectors (`trial_data.py:65-77`; `pytrial/model_utils/bert.py:41`).
- **Nothing is structured.** A criterion has no operator, value, unit, analyte or source page.
  - Splitting on newlines breaks wrapped bullets. The project's own tutorial shows one bullet split into two list entries: `'-  histological or cytological diagnosis of metastatic stage iv or locally advanced,'` followed by `'amenable to local therapy with curative intent.'` (`docs/source/tutorials/inputdata.trial.rst:76-77`).
  - Raw example from the demo CSV, row NCT01187615: `-  Eastern Cooperative Oncology Group (ECOG) Performance Status of 0 - 2` / `-  Adequate bone marrow, liver, and renal function`. These stay as strings, so no threshold is ever recovered.
- **How the models consume criteria:**
  - HINT averages the inclusion and exclusion embeddings into one vector each and passes their concatenation through a linear layer (`protocol_encode.py:120-149`).
  - COMPOSE and DeepEnroll keep a per-criterion embedding sequence with labels 0 unmatch / 1 match / 2 unknown (`trial_patient_match/models/compose.py:22-35`).
- **Structured trial features** for site selection go through `TrialDatasetStructured`, which uses rdt transformers (`trial_data.py:204-366`).

### Workflow: tasks and models
| Task | Input | Output | Models | Data needed | Path |
|---|---|---|---|---|---|
| Trial search | trial-document DataFrame plus field lists | top-k NCT IDs with cosine similarity | Doc2Vec, WhitenBERT, Trial2Vec (`bm25.py` is empty, 0 lines) | `clinical_trials.csv` (CT.gov copy of 10/01/2022) plus `TrialSim-data.xlsx` labels, from Google Cloud Storage (`demo_data.py:16,21`) | `pytrial/tasks/trial_search/` |
| Trial outcome | nctid, SMILES, ICD codes, criteria, label | P(success), 0/1 | LR, XGBoost, MLP, HINT, SPOT | HINT benchmark zip (`demo_data.py:186`); SPOT also clusters trials on Trial2Vec embeddings (`model_utils/topic_discovery.py:144-163`) | `pytrial/tasks/trial_outcome/` |
| Patient-trial match | patient EHR visit sequences plus criterion embeddings | per-criterion match/unmatch/unknown | COMPOSE, DeepEnroll | patient EHRs with labels per criterion | `pytrial/tasks/trial_patient_match/` |
| Site selection | trial feature vector plus site features (static, dx, rx, demographics) plus past enrollment | ranked sites (K=10) | FRAMM, PolicyGradientEntropy | site and enrollment tables | `pytrial/tasks/site_selection/` |
| Patient outcome | tabular or sequential patient records | mortality, readmission, etc. | LR, XGBoost, MLP, FT-Transformer, TransTab; RNN, RETAIN, RAIM, Dipole, StageNet | Project Data Sphere trial data, MIMIC-III, synthetic EHR (`docs/source/tutorials/trial_patient_data.rst:8`; `demo_data.py:33-118`) | `pytrial/tasks/indiv_outcome/` |
| Trial simulation | real patient records | synthetic records | GaussianCopula, CopulaGAN, CTGAN, TVAE, MedGAN; RNN-GAN, EVA, SynTEG, TWIN, KNN, PromptEHR | the same patient data | `pytrial/tasks/trial_simulation/` |

- The tutorial for trial search says it helps "when practioners are designing new trials" by retrieving historical trials (`docs/source/tutorials/trial_search/trial_search.rst:7-9`).
- I found no TrialTrove or Citeline data in the repo; grep over `pytrial/` and `docs/` found nothing.

### Anything that drafts or recommends criteria
- **PyTrial has no module that generates, drafts or recommends eligibility criteria.** Criteria are only inputs: they are embedded for search, outcome prediction and patient matching.
  - Grep for criteria generation or recommendation, and for LLM/GPT/OpenAI, across `pytrial/` and `docs/` found nothing.
  - The nearest piece is `trial_search/models/trial2vec.py`: it retrieves similar trials, and a person then reads their criteria.
- **The Keiji org's criteria work is in a different repo**, `Keiji-AI/TrialPanorama` (commit `20e97cb`). It has an "Eligibility Criteria Design" benchmark, but that benchmark is multiple choice, not free drafting:
  - The prompt is "Please select the eligibility criteria that correspond to the clinical trial described below" (`data_pipeline/sft_design_tasks.py:30`).
  - The model must answer `{"answer_choice": "A"|"B"|...}` and is scored on accuracy (`benchmark/tasks/qa_task.py`, `benchmark_scripts/run_eligibility_criteria_design.py:69`).
  - The models are Azure GPT-4o, GPT-4o-mini and o3-mini (`benchmark_eligibility_criteria_design.sh`), plus a fine-tuned Qwen-3-8B on Hugging Face (README).
  - It does no verification against source documents.
- **I found no public code for how TrialMind drafts criteria.**

### Ideas for TrialLens "Create criteria from an idea"
1. **Idea form.** Fields: condition, setting tags (first-line, metastatic, non-squamous, perioperative), regimen drugs, phase, and a cutoff date (today).
   - Parse drugs with `druglib.find_drugs` and map them to classes and toxicity properties with `druglib.classes` / `LAB_RELEVANCE` (`trialforge/druglib.py:72-97`).
   - The curated table has 31 drugs. Show drugs it does not recognize as "unrecognized", the way `extract_regimen` does (`extract.py:541-550`).
2. **Retrieve.** Add a new user-owned file, `trialforge/draft.py`, with a `discover_for_idea()` function.
   - It reuses the v2 search parameters from `comparators.discover` (`comparators.py:88-94`), plus `setting_tags`, `_lung_histology` and the class-Jaccard ranking.
   - `discover()` itself cannot be used, because it calls `fetch_study(target nct_id)` (`comparators.py:97`) and an idea has no NCT ID.
   - `discover()` puts only immunotherapy drug names into `query.intr` (`comparators.py:86`), so a chemotherapy-only idea falls back to the literal drug list.
3. **Extract precedents.** Run `extract.analyze_trial` on each comparator. This gives `Criterion` records with page and quote (`extract.py:53-72`) for the six labs, ECOG and washouts, the only categories TrialLens structures.
4. **Propose each criterion with its rationale.** For each analyte:
   - Show the full precedent distribution, for example "Hb ≥9 g/dL: 3 trials; ≥10: 1". Each entry carries NCT ID, page, quote, start date and `coverage()` status (`comparators.py:121-139`).
   - Offer a default value only from regimen-matched (`coverage: full`) precedents.
   - Attach FDA passages from `guidance.passages_for(analyte)`, each checked with `verify_quote`.
   - Add the toxicity link, worded as "supports having a threshold, not this value".
   - If all comparators agree, flag "possible template carry-forward". If there are no or too few precedents, show "Insufficient evidence" and no value.
5. **Verify.** Build a synthetic `ctx`: target is `{study: {nct_id: "DRAFT"}, criteria: drafts, regimen}`, plus `comparators`. Call the unchanged `verifier.verify()` with claims of type `comparator_threshold` and `fda_quote`. This works because `verify` only needs the criterion ID to be present in `ctx.target.criteria` (`verifier.py:93-97`). Three gaps for `draft.py` to handle:
   - (a) A draft with no claims passes with zero checks. `draft.py` must require at least one verified precedent or FDA passage, or else label the criterion "Insufficient evidence".
   - (b) Do not use `protocol_quote` claims. That resolver looks up the target's NCT ID (`verifier.py:181`), and a draft has none.
   - (c) Label every draft "Suggestion, the team decides". A real `draft` action inside `verifier.py` would be a change request to the collaborator, who owns that file.
6. **What to borrow from PyTrial (concepts, not code):**
   - The split of trial fields into attribute fields and context fields, as a design for an optional re-ranker.
   - A frequency-ranked vocabulary of criterion sentences across comparators (the `Vocab` idea). TrialLens could show non-numeric precedents such as brain metastases or prior therapy as quoted text, labelled "text precedent, not numerically verified".
7. **What not to borrow:**
   - The newline parser: TrialLens' `group_items` (`extract.py:187`) already joins wrapped bullets.
   - The classic CT.gov client.
   - HINT/SPOT outcome scores. They would imply success or enrollment claims that the guardrails forbid.

### Licence and integration cost
- **PyTrial is BSD-2-Clause** (`LICENSE`). Code can be reused with the copyright notice kept, which is compatible with an MIT repo.
- **The cost is high and the benefit low:**
  - The stack is heavy: PyTorch must be installed first, plus transformers, rdkit, `sdmetrics==0.6.0`, ctgan, gensim, xgboost, transtab, promptehr and trial2vec (`requirements.txt`, README).
  - It is "tested on python==3.7" (README); TrialLens uses Python 3.13.
  - Trial2Vec, COMPOSE and FRAMM default to `device='cuda:0'`.
  - Its CT.gov client calls the classic `/api/query/study_fields` and `/api/info/` endpoints (`trial_utils.py:21-24`). Both returned HTTP 404 when I checked with curl on 2026-10-17; TrialLens uses API v2 (`sources.py:26`).
  - Its pretrained artifacts on Google Cloud Storage still return HTTP 200. I did not download them.
- **TrialPanorama has no licence.** GitHub reports `license: null` and there is no root LICENSE file, so it grants no reuse rights by default. I did not check the Hugging Face dataset's licence.
- **Recommendation:** add no dependency. Build `draft.py` on the existing comparator, extractor, guidance and verifier code. My rough estimate for the backend is a few hundred lines; I have not scoped it in detail.

### Sources
- PyTrial: https://github.com/Keiji-AI/PyTrial at `a0d056e` (cloned read-only). Files cited above: README.md, LICENSE, setup.py, requirements.txt, `pytrial/data/trial_data.py`, `pytrial/data/demo_data.py`, `pytrial/utils/trial_utils.py`, `pytrial/model_utils/bert.py`, `pytrial/tasks/*`, `docs/source/index.rst`, `docs/source/tutorials/*.rst`. Upstream: https://github.com/RyanWangZf/PyTrial
- Paper: https://arxiv.org/abs/2306.04018
- TrialPanorama: https://github.com/Keiji-AI/TrialPanorama at `20e97cb`
- Keiji homepage: https://keiji.ai/ (fetched 2026-10-17 through a summarizer; the quoted phrase was not checked against the raw HTML)
- TrialLens files (read-only): `trialforge/comparators.py`, `extract.py`, `verifier.py`, `sources.py`, `guidance.py`, `review.py`, `druglib.py`
