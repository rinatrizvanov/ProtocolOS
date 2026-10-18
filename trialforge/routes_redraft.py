"""POST /api/redraft: live checks for a reviewer's rewritten criterion (installed by routes_graph.install)."""
from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .settings import flag

COLD_DETAIL = "review not cached on the public demo"


class RedraftReq(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nct: str = Field(min_length=11, max_length=11)
    criterion_id: str = Field(min_length=1, max_length=60)
    text: str = Field(min_length=1, max_length=2000)
    rationale: str = Field(default="", max_length=1000)
    as_of: str = "auto"


def redraft_route(req: RedraftReq):
    from . import demo_guard
    from .api import get_review, resolvers
    from .redraft import analyze

    nct = req.nct.strip().upper()
    if not demo_guard.valid_nct(nct):
        raise HTTPException(400, "Expected an NCT identifier like NCT03409614")
    if flag("PUBLIC") and demo_guard.is_cold(nct, req.as_of):
        raise HTTPException(403, COLD_DETAIL)
    review = get_review(nct, req.as_of)
    try:
        return analyze(review, req.criterion_id, req.text, req.rationale, resolvers())
    except KeyError:
        raise HTTPException(404, "criterion not found") from None


def install(app) -> None:
    if getattr(app.state, "protocolos_redraft_routes", False):
        return
    app.state.protocolos_redraft_routes = True
    app.add_api_route("/api/redraft", redraft_route, methods=["POST"])
