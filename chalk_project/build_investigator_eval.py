"""Build the Chalk Evaluation bundle `protocolos-investigator` (local only; runs nothing remote).

Same pattern as build_eval_bundle.py. Writes two generated, uncommitted files:
  chalk_project/investigator_dataset.jsonl     one row per base answer, mutant and control
  chalk_project/protocolos_investigator_eval.py the template with trialforge/verifier.py and the pure
                                               check_answer section of trialforge/investigate.py inlined

Rows carry the answer, the criterion's graph, a trimmed review context and the quote lookups that
check_answer made while the row was checked locally (resolved from the cached documents), so the remote
task needs no network. Before writing, every row is re-checked with the trimmed context and the frozen
lookups and must give the same failed checks as the full local check.

    .venv/bin/python -m chalk_project.build_investigator_eval
"""
from __future__ import annotations

import json
from pathlib import Path

from evals.investigator.cases import base_answers, build_cases, offline_tools
from trialforge import investigate as inv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATASET = HERE / "investigator_dataset.jsonl"
BUNDLE = HERE / "protocolos_investigator_eval.py"


def review_ctx(review: dict, cid: str) -> dict:
    """What check_answer and verifier.verify read, for one criterion."""
    crit = next(c for c in review["target"]["criteria"] if c["id"] == cid)
    item = inv._review_item(review, cid)
    return {
        "as_of": review.get("as_of"),
        "target": {"study": {"nct_id": review["target"]["study"]["nct_id"]}, "criteria": [crit], "regimen": review["target"]["regimen"]},
        "comparators": [{"study": {"nct_id": c["study"]["nct_id"], "start_date": c["study"].get("start_date")}, "regimen": c["regimen"],
                         "criteria": [x for x in c.get("criteria", []) if x.get("analyte") == crit.get("analyte")]}
                        for c in review.get("comparators", [])],
        "reviews": [{"criterion": {"id": cid}, "classification": item["classification"]}],
    }


def recording(real: dict) -> tuple[dict, dict]:
    """Wrap the document-backed resolvers and record every lookup (normalized quote -> result)."""
    table: dict = {"protocol_quote": {}, "registry_quote": {}, "fda_quote": {}, "guidance_by_key": {}}

    def pq(n, q):
        r = real["protocol_quote"](n, q)
        table["protocol_quote"].setdefault(n, {})[inv._norm(q)] = r
        return r

    def rq(n, q):
        r = real["registry_quote"](n, q)
        table["registry_quote"].setdefault(n, {})[inv._norm(q)] = r
        return r

    def fq(g, q):
        r = real["fda_quote"](g, q)
        table["fda_quote"].setdefault(str(g), {})[inv._norm(q)] = r.get("ok")
        return r

    def gk(node):
        r = real["guidance_key"](node)
        key = (node.get("data") or {}).get("key")
        if key is not None:
            table["guidance_by_key"][str(key)] = r
        return r

    return {"protocol_quote": pq, "registry_quote": rq, "fda_quote": fq, "guidance_key": gk}, table


def frozen(table: dict) -> dict:
    """The same lookups the generated bundle performs (see investigator_eval_template._offline_resolvers)."""
    return {
        "protocol_quote": lambda n, q: table["protocol_quote"].get(n, {}).get(inv._norm(q)),
        "registry_quote": lambda n, q: table["registry_quote"].get(n, {}).get(inv._norm(q)),
        "fda_quote": lambda g, q: ({"ok": table["fda_quote"].get(str(g), {}).get(inv._norm(q))}
                                   if table["fda_quote"].get(str(g), {}).get(inv._norm(q)) is not None else {"ok": None}),
        "guidance_key": lambda node: table["guidance_by_key"].get(str((node.get("data") or {}).get("key"))),
    }


def _failed(checks: list[dict]) -> list[str]:
    return sorted({c["check"] for c in checks if c["result"] == "fail"})


def main():
    with offline_tools():
        rows = build_cases(base_answers())
    real = inv.default_check_resolvers()
    out, mismatched = [], []
    for r in rows:
        res, table = recording(real)
        full = _failed(inv.check_answer(r["answer"], r["graph"], r["review"], res))
        ctx = review_ctx(r["review"], r["criterion_id"])
        trimmed = _failed(inv.check_answer(r["answer"], r["graph"], ctx, frozen(table)))
        if trimmed != full:
            mismatched.append((r["case_id"], full, trimmed))
        out.append({
            "case_id": r["case_id"], "kind": r["kind"], "mutant_type": r["mutant_type"], "variant": r["variant"],
            "expected_check": r["expected_check"], "criterion_id": r["criterion_id"], "question": r["question"],
            "answer_json": json.dumps(r["answer"], ensure_ascii=False),
            "graph_json": json.dumps(r["graph"], ensure_ascii=False),
            "review_json": json.dumps(ctx, ensure_ascii=False),
            "offline_json": json.dumps(table, ensure_ascii=False),
            "expected": "REJECTED" if r["kind"] == "mutant" else "NOT_REJECTED",
            "local_rejected": bool(full), "local_failed_checks": full,
        })
    if mismatched:
        raise SystemExit(f"trimmed context / frozen lookups disagree with the full check on {len(mismatched)} row(s): {mismatched[:3]}")
    DATASET.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out) + "\n")

    verifier_src = (ROOT / "trialforge" / "verifier.py").read_text()
    verifier_src = verifier_src.split("def default_resolvers")[0].replace("from __future__ import annotations\n", "")
    inv_src = (ROOT / "trialforge" / "investigate.py").read_text()
    check_src = inv_src.split("# <<CHECK_START>>", 1)[1].split("# <<CHECK_END>>", 1)[0]
    check_src = check_src.split("\n", 1)[1]  # drop the rest of the marker line
    template = (HERE / "investigator_eval_template.py").read_text()
    BUNDLE.write_text(template.replace("# <<VERIFIER_SOURCE>>", verifier_src).replace("# <<CHECK_SOURCE>>", check_src))
    kinds = {k: sum(r["kind"] == k for r in out) for k in ("base", "mutant", "control")}
    print(f"wrote {len(out)} rows ({', '.join(f'{v} {k}' for k, v in kinds.items())}) to {DATASET.relative_to(ROOT)} "
          f"({DATASET.stat().st_size // 1024} KiB) and {BUNDLE.relative_to(ROOT)}; "
          f"trimmed context + frozen lookups match the full local check on {len(out)}/{len(out)} rows; nothing was run on Chalk")


if __name__ == "__main__":
    main()
