"""Local investigator evaluation: does check_answer() pass the deterministic answers and reject the mutants?

    .venv/bin/python -m evals.investigator.run

Writes evals/investigator/results.json. Base answers come from investigate() on the cached EL3 review
(no network). The developers wrote both the mutants and the
checker, so this measures whether the checker catches the defect classes we chose to plant, not how it
does on defects a model would actually produce.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

from trialforge import investigate as inv

from .cases import AS_OF, CONTROLS, MUTANTS, NCT, base_answers, build_cases, offline_tools

RESULTS = Path(__file__).resolve().parent / "results.json"
NOTE = ("The developers wrote both the mutants and the checker. Mutants are planted defects of the classes listed; "
        "a high rejection rate shows the checker catches these classes, not that it catches defects a model would produce. "
        "Base answers are the deterministic investigator's own output on the cached EL3 review (NCT03409614, as_of auto).")


def _fails(checks: list[dict]) -> list[dict]:
    return [c for c in checks if c["result"] == "fail"]


def evaluate(criteria: list[str] | None = None, out_path: Path | str = RESULTS) -> dict:
    t0 = time.monotonic()
    with offline_tools():
        bases = base_answers(criteria)
        rows = build_cases(bases)
        scored = []
        for r in rows:
            checks = inv.check_answer(r["answer"], r["graph"], r["review"])
            bad = _fails(checks)
            failed = sorted({c["check"] for c in bad})
            expected_hit = bool(r["expected_check"]) and any(
                c["check"] == r["expected_check"] and (r["statement_id"] is None or c["statement_id"] == r["statement_id"]) for c in bad)
            row = {"case_id": r["case_id"], "kind": r["kind"], "mutant_type": r["mutant_type"], "variant": r["variant"],
                   "criterion_id": r["criterion_id"], "question": r["question"], "expected_check": r["expected_check"],
                   "rejected": bool(bad), "expected_check_failed": expected_hit, "failed_checks": failed, "n_checks": len(checks)}
            if r["kind"] == "base":
                resp = r["base_response"]
                row["answer"] = {"classification": resp["classification"], "overall": resp["answer"]["overall"],
                                 "summary": resp["answer"]["summary"], "counterevidence": resp["counterevidence"],
                                 "statements": [{k: s[k] for k in ("id", "polarity", "status", "text", "evidence_ids")}
                                                for s in resp["answer"]["statements"]]}
            scored.append(row)

    base = [r for r in scored if r["kind"] == "base"]
    mutants = {}
    for mtype, variants in MUTANTS.items():
        rs = [r for r in scored if r["kind"] == "mutant" and r["mutant_type"] == mtype]
        mutants[mtype] = {"total": len(rs), "rejected": sum(r["rejected"] for r in rs),
                          "expected_check_failed": sum(r["expected_check_failed"] for r in rs),
                          "expected_checks": sorted({v[2] for v in variants}),
                          "not_rejected": [r["case_id"] for r in rs if not r["rejected"]]}
    controls = {}
    for ctype in CONTROLS:
        rs = [r for r in scored if r["kind"] == "control" and r["mutant_type"] == ctype]
        controls[ctype] = {"total": len(rs), "not_rejected": sum(not r["rejected"] for r in rs),
                           "rejected": [{"case_id": r["case_id"], "failed_checks": r["failed_checks"]} for r in rs if r["rejected"]]}
    statuses = Counter(s["status"] for r in base for s in r["answer"]["statements"])
    review = bases[0]["review"] if bases else {}
    out = {
        "suite": "protocolos-investigator (local)",
        "nct_id": NCT, "as_of": AS_OF,
        "review_fingerprint": inv.review_fingerprint(review) if review else None,
        "criteria": sorted({r["criterion_id"] for r in base}), "questions": list(inv.QUESTIONS),
        "note": NOTE,
        "base": {"total": len(base), "not_rejected": sum(not r["rejected"] for r in base),
                 "rejected": [{"case_id": r["case_id"], "failed_checks": r["failed_checks"]} for r in base if r["rejected"]],
                 "statement_status_counts": dict(sorted(statuses.items())),
                 "overall_counts": dict(sorted(Counter(r["answer"]["overall"] for r in base).items()))},
        "mutants": mutants,
        "mutants_all": {"total": sum(m["total"] for m in mutants.values()), "rejected": sum(m["rejected"] for m in mutants.values())},
        "controls": controls,
        "elapsed_s": round(time.monotonic() - t0, 2),
        "rows": scored,
    }
    out = json.loads(json.dumps(out, ensure_ascii=False, default=list))
    # summary indented, one line per row (keeps the committed file short and diffable)
    head = json.dumps({k: v for k, v in out.items() if k != "rows"}, indent=1, ensure_ascii=False)[:-2]
    rows_txt = ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in out["rows"])
    Path(out_path).write_text(head + ',\n "rows": [\n' + rows_txt + "\n ]\n}\n")
    return out


def main():
    out = evaluate()
    b = out["base"]
    print(f"base answers not rejected: {b['not_rejected']}/{b['total']}  (criteria {len(out['criteria'])} x questions {len(out['questions'])})")
    for mtype, m in out["mutants"].items():
        print(f"  {mtype:<24} rejected {m['rejected']}/{m['total']}  (expected check {', '.join(m['expected_checks'])} failed {m['expected_check_failed']}/{m['total']})")
    a = out["mutants_all"]
    print(f"  {'all mutants':<24} rejected {a['rejected']}/{a['total']}")
    for ctype, c in out["controls"].items():
        print(f"control {ctype}: not rejected {c['not_rejected']}/{c['total']}")
    print(out["note"])
    print(f"wrote {RESULTS.relative_to(RESULTS.parents[2])} in {out['elapsed_s']} s")


if __name__ == "__main__":
    main()
