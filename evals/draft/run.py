"""Leave-one-out draft eval (plan-v2 WS-C acceptance 4, gate G4).

For each cached trial review (data/reviews/*_auto.json): build an idea from the trial's own condition,
recognized regimen drugs and setting tags, with as_of = the trial's start date and the trial itself excluded,
then draft criteria and compare each drafted value with the trial's own extracted value.

Prints `drafted_without_verified_precedent=<n> overclaim_failures=<n> agreement=<k>/<m>` and writes
evals/draft/results.json. Exits 1 if either of the first two counts is non-zero. Agreement is reported, not
gated: a difference from the trial's own value is a review question, not an error.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from trialforge import comparators, draft, verifier
from trialforge.sources import fetch_study

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "results.json"


def _idea(target: dict) -> dict:
    study = target["study"]
    drugs = list(((target.get("regimen") or {}).get("drugs") or {}).keys())[:8]
    tags = comparators.setting_tags(fetch_study(study["nct_id"]))  # registry JSON, cached under data/registry
    return {"condition": (study.get("conditions") or ["cancer"])[0][:120], "drugs": drugs,
            "setting": [t for t in draft.SETTING_TAGS if t in tags], "phase": "PHASE3",
            "as_of": study.get("start_date")}


def _unverified(c: dict) -> bool:
    v = c.get("verification") or {}
    cv = any(k["check"] == "comparator_value" and k["result"] == "pass" for k in v.get("checks") or [])
    return (c.get("proposed") is None or not c["proposed"].get("source_nct_id")
            or v.get("status") == "REJECTED" or not cv)


def main() -> int:
    rows, unverified, overclaims, k, m = [], 0, 0, 0, 0
    for f in sorted((ROOT / "data" / "reviews").glob("*_auto.json")):
        review = json.loads(f.read_text())
        target = review["target"]
        nct = target["study"]["nct_id"]
        idea = _idea(target)
        t0 = time.time()
        d = draft.draft_criteria(idea, exclude=(nct,))
        own = {c["id"]: c for c in target.get("criteria") or []}
        crit_rows = []
        for c in d.get("criteria") or []:
            if c["status"] != "drafted":
                crit_rows.append({"id": c["id"], "status": c["status"]})
                continue
            if _unverified(c):
                unverified += 1
            p = c["proposed"]
            o = own.get(c["id"])
            row = {"id": c["id"], "status": "drafted", "drafted": f"{p['operator']}{p['value']} {p['unit']}",
                   "source_nct_id": p["source_nct_id"], "trial_value": None, "agrees": None}
            if o is not None and o.get("value_norm") is not None:
                m += 1
                agrees = (o.get("operator") == p["operator"] and o.get("value_norm") == p["value"]
                          and o.get("unit_norm") == p["unit"])
                k += int(agrees)
                row.update(trial_value=f"{o.get('operator')}{o.get('value_norm')} {o.get('unit_norm')}", agrees=agrees)
            crit_rows.append(row)
        hits = [s for s in draft._strings(d) if verifier.OVERCLAIM.search(s)]
        overclaims += len(hits)
        rows.append({"nct_id": nct, "idea": idea, "draft_id": d.get("draft_id"), "status": d.get("status"),
                     "summary": d.get("summary"), "precedents": [p.get("nct_id") for p in d.get("precedents") or []],
                     "criteria": crit_rows, "overclaim_hits": hits, "wall_s": round(time.time() - t0, 2)})
        print(f"{nct}: status={d.get('status')} drafted={d.get('summary', {}).get('drafted')} "
              f"insufficient={d.get('summary', {}).get('insufficient')}", flush=True)
    summary = {"drafted_without_verified_precedent": unverified, "overclaim_failures": overclaims,
               "agreement": f"{k}/{m}", "agreement_k": k, "agreement_m": m, "trials": len(rows)}
    OUT.write_text(json.dumps({"summary": summary, "trials": rows,
                               "computed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2, default=str))
    print(f"drafted_without_verified_precedent={unverified} overclaim_failures={overclaims} agreement={k}/{m}")
    return 1 if unverified or overclaims else 0


if __name__ == "__main__":
    sys.exit(main())
