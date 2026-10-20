"""Semantic comparator candidates, measured: keyword discovery alone versus keyword plus the semantic index.

For each gold protocol (evals/gold/criteria.json) and each preloaded trial, with comparators started before the
trial (as_of = its start date), runs the review twice: PROTOCOLOS_SEMANTIC_COMPARATORS off, then on. Records the
candidates each mode found, the comparators the review used, and every criterion whose classification differs.
Writes evals/semantic/results.json and prints a summary line. A changed classification is a different review
input, not an improvement or an error: no gold label says which comparators are right.

    .venv/bin/python -m evals.semantic.run      # needs data/index/ (python -m trialforge.trial_index build)
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from trialforge import comparators, trial_index
from trialforge.extract import analyze_trial
from trialforge.review import run_review

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "results.json"
PRELOADED = ["NCT03409614", "NCT02578680", "NCT03088540", "NCT02819518"]


def _targets() -> list[dict]:
    gold = json.loads((ROOT / "evals" / "gold" / "criteria.json").read_text())["protocols"]
    rows = [{"nct": g["nct"], "name": g.get("name"), "set": f"gold ({g.get('split')})"} for g in gold]
    rows += [{"nct": n, "name": None, "set": "preloaded"} for n in PRELOADED if n not in {r["nct"] for r in rows}]
    return rows


def _run(nct: str, semantic: bool) -> dict:
    os.environ["PROTOCOLOS_SEMANTIC_COMPARATORS"] = "1" if semantic else "0"
    target = analyze_trial(nct)
    target.pop("_doc", None)
    found = comparators.discover(target, 4, target["study"]["start_date"])
    review = run_review(nct)
    return {
        "candidates": [{"nct_id": c["nct_id"], "found_by": c["found_by"]} for c in found],
        "comparators": [{"nct_id": c["study"]["nct_id"], "found_by": c["similarity"].get("found_by")} for c in review["comparators"]],
        "classes": {r["criterion"]["id"]: r["classification"] for r in review["reviews"]},
    }


def main() -> int:
    if not trial_index.available():
        print("semantic index not available; build it with python -m trialforge.trial_index build")
        return 1
    t0 = time.time()
    rows = []
    for t in _targets():
        try:
            kw, sem = _run(t["nct"], False), _run(t["nct"], True)
        except Exception as e:  # a target whose documents cannot be read is reported, not dropped silently
            rows.append({**t, "error": f"{type(e).__name__}: {str(e)[:200]}"})
            continue
        changed = [{"criterion": c, "keyword": kw["classes"][c], "semantic": sem["classes"].get(c)}
                   for c in kw["classes"] if kw["classes"][c] != sem["classes"].get(c)]
        rows.append({**t, "keyword": kw, "semantic": sem, "classification_changes": changed,
                     "comparators_changed": [c["nct_id"] for c in kw["comparators"]] != [c["nct_id"] for c in sem["comparators"]]})
        print(f"{t['nct']}: keyword {len(kw['comparators'])} comparators, semantic {len(sem['comparators'])} "
              f"({sum(c['found_by'] == 'semantic' for c in sem['comparators'])} found only semantically); "
              f"{len(changed)} classification change(s)", flush=True)
    os.environ.pop("PROTOCOLOS_SEMANTIC_COMPARATORS", None)
    ok = [r for r in rows if "error" not in r]
    summary = {
        "targets": len(rows),
        "errors": len(rows) - len(ok),
        "targets_with_different_comparators": sum(r["comparators_changed"] for r in ok),
        "targets_without_keyword_comparators": sum(not r["keyword"]["comparators"] for r in ok),
        "of_those_with_semantic_comparators": sum(not r["keyword"]["comparators"] and bool(r["semantic"]["comparators"]) for r in ok),
        "semantic_only_comparators_used": sum(c["found_by"] == "semantic" for r in ok for c in r["semantic"]["comparators"]),
        "criteria": sum(len(r["keyword"]["classes"]) for r in ok),
        "criteria_with_changed_classification": sum(len(r["classification_changes"]) for r in ok),
    }
    OUT.write_text(json.dumps({
        "note": "Keyword discovery versus keyword plus semantic candidates, comparators started before each trial. "
                "A changed classification is a different review input, not an improvement or an error.",
        "index": trial_index.status(), "seconds": round(time.time() - t0, 1), "summary": summary, "targets": rows,
    }, indent=1))
    print(" ".join(f"{k}={v}" for k, v in summary.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
