"""Reproducible evaluation suite.

    .venv/bin/python -m evals.run_evals            # local runner
    .venv/bin/python -m evals.run_evals --llm      # also run the LLM-only verifier baseline (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)

Writes data/eval_results.json (shown in the dashboard's Evaluation tab) and prints a summary.
Every metric is computed from cached official documents and hand-labelled gold files; nothing is hard-coded.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from collections import defaultdict
from pathlib import Path

from trialforge import llm
from trialforge.comparators import direction
from trialforge.extract import analyze_trial
from trialforge.guidance import load_passages, normalize
from trialforge.review import run_review
from trialforge.sources import DATA, fetch_protocol, fetch_study
from trialforge.verifier import default_resolvers, verify

from .verifier_cases import CASES

GOLD = json.loads((Path(__file__).parent / "gold" / "criteria.json").read_text())
OUT = DATA / "eval_results.json"


def close(a, b):
    return a is not None and b is not None and abs(float(a) - float(b)) < 1e-6


def eval_extraction():
    rows, per_split = [], defaultdict(lambda: {"fields": 0, "correct": 0, "gold": 0, "found": 0, "extracted": 0})
    analyses = {}
    for p in GOLD["protocols"]:
        a = analyze_trial(p["nct"])
        a.pop("_doc", None)
        analyses[p["nct"]] = a
        got = {c["id"]: c for c in a["criteria"]}
        s = per_split[p["split"]]
        for cid, (op, val) in p["criteria"].items():
            s["gold"] += 1
            c = got.get(cid)
            if c is not None:
                s["extracted"] += 1
            ok_val = c is not None and close(c["value_norm"], val)
            ok_op = c is not None and c["operator"] == op
            s["fields"] += 2
            s["correct"] += int(ok_val) + int(ok_op)
            s["found"] += int(ok_val and ok_op)
            why = "" if (ok_val and ok_op) else ("not extracted" if c is None else ("wrong value" if not ok_val else "wrong operator"))
            rows.append({"nct": p["nct"], "name": p["name"], "split": p["split"], "id": cid, "gold": f"{op}{val}",
                         "got": f"{c['operator']}{c['value_norm']}" if c else "—", "ok": ok_val and ok_op, "why": why,
                         "page": c["source"]["page"] if c else None})
        for cid in p.get("known_wrong_unlabelled", []):
            s["extracted"] += 1  # extracted, known wrong, true value not labellable: counts against precision
            rows.append({"nct": p["nct"], "name": p["name"], "split": p["split"], "id": cid, "gold": "unlabellable", "got": f"{got[cid]['operator']}{got[cid]['value_norm']}" if cid in got else "—", "ok": False, "why": "known wrong (true value not recoverable from text layout)", "page": None})
    tot = {k: sum(s[k] for s in per_split.values()) for k in ("fields", "correct", "gold", "found", "extracted")}
    splits = {k: {**v, "criterion_accuracy": v["found"] / v["gold"] if v["gold"] else None} for k, v in per_split.items()}
    return {
        "protocols": len(GOLD["protocols"]),
        "total": tot["fields"], "correct": tot["correct"], "field_accuracy": tot["correct"] / tot["fields"],
        "gold_criteria": tot["gold"], "found_correct": tot["found"], "extracted": tot["extracted"],
        "value_recall": tot["found"] / tot["gold"], "precision": tot["found"] / tot["extracted"] if tot["extracted"] else None,
        "by_split": splits, "rows": rows,
    }, analyses


def eval_regimen(analyses):
    tp = fp = fn = 0
    rows = []
    for nct, gold in GOLD["regimens"].items():
        if nct.startswith("_"):
            continue
        a = analyses.get(nct) or analyze_trial(nct)
        got = set(a["regimen"]["drugs"])
        g = set(gold)
        tp += len(got & g); fp += len(got - g); fn += len(g - got)
        rows.append({"nct": nct, "extra": sorted(got - g), "missing": sorted(g - got)})
    return {"protocols": len(rows), "precision": tp / (tp + fp), "recall": tp / (tp + fn), "tp": tp, "fp": fp, "fn": fn, "rows": rows}


def eval_comparison(analyses):
    """Every ordered pair of gold protocols x shared analyte: pipeline direction vs gold direction."""
    total = correct = 0
    errors = []
    prots = GOLD["protocols"]
    for t in prots:
        for c in prots:
            if t is c:
                continue
            ta = {x["id"]: x for x in analyses[t["nct"]]["criteria"]}
            ca = {x["id"]: x for x in analyses[c["nct"]]["criteria"]}
            for cid in set(t["criteria"]) & set(c["criteria"]):
                gold_dir = direction(cid, t["criteria"][cid][1], c["criteria"][cid][1])
                if cid in ta and cid in ca:
                    got_dir = direction(cid, ta[cid]["value_norm"], ca[cid]["value_norm"])
                else:
                    got_dir = "not compared (missing extraction)"
                total += 1
                if got_dir == gold_dir:
                    correct += 1
                else:
                    errors.append({"target": t["nct"], "comparator": c["nct"], "criterion": cid, "gold": gold_dir, "got": got_dir})
    missing = sum(1 for e in errors if e["got"].startswith("not compared"))
    compared = total - missing
    return {"total": total, "correct": correct, "accuracy": correct / total,
            "compared": compared, "accuracy_when_compared": correct / compared if compared else None,
            "missing_extraction": missing, "wrong_direction": len(errors) - missing,
            "errors": [e for e in errors if not e["got"].startswith("not compared")][:40]}


def eval_citations(analyses):
    passages, failed = load_passages()
    prot_ok = prot_total = 0
    misses = []
    for nct, a in analyses.items():
        doc = fetch_protocol(nct)
        for c in a["criteria"]:
            if c["source"]["doc"] != "protocol":
                continue
            prot_total += 1
            page_text = normalize(doc.pages[c["source"]["page"] - 1])
            if normalize(c["source"]["text"]) in page_text:
                prot_ok += 1
            else:
                misses.append({"nct": nct, "id": c["id"], "page": c["source"]["page"]})
    # every NCT the system cites as a comparator for the three demo-relevant targets
    nct_total = nct_ok = 0
    for t in ("NCT03409614", "NCT02578680", "NCT03088540"):
        r = run_review(t)
        for comp in r["comparators"]:
            nct_total += 1
            try:
                fetch_study(comp["study"]["nct_id"])
                nct_ok += 1
            except Exception:
                pass
    return {"fda_total": len(passages) + len(failed), "fda_ok": len(passages), "fda_quote_accuracy": len(passages) / (len(passages) + len(failed)),
            "prot_total": prot_total, "prot_ok": prot_ok, "protocol_quote_accuracy": prot_ok / prot_total if prot_total else None, "prot_misses": misses,
            "nct_total": nct_total, "nct_ok": nct_ok, "nct_exist": nct_ok / nct_total if nct_total else None}


def eval_verifier(creds):
    """`creds`: llm.Credentials for the LLM-only baseline, or None to skip it."""
    run_llm = creds is not None
    R = default_resolvers()
    ctxs = {}
    res = []
    for case in CASES:
        ctx = ctxs.setdefault(case["nct"], run_review(case["nct"]))
        rec = dict(case["rec"])
        rec.setdefault("proposed_unit", None)
        det = verify(rec, ctx, R)
        expected = {"fault": "REJECTED", "valid": "not REJECTED", "ambiguous": "PASSED_WITH_WARNINGS"}[case["kind"]]
        if case["kind"] == "fault":
            det_ok = det["status"] == "REJECTED"
        elif case["kind"] == "valid":
            det_ok = det["status"] != "REJECTED"
        else:
            det_ok = det["status"] == "PASSED_WITH_WARNINGS"
        row = {"id": case["id"], "kind": case["kind"], "fault_type": case.get("fault_type"), "description": case["description"], "nct": case["nct"],
               "expected": expected, "det_status": det["status"], "det_ok": det_ok,
               "det_failed_checks": [c["check"] for c in det["checks"] if c["result"] == "fail"],
               "det_warned_checks": [c["check"] for c in det["checks"] if c["result"] == "warn"]}
        if run_llm:
            try:
                lv = llm.llm_only_verify(rec, ctx, creds)
                row["llm_status"] = lv["status"]
                row["llm_reasons"] = lv["reasons"]
            except Exception as e:
                row["llm_status"] = f"error: {e}"
        res.append(row)

    def summarize(status_of):
        faults = [r for r in res if r["kind"] == "fault"]
        valid = [r for r in res if r["kind"] == "valid"]
        amb = [r for r in res if r["kind"] == "ambiguous"]
        s = {k: status_of(r) for k, r in ((r["id"], r) for r in res)}
        if any(v is None for v in s.values()):
            return None
        return {
            "fault_catch_rate": sum(s[r["id"]] == "REJECTED" for r in faults) / len(faults),
            "false_rejection_rate": sum(s[r["id"]] == "REJECTED" for r in valid) / len(valid),
            "ambiguous_agreement": sum(s[r["id"]] in ("PASSED_WITH_WARNINGS",) for r in amb) / len(amb),
        }

    det = summarize(lambda r: r["det_status"])
    nov = summarize(lambda r: "PASSED")
    nov["note"] = "accepts every recommendation"
    llm_s = None
    if run_llm:
        llm_s = summarize(lambda r: r.get("llm_status") if r.get("llm_status") in ("REJECTED", "PASSED") else None)
        if llm_s:
            llm_s["note"] = f"{creds.label()}; binary PASSED/REJECTED (cannot emit warnings, so ambiguous agreement is 0 by construction)"
    return {
        "n_faults": sum(r["kind"] == "fault" for r in res), "n_valid": sum(r["kind"] == "valid" for r in res),
        "n_ambiguous": sum(r["kind"] == "ambiguous" for r in res),
        "deterministic": det, "no_verifier": nov,
        "llm_only": llm_s or {"note": "not run (pass --llm with ANTHROPIC_API_KEY or OPENAI_API_KEY set)"},
        "cases": res,
    }


def eval_classification():
    rows = []
    for nct, exp in GOLD["expected_classification"].items():
        if nct.startswith("_"):
            continue
        r = run_review(nct)
        got = {x["criterion"]["id"]: x["classification"] for x in r["reviews"]}
        for cid, e in exp.items():
            rows.append({"nct": nct, "id": cid, "expected": e, "got": got.get(cid, "—"), "ok": got.get(cid) == e})
    return {"total": len(rows), "correct": sum(r["ok"] for r in rows), "accuracy": sum(r["ok"] for r in rows) / len(rows), "rows": rows,
            "note": GOLD["expected_classification"]["_about"]}


def first_run_summary():
    """The very first full run, before fixing bugs it exposed (kept so post-hoc fixes are visible)."""
    p = Path(__file__).parent / "first_run_snapshot.json"
    if not p.exists():
        return None
    r = json.loads(p.read_text())["suites"]
    ex = r["extraction"]
    by = {}
    for row in ex["rows"]:
        b = by.setdefault(row["split"], [0, 0])
        b[0] += row["ok"]; b[1] += 1
    return {"generated_at": json.loads(p.read_text())["generated_at"], "extraction_by_split": {k: f"{a}/{b}" for k, (a, b) in by.items()},
            "extraction_total": f"{ex['found_correct']}/{ex['gold_criteria']}", "regimen_precision": r["regimen"]["precision"],
            "fixes_after": ["eligibility region: choose the heading occurrence with most requirement lines (synopsis vs full section) - fixed CheckMate 649"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--llm", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    extraction, analyses = eval_extraction()
    suites = {
        "extraction": extraction,
        "regimen": eval_regimen(analyses),
        "comparison": eval_comparison(analyses),
        "citations": eval_citations(analyses),
        "verifier": eval_verifier(llm.from_env() if args.llm else None),
        "classification": eval_classification(),
    }
    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "runner": "local (evals/run_evals.py)",
        "seconds": round(time.time() - t0, 1),
        "first_run": first_run_summary(),
        "suites": suites,
    }
    OUT.write_text(json.dumps(out, indent=1, default=list))
    e, v = suites["extraction"], suites["verifier"]
    print(f"Extraction: field accuracy {e['field_accuracy']:.3f} ({e['correct']}/{e['total']}); criteria correct {e['found_correct']}/{e['gold_criteria']}; precision {e['precision']:.3f}")
    for k, s in e["by_split"].items():
        print(f"   {k:8s}: {s['found']}/{s['gold']} criteria correct ({s['criterion_accuracy']:.3f})")
    for r in e["rows"]:
        if not r["ok"]:
            print(f"   MISS {r['split']:8s} {r['name']:22s} {r['id']:24s} gold {r['gold']:8s} got {r['got']:8s} ({r['why']})")
    g = suites["regimen"]
    print(f"Regimen: precision {g['precision']:.3f} recall {g['recall']:.3f} (tp {g['tp']}, fp {g['fp']}, fn {g['fn']})")
    for r in g["rows"]:
        if r["extra"] or r["missing"]:
            print(f"   {r['nct']}: extra {r['extra']} missing {r['missing']}")
    c = suites["comparison"]
    print(f"Comparison directions: {c['correct']}/{c['total']} ({c['accuracy']:.3f}); when both values extracted {c['correct']}/{c['compared']}; "
          f"missing extraction {c['missing_extraction']}, wrong direction {c['wrong_direction']}")
    ci = suites["citations"]
    print(f"Citations: FDA {ci['fda_ok']}/{ci['fda_total']}; protocol lines on cited page {ci['prot_ok']}/{ci['prot_total']}; comparator NCTs exist {ci['nct_ok']}/{ci['nct_total']}")
    print(f"Verifier ({v['n_faults']} faults, {v['n_valid']} valid, {v['n_ambiguous']} ambiguous):")
    for name in ("no_verifier", "deterministic", "llm_only"):
        print(f"   {name:14s} {v[name]}")
    for r in v["cases"]:
        if not r["det_ok"]:
            print(f"   DISAGREE {r['id']} {r['kind']} expected {r['expected']} got {r['det_status']} fails={r['det_failed_checks']} warns={r['det_warned_checks']}")
    cl = suites["classification"]
    print(f"Classification vs (non-blind) expectations: {cl['correct']}/{cl['total']}")
    for r in cl["rows"]:
        if not r["ok"]:
            print(f"   {r}")
    print(f"done in {out['seconds']}s -> {OUT}")


if __name__ == "__main__":
    main()
