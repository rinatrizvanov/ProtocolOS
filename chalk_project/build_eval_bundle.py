"""Build the Chalk Evaluation for the TrialForge verifier.

Chalk deploys an evaluation's task/scorer functions by importing a single file, so this script
writes a self-contained file (chalk_project/trialforge_chalk_eval.py) that inlines the exact
source of trialforge/verifier.py plus an offline resolver, and a dataset (JSONL) whose rows carry
everything the verifier needs: the recommendation, the frozen review context (criteria, regimen,
comparator thresholds), the FDA guidance texts, the target protocol text, and the registry snapshot
for cited NCT IDs. The remote run therefore executes the same checks as the local suite, without
network access.

    .venv/bin/python -m chalk_project.build_eval_bundle
    cd chalk_project && ../.venv/bin/python trialforge_chalk_eval.py --run [--judge-model MODEL]
"""
from __future__ import annotations

import json
from pathlib import Path

from evals.verifier_cases import CASES
from trialforge.extract import analyze_trial
from trialforge.guidance import indexes, normalize
from trialforge.review import run_review
from trialforge.sources import fetch_protocol, fetch_study

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def trim_ctx(r: dict) -> dict:
    return {
        "as_of": r["as_of"],
        "target": {"study": {"nct_id": r["target"]["study"]["nct_id"]}, "criteria": r["target"]["criteria"], "regimen": r["target"]["regimen"]},
        "comparators": [{"study": {"nct_id": c["study"]["nct_id"], "start_date": c["study"]["start_date"]}, "regimen": c["regimen"], "criteria": c["criteria"]} for c in r["comparators"]],
    }


def registry_snapshot(case) -> dict:
    """For every NCT the case cites: does it exist, and what thresholds does its protocol state."""
    snap = {}
    for cl in case["rec"].get("claims", []):
        if cl.get("type") != "comparator_threshold":
            continue
        n = str(cl.get("nct_id", "")).upper()
        try:
            fetch_study(n)
            a = analyze_trial(n)
            a.pop("_doc", None)
            snap[n] = {"exists": True, "criteria": a["criteria"]}
        except Exception as e:
            snap[n] = {"exists": False if "404" in str(e) else None, "criteria": []}
    return snap


def main():
    fda = {k: idx.text for k, idx in indexes().items()}
    ctxs, prot_text, rows = {}, {}, []
    for case in CASES:
        n = case["nct"]
        if n not in ctxs:
            ctxs[n] = trim_ctx(run_review(n))
            prot_text[n] = normalize(fetch_protocol(n).full_text)
        uses_prot = any(c.get("type") == "protocol_quote" for c in case["rec"].get("claims", []))
        offline = {"fda_texts": fda, "protocol_text": prot_text[n] if uses_prot else None, "registry": registry_snapshot(case)}
        rows.append({
            "case_id": case["id"], "kind": case["kind"], "fault_type": case.get("fault_type") or "",
            "description": case["description"],
            "rec_json": json.dumps(case["rec"], ensure_ascii=False),
            "ctx_json": json.dumps(ctxs[n], ensure_ascii=False),
            "offline_json": json.dumps(offline, ensure_ascii=False),
            "expected": {"fault": "REJECTED", "valid": "NOT_REJECTED", "ambiguous": "PASSED_WITH_WARNINGS"}[case["kind"]],
        })
    (HERE / "eval_dataset.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))

    verifier_src = (ROOT / "trialforge" / "verifier.py").read_text()
    # drop the network-backed default_resolvers(); the bundle provides an offline equivalent
    verifier_src = verifier_src.split("def default_resolvers")[0].replace("from __future__ import annotations\n", "")
    template = (HERE / "chalk_eval_template.py").read_text()
    bundle = template.replace("# <<VERIFIER_SOURCE>>", verifier_src)
    (HERE / "trialforge_chalk_eval.py").write_text(bundle)
    print(f"wrote {len(rows)} rows to chalk_project/eval_dataset.jsonl and chalk_project/trialforge_chalk_eval.py")


if __name__ == "__main__":
    main()
