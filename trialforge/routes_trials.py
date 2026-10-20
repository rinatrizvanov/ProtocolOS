"""Trial search over the semantic index (trialforge/trial_index.py).

GET /api/trials/search?q=&k=        trials nearest to a plain-language description
GET /api/trials/similar/{nct}?k=    trials nearest to one trial

Each result says whether this server already holds a review of the trial (`analysed`), which opens without a key.
Searching is local (no model API, no key) and cheap; on the public deploy it is limited per client per hour.
Installed by `routes_graph.install(app)` through its optional-module loop; `install` is idempotent.
"""
from __future__ import annotations

from fastapi import HTTPException, Query, Request

from . import access, trial_index
from .settings import flag

SEARCHES = access.Window(access.HOUR)
FIELDS = ("nct_id", "title", "acronym", "conditions", "interventions", "phases", "start_date", "status", "sponsor", "score")


def _results(rows: list[dict]) -> list[dict]:
    from .api import review_file

    return [{**{k: r.get(k) for k in FIELDS}, "analysed": review_file(f"{r['nct_id']}_auto") is not None} for r in rows]


def _check(request: Request) -> None:
    client = access.client_of(request.headers, request.client)
    if flag("PUBLIC") and not SEARCHES.allow(client, 120):
        raise access.AccessDenied(429, "rate_limited", "Too many searches from this address; try again in an hour.")
    if not trial_index.available():
        raise HTTPException(503, "trial search is not available on this server")


def search_route(request: Request, q: str = Query(min_length=3, max_length=200), k: int = Query(10, ge=1, le=25)):
    _check(request)
    return {"query": q, "results": _results(trial_index.search(q.strip(), k))}


def similar_route(request: Request, nct: str, k: int = Query(10, ge=1, le=25)):
    from . import demo_guard
    from .api import review_file
    from .sources import fetch_study

    nct = nct.strip().upper()
    if not demo_guard.valid_nct(nct):
        raise HTTPException(400, "Expected an NCT identifier like NCT03409614")
    _check(request)
    # A trial outside the index is embedded from its registry text, which the review of it has already fetched.
    text = ""
    if not trial_index.contains(nct):
        if review_file(f"{nct}_auto") is None:
            raise HTTPException(404, f"{nct} is not in the index and has not been analysed on this server")
        text = trial_index.record(fetch_study(nct))["text"]
    return {"nct_id": nct, "results": _results(trial_index.similar(nct, text, k))}


def install(app) -> None:
    if getattr(app.state, "protocolos_trial_routes", False):
        return
    app.state.protocolos_trial_routes = True
    app.add_api_route("/api/trials/search", search_route, methods=["GET"])
    app.add_api_route("/api/trials/similar/{nct}", similar_route, methods=["GET"])
