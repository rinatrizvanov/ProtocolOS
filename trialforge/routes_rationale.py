"""GET /api/rationale/{nct}: the rationale report for a cached review.

Installed by `routes_graph.install(app)` through its optional-module loop; `install` is idempotent. On the public
demo (PROTOCOLOS_PUBLIC=1) the guard asks for the visitor's key before a review that is not cached is computed
(demo_guard.py). Handlers import `trialforge.api` lazily, because `api.py` calls the install hook at its end.
"""
from __future__ import annotations

from fastapi import HTTPException


def rationale_route(nct: str, as_of: str = "auto"):
    from . import demo_guard
    from .api import get_review
    from .rationale import rationale_report

    if not demo_guard.valid_as_of(as_of):
        raise HTTPException(400, "as_of must be auto, none or YYYY-MM-DD")
    # ASCII digits only, in every mode: get_review's \d also matches non-ASCII digits.
    if not demo_guard.valid_nct(nct.strip()):
        raise HTTPException(400, "Expected an NCT identifier like NCT03409614")
    return rationale_report(get_review(nct, as_of))


def install(app) -> None:
    """Add GET /api/rationale/{nct} once per app."""
    if getattr(app.state, "protocolos_rationale_routes", False):
        return
    app.state.protocolos_rationale_routes = True
    app.add_api_route("/api/rationale/{nct}", rationale_route, methods=["GET"])
