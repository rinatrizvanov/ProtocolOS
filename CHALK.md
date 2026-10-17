# Chalk in TrialLens

Chalk does three concrete jobs in TrialLens. Each row below says whether it has actually run.

| Chalk capability | What it does in TrialLens | Status (2026-10-17) |
|---|---|---|
| **Features + online resolver** (`chalk_project/feature_store/src/trial_features.py`) | A `Trial` feature class whose resolver pulls the ClinicalTrials.gov record inside Chalk and computes registry-level features: whether a protocol PDF is posted, whether the registry eligibility text mentions neutrophils/ANC, the ECOG limit stated in the registry. The dashboard queries it for every reviewed trial and shows that the lab thresholds TrialLens reviews are usually **absent from the registry** and had to be read from the protocol PDF. | **Operational.** Deployed to environment `trllf247b678` (deployment `cmvco4ewl01ct014wpkr04aev`, then redeployed with explicit resolver outputs). Online queries from the CLI and from the app succeed, e.g. query `cmvcog6jd001d0g9avt2v2jvr` for NCT03409614, about 0.1–0.9 s. |
| **Chalk Compute + Evaluations** (`chalk_project/trialforge_chalk_eval.py`, generated) | The deterministic verifier runs as a Chalk function (`tf_verify`) over the 39 developer-designed verifier cases (24 injected faults, 10 valid, 5 ambiguous). It is scored by Chalk scorers (`verdict_correct`, `valid-json`, plus two list-returning scorers). | **Operational.** Evaluation `cmvco3m0n01dw01y520oc80sq`, run `e61fce6c-892f-4215-9122-48ad77c42df6`: SUCCEEDED, 39 rows, 0 task errors. Remote verdicts: 24/24 faults rejected, 0/10 valid rejected, 5/5 ambiguous flagged. Chalk scorer `verdict_correct` mean = 1.0 (n = 39). The two list-returning scorers recorded no numeric values in the result table, so their metrics are computed from the remote outputs instead. |
| **Model Gateway (router)** | LLM critic (may only downgrade a flag), free-text challenge → structured claims, LLM-only verifier baseline. OpenAI-compatible endpoint `https://api.chalk.ai/v1/router`, header `X-Chalk-Env-Id`, model `openai/gpt-6.1-sol`, `max_tokens` set, no `temperature`. | **Implemented, not yet called.** Needs `CHALK_ROUTER_API_KEY` in `.env`. The endpoint was probed without a key and returns `401 invalid_api_key`, so it exists and requires a key. |
| Sandboxes, traces | — | Not used. |

## Setup that was performed

- `chalk login` (by the user), then `chalk init` from the project root, run non-interactively. A `pip freeze` diff showed **no packages removed or changed**. It added `chalk.yaml`, `.chalkignore`, `uv.lock` and editor settings, and kept our `.gitignore` and `README.md`.
- `chalk mcp configure-claude --claude-scope local`: the MCP server is registered for this project only, and nothing is written to the repo.
- **Dependency isolation.** Chalk's feature-serving runtime requires `pydantic<2`, which conflicts with the web app (FastAPI). The root `chalk.yaml` therefore points at `chalk_project/feature_store/requirements.txt`, and `.chalkignore` excludes the app code from uploads.

## Reproduce

```bash
~/.chalk/bin/chalk login && ~/.chalk/bin/chalk user          # pick an environment with Evaluations enabled
~/.chalk/bin/chalk apply --force                              # from the repo root: deploys the Trial feature set
~/.chalk/bin/chalk query --in trial.nct_id=NCT03409614 --out trial.registry_mentions_anc --out trial.has_protocol_pdf

uv run python -m chalk_project.build_eval_bundle              # bundle verifier + dataset (dataset embeds protocol text; not committed)
cd chalk_project && uv run python trialforge_chalk_eval.py --run   # writes data/chalk_eval_run.json and data/chalk_eval_rows.json

# Model Gateway: put CHALK_ROUTER_API_KEY=... in .env (never commit it), then
uv run python -m evals.run_evals --llm                        # adds the LLM-only verifier baseline
```

Why the eval is bundled: Chalk deploys a function by importing its single file, so `build_eval_bundle.py` inlines the exact `trialforge/verifier.py` source. Each dataset row carries the frozen review context (criteria, regimen, comparator thresholds, FDA texts, a registry snapshot), so the remote function needs no network access.
