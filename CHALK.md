# Chalk in ProtocolOS

Chalk does four concrete jobs in ProtocolOS. Each row says whether it has actually run, and where. The Chalk team and project identifiers keep the original name (`triallens`, query `triallens_registry_profile`).

| Chalk capability | What it does in ProtocolOS | Status (2026-10-18) |
|---|---|---|
| **Features + online resolver** (`chalk_project/feature_store/src/trial_features.py`) | A `Trial` feature class whose resolver pulls the ClinicalTrials.gov record inside Chalk and computes registry-level features: whether a protocol PDF is posted, whether the registry eligibility text mentions neutrophils/ANC, the ECOG limit stated in the registry. The app queries it for the reviewed trial and shows that the lab thresholds ProtocolOS reviews are usually **absent from the registry** and had to be read from the protocol PDF. | **Operational.** First deployed to the collaborator's environment `trllf247b678` (deployment `cmvco4ewl01ct014wpkr04aev`); also deployed to the user's environment `trll59fe560c` (deployment `cmvctrtwt04ak013ebmmzy6fp`), where the registry profile chip works locally (`python -m trialforge.chalk_bridge NCT03409614` returns `status: ok`). Without Chalk credentials the chip says "unavailable". |
| **Chalk Compute + Evaluations: verifier** (`chalk_project/trialforge_chalk_eval.py`, generated) | The deterministic verifier runs as a Chalk function (`tf_verify`) over the 39 developer-designed verifier cases (24 injected faults, 10 valid, 5 ambiguous), scored by Chalk scorers (`verdict_correct`, `valid-json`, plus two list-returning scorers). | **Ran in the collaborator's environment** `trllf247b678`. Evaluation `cmvco3m0n01dw01y520oc80sq`, run `e61fce6c-892f-4215-9122-48ad77c42df6`: SUCCEEDED, 39 rows, 0 task errors (`data/chalk_eval_run.json`). Remote verdicts: 24/24 faults rejected, 0/10 valid rejected, 5/5 ambiguous flagged. Chalk scorer `verdict_correct` mean = 1.0 (n = 39). The two list-returning scorers recorded no numeric values in the result table, so their metrics are computed from the remote outputs instead. |
| **Evaluation `protocolos-investigator`** (`evals/investigator/`) | Planted defects in the investigator's answers on EMPOWER-Lung 3 (unknown trial IDs, changed numbers, causal phrases, misquotes, dropped counter-evidence, injected instructions), graded by the answer checker. | **Local only.** Results in `evals/investigator/results.json` (`python -m evals.investigator.run`). It has not been run on Chalk. |
| **Model Gateway (router)** | Optional model mode: the critic (may only downgrade a flag), free-text questions, the investigator's model answers. OpenAI-compatible endpoint `https://api.chalk.ai/v1/router` with header `X-Chalk-Env-Id`; the environment and model are set by `CHALK_ROUTER_ENV_ID` and `CHALK_ROUTER_MODEL`. Every statement a model returns passes the deterministic checks. | **Works locally with a router key** (user's environment `trll59fe560c`; an investigator `why_flagged` answer came back with every statement checked). **Off on the public deploy:** the demo guard keeps it deterministic unless `PROTOCOLOS_ALLOW_MODEL=1`. Without a key the app says "not configured"; it never substitutes canned model output. |
| Sandboxes, traces | — | Not used. |

`data/chalk_status.json` is the committed snapshot behind the vanilla dashboard's Chalk chip, not a live check; this file is the authoritative current state.

## Setup that was performed

- `chalk login` (by the user), then `chalk init` from the project root, run non-interactively. A `pip freeze` diff showed **no packages removed or changed**. It added `chalk.yaml`, `.chalkignore`, `uv.lock` and editor settings, and kept our `.gitignore` and `README.md`. Do not re-run `chalk init`: it rewrites committed files.
- `chalk mcp configure-claude --claude-scope local`: the MCP server is registered for this project only, and nothing is written to the repo.
- **Dependency isolation.** Chalk's feature-serving runtime requires `pydantic<2`, which conflicts with the web app (FastAPI). The root `chalk.yaml` therefore points at `chalk_project/feature_store/requirements.txt`, and `.chalkignore` excludes the app code from uploads.

## Reproduce

```bash
~/.chalk/bin/chalk login && ~/.chalk/bin/chalk user          # pick an environment with Evaluations enabled
~/.chalk/bin/chalk apply --force                              # from the repo root: deploys the Trial feature set
~/.chalk/bin/chalk query --in trial.nct_id=NCT03409614 --out trial.registry_mentions_anc --out trial.has_protocol_pdf

.venv/bin/python -m chalk_project.build_eval_bundle           # bundle verifier + dataset (dataset embeds protocol text; not committed)
cd chalk_project && ../.venv/bin/python trialforge_chalk_eval.py --run   # writes data/chalk_eval_run.json and data/chalk_eval_rows.json

.venv/bin/python -m evals.investigator.run                    # protocolos-investigator, local

# Model Gateway: put CHALK_ROUTER_API_KEY=..., CHALK_ROUTER_ENV_ID=... and CHALK_ROUTER_MODEL=... in .env (never commit it), then
.venv/bin/python -m evals.run_evals --llm                     # adds the LLM-only verifier baseline
```

Why the eval is bundled: Chalk deploys a function by importing its single file, so `build_eval_bundle.py` inlines the exact `trialforge/verifier.py` source. Each dataset row carries the frozen review context (criteria, regimen, comparator thresholds, FDA texts, a registry snapshot), so the remote function needs no network access.
