"""Public-demo guard: input validation and cost limits for a deployed ProtocolOS.

Active only when `install(app)` is called; `routes_graph.install(app)` calls it when PROTOCOLOS_PUBLIC=1 (legacy TRIALLENS_PUBLIC=1).
One pure ASGI middleware, so request bodies can be checked and rewritten before FastAPI parses them:

- 400: an NCT in the path or in the JSON body (`nct`) that is not NCT + 8 digits; `as_of` not `auto`, `none`
  or YYYY-MM-DD (`api.get_review` puts `as_of` into a cache file name); a decision whose `criterion_id` is not
  a criterion of the review (`packet.save_decision` writes `DECISIONS/<nct>.json`); a body over 16 KB; a
  decision `reason` over 1000 characters.
- 403: `refresh` set to a truthy value (recomputes a review on demand).
- The visitor's own OpenAI or Anthropic key (access.py) for work that costs the server or a model: a review that
  is not cached (any review, packet, graph or rationale GET, or a POST naming the trial) needs
  access.allow_new_work; `/api/parse`, `/api/critique` and `/api/investigate` with `mode="model"` need
  access.allow_model_call. A missing key answers 401 `key_required`; `/api/verify` without a key gets
  `with_llm_baseline=false`. The server never uses a key of its own here (llm.from_env is off when public).
- 400 `session_required`: a decision without a visitor session (decisions are stored per session).
- Reviews that are not cached yet are computed one at a time (`sources._cached_pdf` writes are not atomic).

Errors carry `{"detail": message, "code": code}` when the code matters to the web app.
"""
from __future__ import annotations

import asyncio
import json
import os
import re

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse

from trialforge import access
from trialforge.settings import flag

MAX_BODY = 16 * 1024
MAX_REASON = 1000
NCT_RE = re.compile(r"NCT[0-9]{8}", re.IGNORECASE)
AS_OF_RE = re.compile(r"auto|none|[0-9]{4}-[0-9]{2}-[0-9]{2}")
PATH_NCT = re.compile(r"^/api/(?:review|packet|graph|rationale|protocol|trials/similar)/([^/]*)")
REVIEW_GET = re.compile(r"^/api/(?:review|packet|graph|rationale)/([^/]*)$")
MODEL_ONLY = {"/api/parse", "/api/critique"}
REVIEW_POST = {"/api/whatif", "/api/verify", "/api/parse", "/api/critique", "/api/investigate"}
# A protocol upload is a PDF body of up to upload.MAX_BYTES; its route checks size, session and key itself.
UPLOAD_POST = re.compile(r"^/api/draft/d-[0-9a-f]{12}/protocol$")
FALSY = {"", "0", "false", "no", "off"}


def valid_nct(v) -> bool:
    return isinstance(v, str) and NCT_RE.fullmatch(v) is not None


def valid_as_of(v) -> bool:
    return isinstance(v, str) and AS_OF_RE.fullmatch(v) is not None


def _api():
    from . import api

    return api


def is_cold(nct: str, as_of: str) -> bool:
    """True when `api.get_review(nct, as_of)` would compute instead of reading a cache."""
    api = _api()
    key = f"{nct.strip().upper()}_{as_of}"
    return key not in api._mem and api.review_file(key) is None


def _reject(status: int, detail: str, code: str | None = None) -> JSONResponse:
    return JSONResponse({"detail": detail, **({"code": code} if code else {})}, status_code=status)


def _denied(e: access.AccessDenied) -> JSONResponse:
    return JSONResponse(e.body(), status_code=e.status)


class DemoGuard:
    def __init__(self, app):
        self.app = app
        self.cold = asyncio.Semaphore(1)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope["method"]
        req = Request(scope)
        q = req.query_params

        if "refresh" in q and q["refresh"].strip().lower() not in FALSY:
            return await _reject(403, "refresh is disabled on the public demo")(scope, receive, send)
        m = PATH_NCT.match(path)
        if m and not valid_nct(m.group(1)):
            return await _reject(400, "Expected an NCT identifier like NCT03409614")(scope, receive, send)
        if "as_of" in q and not valid_as_of(q["as_of"]):
            return await _reject(400, "as_of must be auto, none or YYYY-MM-DD")(scope, receive, send)
        client = access.client_of(req.headers, scope.get("client"))
        model_call = path in MODEL_ONLY

        review_key = None  # (nct, as_of) of the review this request will load
        m = REVIEW_GET.match(path)
        if m and method == "GET":
            review_key = (m.group(1), q.get("as_of", "auto"))

        if method == "POST" and UPLOAD_POST.match(path):
            return await self.app(scope, receive, send)
        if method in ("POST", "PUT", "PATCH"):
            try:
                length = int(req.headers.get("content-length") or 0)
            except ValueError:
                return await _reject(400, "invalid Content-Length")(scope, receive, send)
            if length > MAX_BODY:
                return await _reject(400, "request body too large")(scope, receive, send)
            body = await _read_body(receive)
            if body is None:
                return await _reject(400, "request body too large")(scope, receive, send)
            data = None
            try:
                data = json.loads(body) if body else None
            except ValueError:
                pass  # FastAPI answers 422 for a malformed body
            if isinstance(data, dict):
                err = self._check_body(path, data)
                if err:
                    return await _reject(400, err)(scope, receive, send)
                changed = False
                if path == "/api/verify" and data.get("with_llm_baseline"):
                    if req.headers.get("x-model-key"):
                        model_call = True
                    else:
                        data["with_llm_baseline"], changed = False, True
                if path == "/api/investigate" and data.get("mode", "deterministic") != "deterministic":
                    model_call = True
                if path == "/api/decision":
                    if access.session_of(req.headers) is None:
                        return await _reject(400, "Decisions on the public demo are saved per browser; reload the page and try again.",
                                             "session_required")(scope, receive, send)
                    err = await self._check_decision(data)
                    if err:
                        return await _reject(err[0], err[1])(scope, receive, send)
                if path in REVIEW_POST and isinstance(data.get("nct"), str):
                    review_key = (data["nct"], data.get("as_of", "auto"))
                if changed:
                    body = json.dumps(data).encode()
                    scope = dict(scope, headers=[(k, v) for k, v in scope["headers"] if k.lower() != b"content-length"]
                                 + [(b"content-length", str(len(body)).encode())])
            receive = _replay(body, receive)

        try:
            if model_call:
                await run_in_threadpool(access.allow_model_call, req.headers, client)
            cold = bool(review_key) and is_cold(*review_key)
            if cold:
                await run_in_threadpool(access.allow_new_work, req.headers, client, "new_trial")
        except access.AccessDenied as e:
            return await _denied(e)(scope, receive, send)
        if cold:
            async with self.cold:
                return await self.app(scope, receive, send)
        return await self.app(scope, receive, send)

    @staticmethod
    def _check_body(path: str, data: dict) -> str | None:
        if "nct" in data and not valid_nct(data["nct"]):
            return "Expected an NCT identifier like NCT03409614"
        # POST /api/draft takes an idea whose as_of is null, YYYY-MM or YYYY-MM-DD; routes_draft.Idea validates it.
        if path != "/api/draft" and "as_of" in data and not valid_as_of(data["as_of"]):
            return "as_of must be auto, none or YYYY-MM-DD"
        if path == "/api/decision" and len(str(data.get("reason") or "")) > MAX_REASON:
            return f"reason is limited to {MAX_REASON} characters"
        return None

    async def _check_decision(self, data: dict):
        nct, cid = data.get("nct"), data.get("criterion_id")
        if not isinstance(nct, str) or not isinstance(cid, str):
            return None  # FastAPI answers 422 for missing fields
        api = _api()
        if valid_nct(nct) and is_cold(nct.upper(), "auto"):
            return (403, f"{nct.upper()} has not been analysed on this server; open its review first")
        try:
            review = await run_in_threadpool(api.get_review, nct, "auto")
        except Exception as e:  # noqa: BLE001
            return (getattr(e, "status_code", 400), f"criterion_id could not be checked against a review of {nct}")
        if cid not in {c["id"] for c in review["target"]["criteria"]}:
            return (400, f"criterion_id '{cid}' is not a criterion of {nct.upper()}")
        return None


async def _read_body(receive) -> bytes | None:
    chunks, size, more = [], 0, True
    while more:
        msg = await receive()
        if msg["type"] != "http.request":
            break
        chunk = msg.get("body", b"")
        size += len(chunk)
        if size > MAX_BODY:
            return None
        chunks.append(chunk)
        more = msg.get("more_body", False)
    return b"".join(chunks)


def _replay(body: bytes, receive):
    sent = False

    async def replay():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay


def install(app) -> None:
    """Add the guard to `app` once. Call before the app serves its first request."""
    if getattr(app.state, "demo_guard_installed", False):
        return
    app.add_middleware(DemoGuard)
    app.state.demo_guard_installed = True


if __name__ == "__main__":
    # Container entry point: the guard is on with PROTOCOLOS_PUBLIC=1 even before the routes_graph hook exists.
    import uvicorn

    from trialforge import api as _app_module

    if flag("PUBLIC"):
        install(_app_module.app)
    print(f"ProtocolOS: demo guard {'on' if getattr(_app_module.app.state, 'demo_guard_installed', False) else 'OFF'}", flush=True)
    uvicorn.run(_app_module.app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8765")), workers=1)
