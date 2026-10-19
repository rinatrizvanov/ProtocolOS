"""Authoring-mode HTTP routes: vocabulary, presets, POST /api/draft, GET /api/draft/{id}.

Installed by the routes_graph module loop; install(app) is idempotent (app.state flag).
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Literal

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import access, draft, druglib, settings

CAP_DETAIL = "new ideas limit reached on the public demo; presets still work"
_AS_OF_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")


class Idea(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    condition: str = Field(min_length=3, max_length=120)
    drugs: list[str] = Field(min_length=1, max_length=8)
    setting: list[Literal["first-line", "metastatic", "non-squamous", "squamous",
                          "perioperative/locally-advanced"]] = Field(default_factory=list)
    phase: Literal["PHASE2", "PHASE3"] = "PHASE3"
    as_of: str | None = None

    @field_validator("drugs")
    @classmethod
    def _drug_len(cls, v: list[str]) -> list[str]:
        for d in v:
            if not 2 <= len(d.strip()) <= 40:
                raise ValueError("each drug must be 2-40 characters")
        return v

    @field_validator("as_of")
    @classmethod
    def _as_of(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        if not _AS_OF_RE.match(v):
            raise ValueError("as_of must be YYYY-MM or YYYY-MM-DD")
        try:
            d = _dt.date.fromisoformat(v if len(v) == 10 else v + "-01")
        except ValueError as e:
            raise ValueError(f"as_of is not a valid date: {e}") from e
        if d > _dt.date.today():
            raise ValueError("as_of must not be in the future")
        return v


def vocabulary() -> dict:
    return {
        "drugs": [{"name": d.name, "drug_class": d.drug_class, "aliases": list(d.aliases)} for d in druglib.DRUGS],
        "settings": list(draft.SETTING_TAGS),
        "phases": list(draft.PHASES),
    }


def presets() -> list[dict]:
    out = []
    for pid, p in draft.PRESETS.items():
        did = draft.draft_id_for(p["idea"], p.get("exclude") or ())
        hit = draft.cached(did)
        if hit is not None and hit.get("summary", {}).get("drafted", 0) < 2:
            continue  # a preset that drafts fewer than 2 criteria is not offered as an example
        out.append({"id": pid, "title": p["title"], "idea": p["idea"], "draft_id": did, "cached": hit is not None})
    return out


def post_draft(idea: dict, headers=None, client: str = "unknown") -> dict:
    pid = draft.preset_for(idea)
    exclude = tuple(draft.PRESETS[pid].get("exclude") or ()) if pid else ()
    # On the public deployment a new idea (not a preset, not cached) needs the visitor's own key.
    if settings.flag("PUBLIC") and not pid and draft.cached(draft.draft_id_for(idea, exclude)) is None:
        access.allow_new_work(headers, client, "new_draft")
    try:
        d = draft.get_or_draft(idea, exclude=exclude, preset=bool(pid))
    except draft.ColdCapReached:
        raise HTTPException(status_code=429, detail=CAP_DETAIL)
    if d.get("status") == "retrieval_failed":
        prefix = "ClinicalTrials.gov not reachable: "
        msgs = [w[len(prefix):] if w.startswith(prefix) else w for w in (d.get("warnings") or [])
                if w.startswith(prefix)]
        raise HTTPException(status_code=503, detail=prefix + ("; ".join(msgs) or "unknown error"))
    return d


def install(app) -> None:
    if getattr(app.state, "routes_draft_installed", False):
        return
    app.state.routes_draft_installed = True

    @app.get("/api/draft/vocabulary")
    def _vocabulary():
        return vocabulary()

    @app.get("/api/draft/presets")
    def _presets():
        return presets()

    @app.post("/api/draft")
    async def _post(idea: Idea, request: Request):
        return await run_in_threadpool(post_draft, idea.model_dump(), request.headers, access.client_of(request.headers, request.client))

    @app.get("/api/draft/{draft_id}")
    def _get(draft_id: str):
        if not draft.DRAFT_ID_RE.match(draft_id):
            raise HTTPException(status_code=400, detail="draft_id must match ^d-[0-9a-f]{12}$")
        d = draft.cached(draft_id)
        if d is None:
            raise HTTPException(status_code=404, detail="draft not cached")
        return d
