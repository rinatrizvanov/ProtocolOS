"""Planted-issue evaluation on synthetic modifications of authentic, previously unseen protocols.

    .venv/bin/python -m evals.planted.make_variants   # (re)generate variants + answer key
    .venv/bin/python -m evals.run_planted             # score

Scoring (per Regeneron 'Trial by Design, Part 2': plant issues in real protocols, keep an answer key,
report recall). A planted stricter threshold is not assumed to be clinically wrong. What is scored:

  extracted      - the planted value was extracted from the modified text (pipeline saw the change)
  surfaced       - the review shows at least one comparable trial with a more permissive threshold for
                   that criterion (the specific discrepancy is put in front of the reviewer)
  escalated      - classification is "Review recommended" (strict) / not "Evidence supports retaining" (lenient)
  differential   - escalated in the variant but NOT in the unmodified control (the change itself caused it)
  cautious       - the suggested action is a review action (justify / add provision / review), never 'remove'

Looser plants: a false over-restriction flag = "Review recommended" with a more-permissive comparator
for the loosened criterion (i.e. flagged as too strict after being made looser).
"""
from __future__ import annotations

import json
import time
from copy import deepcopy
from pathlib import Path

from trialforge.review import CLASS_RETAIN, CLASS_REVIEW, run_review
from trialforge.sources import DATA, PdfDoc, fetch_protocol

HERE = Path(__file__).resolve().parent / "planted"
OUT = DATA / "planted_results.json"


def modified_doc(base: str, subs: list[dict]) -> PdfDoc:
    doc = fetch_protocol(base)
    pages = list(doc.pages)
    for s in subs:
        lines = pages[s["page"] - 1].splitlines()
        if lines[s["line_index"]] != s["original"]:
            raise ValueError(f"substitution anchor mismatch in {base} p{s['page']}")
        lines[s["line_index"]] = s["modified"]
        pages[s["page"] - 1] = "\n".join(lines)
    return PdfDoc(doc.source_id + "+planted", doc.url, doc.path, pages)


def summarize_criterion(review: dict, analyte: str) -> dict | None:
    rv = next((r for r in review["reviews"] if r["criterion"]["id"] == analyte), None)
    if rv is None:
        return None
    looser = [r for r in review["comparison"][analyte] if r["direction"] == "comparator looser"]
    return {
        "value": rv["criterion"]["value_norm"],
        "classification": rv["classification"],
        "surfaced": bool(looser),
        "n_permissive_comparators": len(looser),
        "action": rv["suggested_action"]["action"],
        "explanation": rv["explanation"],
    }


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default="auto", help="'auto' = comparators started before each protocol (historical); 'none' = all comparators (draft-review-today scenario)")
    args = ap.parse_args()
    as_of = None if args.as_of == "none" else "auto"
    out_path = OUT if args.as_of == "auto" else DATA / "planted_results_no_cutoff.json"
    variants = json.loads((HERE / "variants.json").read_text())
    key = json.loads((HERE / "answer_key.json").read_text())["variants"]
    t0 = time.time()
    controls: dict[str, dict] = {}
    rows = []
    for v in variants:
        k = key[v["id"]]
        doc = modified_doc(v["base"], v["substitutions"]) if v["substitutions"] else None
        review = run_review(v["base"], doc_override=doc, as_of=as_of)
        if k["kind"] == "control":
            controls[v["base"]] = review
            continue
        rows.append((v, k, review))

    scored = []
    for v, k, review in rows:
        a = k["analyte"]
        var = summarize_criterion(review, a)
        ctl = summarize_criterion(controls[v["base"]], a)
        extracted = var is not None and abs(var["value"] - k["planted_value"]) < 1e-9
        rec = {"id": v["id"], "name": v["name"], "kind": k["kind"], "analyte": a, "from": k["original_value"], "to": k["planted_value"], "unit": k["unit"],
               "extracted": extracted, "variant": var, "control": ctl}
        if k["kind"] == "stricter":
            rec["surfaced"] = bool(extracted and var["surfaced"])
            rec["escalated_strict"] = bool(extracted and var["classification"] == CLASS_REVIEW)
            rec["escalated_lenient"] = bool(extracted and var["classification"] != CLASS_RETAIN)
            rec["differential"] = bool(rec["escalated_strict"] and ctl and ctl["classification"] != CLASS_REVIEW)
            rec["control_already_flagged"] = bool(ctl and ctl["classification"] == CLASS_REVIEW)
            rec["cautious_action"] = bool(var and var["action"] != "remove")
        else:
            rec["false_over_restriction_flag"] = bool(extracted and var["classification"] == CLASS_REVIEW and var["surfaced"])
        scored.append(rec)

    strict = [r for r in scored if r["kind"] == "stricter"]
    loose = [r for r in scored if r["kind"] == "looser"]
    frac = lambda xs, f: (sum(1 for x in xs if f(x)), len(xs))
    ctrl_flags = []
    for base, review in controls.items():
        for r in review["reviews"]:
            ctrl_flags.append({"base": base, "id": r["criterion"]["id"], "classification": r["classification"]})
    not_flagged_in_control = [r for r in strict if not r["control_already_flagged"]]
    summary = {
        "label": "Synthetic modifications to authentic, previously unseen protocols (5 bases). Not clinical validation.",
        "comparator_mode": "historical: comparators started before each protocol" if as_of else "draft-review-today: all comparators, no date cutoff",
        "stricter": {
            "n": len(strict),
            "extracted": frac(strict, lambda r: r["extracted"]),
            "discrepancy_surfaced": frac(strict, lambda r: r["surfaced"]),
            "escalated_strict": frac(strict, lambda r: r["escalated_strict"]),
            "escalated_lenient": frac(strict, lambda r: r["escalated_lenient"]),
            "differential_detection_where_control_not_flagged": frac(not_flagged_in_control, lambda r: r["differential"]),
            "control_already_flagged": frac(strict, lambda r: r["control_already_flagged"]),
            "cautious_action": frac(strict, lambda r: r["cautious_action"]),
        },
        "looser": {"n": len(loose), "extracted": frac(loose, lambda r: r["extracted"]),
                    "false_over_restriction_flags": frac(loose, lambda r: r["false_over_restriction_flag"])},
        "controls": {
            "criteria": len(ctrl_flags),
            "review_recommended": sum(1 for c in ctrl_flags if c["classification"] == CLASS_REVIEW),
            "by_criterion": {cid: sum(1 for c in ctrl_flags if c["id"] == cid and c["classification"] == CLASS_REVIEW) for cid in sorted({c["id"] for c in ctrl_flags})},
            "note": "Flags on unmodified protocols are not counted as errors: several come from criterion-specific FDA recommendations (ECOG PS2, Duffy-null ANC). They are reported so differential detection can be interpreted.",
        },
        "seconds": round(time.time() - t0, 1),
    }
    out_path.write_text(json.dumps({"summary": summary, "rows": scored, "controls": ctrl_flags}, indent=1))
    s = summary["stricter"]
    print(summary["label"])
    for k2, v2 in s.items():
        print(f"  stricter {k2:50s} {v2 if isinstance(v2, int) else f'{v2[0]}/{v2[1]}'}")
    print(f"  looser extracted {summary['looser']['extracted'][0]}/{summary['looser']['extracted'][1]}; false over-restriction flags {summary['looser']['false_over_restriction_flags'][0]}/{summary['looser']['false_over_restriction_flags'][1]}")
    print(f"  controls: {summary['controls']['review_recommended']}/{summary['controls']['criteria']} criteria flagged on unmodified protocols; by criterion {summary['controls']['by_criterion']}")
    for r in scored:
        if r["kind"] == "stricter" and not (r["escalated_strict"] and r["surfaced"]):
            print("  MISS", r["id"], "extracted" if r["extracted"] else "NOT EXTRACTED", r["variant"] and r["variant"]["classification"], "| control:", r["control"] and r["control"]["classification"])
        if r["kind"] == "looser" and r["false_over_restriction_flag"]:
            print("  FALSE FLAG", r["id"])
    print(f"done in {summary['seconds']}s -> {out_path}")


if __name__ == "__main__":
    main()
