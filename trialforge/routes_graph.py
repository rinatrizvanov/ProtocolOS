"""HTTP routes for the provenance graph and the investigator.

`api.py` calls `install(app)` at its end, so this module must not import `trialforge.api` at module
top; handlers import `get_review` lazily.
"""
from __future__ import annotations

import importlib.util
import os

from fastapi import HTTPException
from pydantic import BaseModel


class InvestigateReq(BaseModel):
    nct: str
    criterion_id: str
    question: str
    as_of: str = "auto"
    mode: str = "deterministic"


def graph_route(nct: str, as_of: str = "auto", criterion_id: str | None = None):
    from .api import get_review
    from .graph import build_graph
    from .packet import load_decisions

    r = get_review(nct, as_of)
    if criterion_id is not None and criterion_id not in {rv["criterion"]["id"] for rv in r["reviews"]}:
        raise HTTPException(404, "criterion not found")
    return build_graph(r, load_decisions(r["target"]["study"]["nct_id"]), criterion_id)


def investigate_route(req: InvestigateReq):
    if importlib.util.find_spec("trialforge.investigate") is None:
        raise HTTPException(501, "investigator not installed")
    from .investigate import investigate

    return investigate(req.nct, req.criterion_id, req.question, as_of=req.as_of, mode=req.mode)


def install(app) -> None:
    """Add GET /api/graph/{nct} and POST /api/investigate (idempotent); guard the app when public."""
    if getattr(app.state, "triallens_graph_routes", False):
        return
    app.state.triallens_graph_routes = True
    app.add_api_route("/api/graph/{nct}", graph_route, methods=["GET"])
    app.add_api_route("/api/investigate", investigate_route, methods=["POST"])
    if os.environ.get("TRIALLENS_PUBLIC") == "1":
        from . import demo_guard

        demo_guard.install(app)
