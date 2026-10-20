"""ProtocolOS HTTP API + static dashboard (Python package: trialforge).

Run:  .venv/bin/uvicorn trialforge.api:app --port 8000
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import access, llm, nhanes
from .comparators import direction
from .guidance import load_passages
from .review import run_review
from .settings import flag
from .sources import DATA, STATE, fetch_protocol, protocol_cached
from .verifier import default_resolvers, verify

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
REVIEW_CACHE = DATA / "reviews"  # the image's reviews (preloaded trials); every review when there is no state dir
REVIEW_STATE = STATE / "reviews" if STATE != DATA else None
EVAL_RESULTS = DATA / "eval_results.json"

app = FastAPI(
    title="ProtocolOS",
    description="Eligibility-criteria rationale review for oncology protocols: comparable trials, FDA guidance and a deterministic verifier.",
)
_resolvers = None
_mem: dict[str, dict] = {}


@app.exception_handler(access.AccessDenied)
def _access_denied(request: Request, exc: access.AccessDenied):
    return JSONResponse(exc.body(), status_code=exc.status)


def session_of(request: Request) -> str | None:
    return access.session_of(request.headers, request.query_params)


def decisions_for(nct: str, request: Request) -> dict:
    """The decisions this request may see: its visitor session's, or (local runs only) the shared file."""
    from .packet import load_decisions

    session = session_of(request)
    if session is None and flag("PUBLIC"):
        return {}
    return load_decisions(nct, session)


_review_refs: tuple[tuple, set] = ((), set())


def review_ncts() -> set[str]:
    """NCT ids of the targets and comparators of the reviews cached on this server (re-read when the files change)."""
    global _review_refs
    files = tuple(sorted((str(p), p.stat().st_mtime) for d in (REVIEW_CACHE, REVIEW_STATE) if d and d.exists() for p in d.glob("*.json")))
    if files != _review_refs[0]:
        ncts = set()
        for name, _ in files:
            r = json.loads(Path(name).read_text())
            ncts.add(r["target"]["study"]["nct_id"])
            ncts.update(c["study"]["nct_id"] for c in r.get("comparators", []))
        _review_refs = (files, ncts)
    return _review_refs[1]


def _model_creds(request: Request) -> llm.Credentials:
    creds = llm.resolve(request.headers)
    if creds is None:
        raise access.AccessDenied(401, "key_required", access.KEY_NEEDED["model"])
    return creds


def resolvers():
    global _resolvers
    if _resolvers is None:
        _resolvers = default_resolvers()
    return _resolvers


def review_file(key: str) -> Path | None:
    """The cached review file for `<NCT>_<as_of>`, in the image's cache or the state dir, or None."""
    return next((d / f"{key}.json" for d in (REVIEW_CACHE, REVIEW_STATE) if d and (d / f"{key}.json").exists()), None)


def get_review(nct: str, as_of: str = "auto", refresh: bool = False) -> dict:
    nct = nct.strip().upper()
    if not re.fullmatch(r"NCT\d{8}", nct):
        raise HTTPException(400, "Expected an NCT identifier like NCT03409614")
    # as_of goes into a cache file name and the ClinicalTrials.gov query, so it is checked here too,
    # not only by the public-demo guard.
    if not isinstance(as_of, str) or not re.fullmatch(r"auto|none|\d{4}-\d{2}-\d{2}", as_of):
        raise HTTPException(400, "as_of must be auto, none or YYYY-MM-DD")
    key = f"{nct}_{as_of}"
    if not refresh and key in _mem:
        return _mem[key]
    p = review_file(key)
    if p is not None and not refresh:
        r = json.loads(p.read_text())
    else:
        p = (REVIEW_STATE or REVIEW_CACHE) / f"{key}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        r = run_review(nct, as_of=None if as_of == "none" else as_of)
        r["compute_seconds"] = round(time.time() - t0, 2)
        r["computed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        p.write_text(json.dumps(r, default=list))
    _mem[key] = r
    return r


@app.get("/api/status")
def status(request: Request):
    passages, failed = load_passages()
    local = llm.from_env()
    return {
        # The address the per-visitor limits use for this caller (access.client_of): shows whether a proxy passed it on.
        "client": access.client_of(request.headers, request.client),
        "llm": {
            "mode": "your own key",
            "providers": {k: {"name": v["name"], "models": list(v["models"])} for k, v in llm.PROVIDERS.items()},
            "local_key": local.label() if local else None,
        },
        "public": flag("PUBLIC"),
        "fda_passages": {"verified": len(passages), "failed": failed},
        "evals": EVAL_RESULTS.exists(),
    }


@app.post("/api/model/check")
def model_check(request: Request):
    """Check the visitor's key (headers X-Model-Provider, X-Model-Key, X-Model-Name) with a free models lookup."""
    client = access.client_of(request.headers, request.client)
    creds = access.check_key(request.headers, client) if flag("PUBLIC") else access.credentials(request.headers)
    if creds is None:
        raise access.AccessDenied(401, "key_required", access.KEY_NEEDED["model"])
    if not flag("PUBLIC"):
        result = llm.check(creds)
        if not result.ok:
            raise access.AccessDenied(502 if result.code == "provider_unreachable" else 401, result.code, result.message)
    return {"ok": True, "provider": creds.provider, "model": creds.model, "label": creds.label()}


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
def verify_api(req: VerifyReq, request: Request):
    r = get_review(req.nct, req.as_of)
    out = {"deterministic": verify(req.recommendation, r, resolvers())}
    creds = llm.resolve(request.headers) if req.with_llm_baseline else None
    if creds is not None:
        try:
            out["llm_only"] = llm.llm_only_verify(req.recommendation, r, creds)
        except llm.ModelError as e:
            out["llm_only"] = {"error": str(e)}
    return out


class ParseReq(BaseModel):
    nct: str
    text: str
    as_of: str = "auto"


@app.post("/api/parse")
def parse_api(req: ParseReq, request: Request):
    creds = _model_creds(request)
    r = get_review(req.nct, req.as_of)
    try:
        rec = llm.parse_recommendation(req.text, r, creds)
    except llm.ModelError as e:
        raise HTTPException(502, f"model call failed: {e}")
    return {"recommendation": rec, "verification": verify(rec, r, resolvers())}


class CritiqueReq(BaseModel):
    nct: str
    criterion_id: str
    as_of: str = "auto"


@app.post("/api/critique")
def critique_api(req: CritiqueReq, request: Request):
    creds = _model_creds(request)
    r = get_review(req.nct, req.as_of)
    item = next((x for x in r["reviews"] if x["criterion"]["id"] == req.criterion_id), None)
    if not item:
        raise HTTPException(404, "criterion not found")
    try:
        return llm.critique(item, r["target"]["regimen"]["drugs"], creds)
    except llm.ModelError as e:
        raise HTTPException(502, f"model call failed: {e}")


@app.get("/api/protocol/{nct}/page/{page}")
def protocol_page(nct: str, page: int):
    # On the public deployment a protocol is downloaded only for a trial that is a target or comparator of a cached review.
    if flag("PUBLIC") and not protocol_cached(nct) and nct.strip().upper() not in review_ncts():
        raise HTTPException(403, "this protocol is not part of a review on this server; analyse its trial first")
    doc = fetch_protocol(nct.upper())
    if not doc or not (1 <= page <= len(doc.pages)):
        raise HTTPException(404, "page not available")
    return {"nct": nct, "page": page, "text": doc.pages[page - 1], "url": f"{doc.url}#page={page}"}


@app.get("/api/packet/{nct}")
def packet(nct: str, request: Request, format: str = "json", as_of: str = "auto"):
    from fastapi.responses import HTMLResponse, PlainTextResponse

    from .packet import build_packet, to_html, to_markdown

    r = get_review(nct, as_of)
    p = build_packet(r, decisions_for(r["target"]["study"]["nct_id"], request))
    if format == "md":
        return PlainTextResponse(to_markdown(p), headers={"Content-Disposition": f'attachment; filename="ProtocolOS_{nct}_review_packet.md"'})
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
def decision(req: DecisionReq, request: Request):
    from .packet import save_decision

    session = session_of(request)
    if session is None and flag("PUBLIC"):
        raise access.AccessDenied(400, "session_required", "Decisions on the public demo are saved per browser; reload the page and try again.")
    try:
        return save_decision(req.nct.upper(), req.criterion_id, req.decision, req.reason, req.reviewer, session)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except OverflowError as e:
        raise HTTPException(507, str(e))


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


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(WEB / "favicon.ico", media_type="image/x-icon")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


from .routes_graph import install as _install_graph  # noqa: E402

_install_graph(app)
