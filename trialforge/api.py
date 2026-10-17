"""TrialForge HTTP API + static dashboard.

Run:  .venv/bin/uvicorn trialforge.api:app --port 8000
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm, nhanes
from .comparators import direction
from .guidance import load_passages
from .review import run_review
from .sources import DATA, fetch_protocol
from .verifier import default_resolvers, verify

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
REVIEW_CACHE = DATA / "reviews"
EVAL_RESULTS = DATA / "eval_results.json"
CHALK_STATUS = DATA / "chalk_status.json"

app = FastAPI(title="TrialLens")
_resolvers = None
_mem: dict[str, dict] = {}


def resolvers():
    global _resolvers
    if _resolvers is None:
        _resolvers = default_resolvers()
    return _resolvers


def get_review(nct: str, as_of: str = "auto", refresh: bool = False) -> dict:
    nct = nct.strip().upper()
    if not re.fullmatch(r"NCT\d{8}", nct):
        raise HTTPException(400, "Expected an NCT identifier like NCT03409614")
    key = f"{nct}_{as_of}"
    if not refresh and key in _mem:
        return _mem[key]
    REVIEW_CACHE.mkdir(parents=True, exist_ok=True)
    p = REVIEW_CACHE / f"{key}.json"
    if p.exists() and not refresh:
        r = json.loads(p.read_text())
    else:
        t0 = time.time()
        r = run_review(nct, as_of=None if as_of == "none" else as_of)
        r["compute_seconds"] = round(time.time() - t0, 2)
        r["computed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        p.write_text(json.dumps(r, default=list))
    _mem[key] = r
    return r


@app.get("/api/status")
def status():
    passages, failed = load_passages()
    chalk = json.loads(CHALK_STATUS.read_text()) if CHALK_STATUS.exists() else {"status": "not configured", "detail": "Run `chalk login`, then scripts in chalk_project/."}
    return {
        "llm": {"available": llm.available(), "model": llm.model_label(), "provider": llm.provider()},
        "fda_passages": {"verified": len(passages), "failed": failed},
        "chalk": chalk,
        "evals": EVAL_RESULTS.exists(),
    }


@app.get("/api/review/{nct}")
def review(nct: str, as_of: str = "auto", refresh: int = 0):
    return get_review(nct, as_of, bool(refresh))


@app.get("/api/nhanes")
def nhanes_api(analyte: str, threshold: float, alternative: float | None = None, min_age: int = 18):
    if analyte not in nhanes.ANALYTES:
        raise HTTPException(400, f"NHANES data are wired for {sorted(nhanes.ANALYTES)} only")
    cur = nhanes.below_threshold(analyte, threshold, min_age)
    alt = nhanes.below_threshold(analyte, alternative, min_age) if alternative is not None else None
    return {"current": cur, "alternative": alt, "caveat": nhanes.CAVEAT}


class WhatIf(BaseModel):
    nct: str
    criterion_id: str
    value: float
    as_of: str = "auto"


@app.post("/api/whatif")
def whatif(req: WhatIf):
    r = get_review(req.nct, req.as_of)
    crit = next((c for c in r["target"]["criteria"] if c["id"] == req.criterion_id), None)
    if not crit:
        raise HTTPException(404, "criterion not found")
    rows = []
    for row in r["comparison"][req.criterion_id]:
        cc = row["criterion"]
        if not cc or row["direction"] == "different measure":
            continue
        d = direction(crit["analyte"], req.value, cc["value_norm"])
        rows.append({"nct_id": row["nct_id"], "acronym": row["acronym"], "threshold": cc["value_norm"], "coverage": row["coverage"]["status"],
                     "relation_to_alternative": {"same": "same as alternative", "comparator looser": "more permissive than alternative",
                                                 "comparator stricter": "stricter than alternative"}.get(d, d)})
    # an honest, automatically-built recommendation citing only comparators at or below the alternative
    cites = [{"type": "comparator_threshold", "nct_id": x["nct_id"], "value": x["threshold"], "unit": crit["unit_norm"]}
             for x in rows if x["relation_to_alternative"] in ("same as alternative",)]
    action = "relax" if direction(crit["analyte"], crit["value_norm"], req.value) == "comparator looser" else "tighten"
    rec = {"criterion_id": crit["id"], "action": action, "proposed_value": req.value, "proposed_unit": crit["unit_norm"], "claims": cites,
           "text": f"Consider {crit['operator']}{req.value} {crit['unit_norm']} instead of {crit['operator']}{crit['value_norm']}."}
    ver = verify(rec, r, resolvers())
    pop = None
    if crit["analyte"] in nhanes.ANALYTES and crit["operator"] in ("≥", ">"):
        pop = {"current": nhanes.below_threshold(crit["analyte"], crit["value_norm"]), "alternative": nhanes.below_threshold(crit["analyte"], req.value)}
    return {"criterion": crit, "alternative": req.value, "comparators": rows, "auto_recommendation": rec, "verification": ver, "population": pop}


class VerifyReq(BaseModel):
    nct: str
    recommendation: dict
    as_of: str = "auto"
    with_llm_baseline: bool = False


@app.post("/api/verify")
def verify_api(req: VerifyReq):
    r = get_review(req.nct, req.as_of)
    out = {"deterministic": verify(req.recommendation, r, resolvers())}
    if req.with_llm_baseline and llm.available():
        try:
            out["llm_only"] = llm.llm_only_verify(req.recommendation, r)
        except Exception as e:
            out["llm_only"] = {"error": str(e)}
    return out


class ParseReq(BaseModel):
    nct: str
    text: str
    as_of: str = "auto"


@app.post("/api/parse")
def parse_api(req: ParseReq):
    if not llm.available():
        raise HTTPException(503, "LLM not configured (set ANTHROPIC_API_KEY). Use the structured form instead.")
    r = get_review(req.nct, req.as_of)
    rec = llm.parse_recommendation(req.text, r)
    return {"recommendation": rec, "verification": verify(rec, r, resolvers())}


class CritiqueReq(BaseModel):
    nct: str
    criterion_id: str
    as_of: str = "auto"


@app.post("/api/critique")
def critique_api(req: CritiqueReq):
    if not llm.available():
        raise HTTPException(503, "LLM critic not configured (set ANTHROPIC_API_KEY).")
    r = get_review(req.nct, req.as_of)
    item = next((x for x in r["reviews"] if x["criterion"]["id"] == req.criterion_id), None)
    if not item:
        raise HTTPException(404, "criterion not found")
    return llm.critique(item, r["target"]["regimen"]["drugs"])


@app.get("/api/protocol/{nct}/page/{page}")
def protocol_page(nct: str, page: int):
    doc = fetch_protocol(nct.upper())
    if not doc or not (1 <= page <= len(doc.pages)):
        raise HTTPException(404, "page not available")
    return {"nct": nct, "page": page, "text": doc.pages[page - 1], "url": f"{doc.url}#page={page}"}


@app.get("/api/chalk/registry/{nct}")
def chalk_registry(nct: str):
    from .chalk_bridge import registry_profile

    return registry_profile(nct.strip().upper())


@app.get("/api/packet/{nct}")
def packet(nct: str, format: str = "json", as_of: str = "auto"):
    from fastapi.responses import HTMLResponse, PlainTextResponse

    from .packet import build_packet, load_decisions, to_html, to_markdown

    r = get_review(nct, as_of)
    p = build_packet(r, load_decisions(r["target"]["study"]["nct_id"]))
    if format == "md":
        return PlainTextResponse(to_markdown(p), headers={"Content-Disposition": f'attachment; filename="TrialLens_{nct}_review_packet.md"'})
    if format == "html":
        return HTMLResponse(to_html(p))
    return p


class DecisionReq(BaseModel):
    nct: str
    criterion_id: str
    decision: str
    reason: str = ""
    reviewer: str = ""


@app.post("/api/decision")
def decision(req: DecisionReq):
    from .packet import save_decision

    try:
        return save_decision(req.nct.upper(), req.criterion_id, req.decision, req.reason, req.reviewer)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/planted")
def planted():
    p = DATA / "planted_results.json"
    first = ROOT / "evals" / "planted" / "first_run_planted_results.json"
    if not p.exists():
        return {"available": False}
    out = json.loads(p.read_text())
    if first.exists():
        out["first_run_summary"] = json.loads(first.read_text())["summary"]
    nocut = DATA / "planted_results_no_cutoff.json"
    if nocut.exists():
        out["no_cutoff_summary"] = json.loads(nocut.read_text())["summary"]
    return out


@app.get("/api/evals")
def evals():
    if not EVAL_RESULTS.exists():
        return JSONResponse({"available": False})
    return json.loads(EVAL_RESULTS.read_text())


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")
