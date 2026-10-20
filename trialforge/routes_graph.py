"""HTTP routes for the provenance graph and the investigator.

`api.py` calls `install(app)` at its end, so this module must not import `trialforge.api` at module
top; handlers import `get_review` lazily.
"""
from __future__ import annotations

import importlib.util

from fastapi import HTTPException, Request
from pydantic import BaseModel

from .settings import flag


class InvestigateReq(BaseModel):
    nct: str
    criterion_id: str
    question: str
    as_of: str = "auto"
    mode: str = "deterministic"


def graph_route(request: Request, nct: str, as_of: str = "auto", criterion_id: str | None = None):
    from .api import decisions_for, get_review
    from .graph import build_graph

    r = get_review(nct, as_of)
    if criterion_id is not None and criterion_id not in {rv["criterion"]["id"] for rv in r["reviews"]}:
        raise HTTPException(404, "criterion not found")
    return build_graph(r, decisions_for(r["target"]["study"]["nct_id"], request), criterion_id)


def investigate_route(req: InvestigateReq, request: Request):
    if importlib.util.find_spec("trialforge.investigate") is None:
        raise HTTPException(501, "investigator not installed")
    from . import llm
    from .api import decisions_for
    from .investigate import investigate

    creds = llm.resolve(request.headers) if req.mode == "model" else None
    return investigate(req.nct, req.criterion_id, req.question, as_of=req.as_of, mode=req.mode, creds=creds,
                       decisions=lambda nct: decisions_for(nct, request))


def install(app) -> None:
    """Add GET /api/graph/{nct} and POST /api/investigate (idempotent); guard the app when public."""
    if getattr(app.state, "protocolos_graph_routes", False):
        return
    app.state.protocolos_graph_routes = True
    app.add_api_route("/api/graph/{nct}", graph_route, methods=["GET"])
    app.add_api_route("/api/investigate", investigate_route, methods=["POST"])
    # Optional route modules: each install(app) is idempotent; a module that is absent is skipped.
    for name in ("routes_rationale", "routes_draft", "routes_redraft", "routes_trials", "web_next"):
        if importlib.util.find_spec(f"trialforge.{name}") is not None:
            importlib.import_module(f"trialforge.{name}").install(app)
    if flag("PUBLIC"):
        from . import demo_guard

        demo_guard.install(app)
