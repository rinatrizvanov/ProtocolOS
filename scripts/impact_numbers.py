"""Measured numbers for the impact slide. Writes evals/impact/impact_numbers.json.

Only measured values, never predicted gains:
- the NHANES share of US adults below the EL3 (NCT03409614) hemoglobin threshold, at the trial's own value and
  at each comparator's value, with the NHANES caveat (a population share, not a trial-eligible share);
- the draft eval summary (evals/draft/results.json), when it exists;
- the planted-issue and verifier evaluation numbers, copied by reference from their committed result files.

Run: .venv/bin/python -m scripts.impact_numbers
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from trialforge import nhanes

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "evals" / "impact" / "impact_numbers.json"
REVIEW = ROOT / "data" / "reviews" / "NCT03409614_auto.json"
NCT, CRITERION = "NCT03409614", "hemoglobin"


def _load(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def nhanes_section() -> dict:
    review = _load(REVIEW)
    if review is None:
        return {"status": "not measured", "reason": f"{REVIEW.relative_to(ROOT)} is missing; run scripts.prewarm first"}
    target = next(r["criterion"] for r in review["reviews"] if r["criterion"]["id"] == CRITERION)
    values = {("trial", target["value_norm"]): [NCT]}
    for comp in review["comparison"].get(CRITERION, []):
        c = comp.get("criterion") or {}
        if c.get("operator") in ("≥", ">") and c.get("unit_norm") == target["unit_norm"] and c.get("value_norm") is not None:
            values.setdefault(("comparator", c["value_norm"]), []).append(comp["acronym"] or comp["nct_id"])
    rows = []
    for (role, value), who in sorted(values.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        r = nhanes.below_threshold(CRITERION, value, 18)
        rows.append({
            "role": role, "threshold": value, "unit": r["unit"], "used_by": who, "rule": r["rule"],
            "overall_pct": r["overall"]["pct"], "overall_se": r["overall"]["se"], "n": r["overall"]["n"],
        })
    return {
        "status": "measured", "nct_id": NCT, "criterion_id": CRITERION,
        "trial_threshold": f"{target['operator']} {target['value_norm']} {target['unit_norm']}",
        "rows": rows, "source": nhanes.SOURCE, "caveat": nhanes.CAVEAT,
    }


def draft_section() -> dict:
    path = ROOT / "evals" / "draft" / "results.json"
    d = _load(path)
    if d is None:
        return {"status": "not measured", "reason": "evals/draft/results.json is not committed yet"}
    keep = {k: d[k] for k in ("summary", "drafted_without_verified_precedent", "overclaim_failures", "agreement") if k in d}
    return {"status": "measured", "source": str(path.relative_to(ROOT)), **keep}


def reference_section() -> dict:
    planted = _load(ROOT / "data" / "planted_results.json")
    verifier = _load(ROOT / "data" / "chalk_eval_run.json")
    out: dict = {}
    if planted is not None:
        out["planted"] = {"source": "data/planted_results.json", "summary": planted.get("summary")}
    if verifier is not None:
        fields = ("status", "rows", "verdicts_matching_expectation", "fault_rejected", "n_fault", "valid_rejected", "n_valid", "ambiguous_flagged")
        out["verifier_chalk_evaluation"] = {"source": "data/chalk_eval_run.json", **{k: verifier.get(k) for k in fields}}
    return out


def main() -> int:
    result = {
        "note": "Measured numbers only. NHANES shares describe US adults, not trial-eligible patients; they are not predicted enrollment changes.",
        "nhanes_hemoglobin": nhanes_section(),
        "draft_eval": draft_section(),
        "by_reference": reference_section(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n")
    nh = result["nhanes_hemoglobin"]
    for r in nh.get("rows", []):
        print(f"{r['role']:10s} {r['threshold']:>5} {r['unit']}: {r['overall_pct']}% of US adults below (n={r['n']}; {', '.join(r['used_by'])})")
    print(f"draft_eval: {result['draft_eval']['status']}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
