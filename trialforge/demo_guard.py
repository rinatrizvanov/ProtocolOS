"""Public-demo guard: input validation and cost limits for a deployed ProtocolOS.

Active only when `install(app)` is called; `routes_graph.install(app)` calls it when PROTOCOLOS_PUBLIC=1 (legacy TRIALLENS_PUBLIC=1).
One pure ASGI middleware, so request bodies can be checked and rewritten before FastAPI parses them:

- 400: an NCT in the path or in the JSON body (`nct`) that is not NCT + 8 digits; `as_of` not `auto`, `none`
  or YYYY-MM-DD (`api.get_review` puts `as_of` into a cache file name); a decision whose `criterion_id` is not
  a criterion of the review (`packet.save_decision` writes `DECISIONS/<nct>.json`); a body over 16 KB; a
  decision `reason` over 1000 characters.
- 403: `refresh` set to a truthy value (recomputes a review on demand).
- 503 "disabled on the public demo": `/api/parse` and `/api/critique` (paid model calls), and the request
  body of `/api/verify` gets `with_llm_baseline=false`, `/api/investigate` gets `mode="deterministic"`,
  unless PROTOCOLOS_ALLOW_MODEL=1 (set it only with a budgeted router key).
- Reviews that are not cached yet are computed one at a time (`sources._cached_pdf` writes are not atomic).
"""
from __future__ import annotations

import asyncio
import json
import os
import re

from starlette.concurrency import run_in_threadpool

from trialforge.settings import flag
from starlette.requests import Request
from starlette.responses import JSONResponse

MAX_BODY = 16 * 1024
MAX_REASON = 1000
NCT_RE = re.compile(r"NCT[0-9]{8}", re.IGNORECASE)
AS_OF_RE = re.compile(r"auto|none|[0-9]{4}-[0-9]{2}-[0-9]{2}")
PATH_NCT = re.compile(r"^/api/(?:review|packet|graph|chalk/registry|protocol)/([^/]*)")
REVIEW_GET = re.compile(r"^/api/(?:review|packet|graph)/([^/]*)$")
MODEL_ONLY = {"/api/parse", "/api/critique"}
REVIEW_POST = {"/api/whatif", "/api/verify", "/api/parse", "/api/critique", "/api/investigate"}
FALSY = {"", "0", "false", "no", "off"}


def allow_model() -> bool:
    return flag("ALLOW_MODEL")


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
    return key not in api._mem and not (api.REVIEW_CACHE / f"{key}.json").exists()


def _reject(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


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
        if path in MODEL_ONLY and not allow_model():
            return await _reject(503, "disabled on the public demo")(scope, receive, send)

        review_key = None  # (nct, as_of) of the review this request will load
        m = REVIEW_GET.match(path)
        if m and method == "GET":
            review_key = (m.group(1), q.get("as_of", "auto"))

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
                if not allow_model():
                    if path == "/api/verify" and data.get("with_llm_baseline"):
                        data["with_llm_baseline"], changed = False, True
                    if path == "/api/investigate" and data.get("mode", "deterministic") != "deterministic":
                        data["mode"], changed = "deterministic", True
                if path == "/api/decision":
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

        if review_key and is_cold(*review_key):
            async with self.cold:
                return await self.app(scope, receive, send)
        return await self.app(scope, receive, send)

    @staticmethod
    def _check_body(path: str, data: dict) -> str | None:
        if "nct" in data and not valid_nct(data["nct"]):
            return "Expected an NCT identifier like NCT03409614"
        if "as_of" in data and not valid_as_of(data["as_of"]):
            return "as_of must be auto, none or YYYY-MM-DD"
        if path == "/api/decision" and len(str(data.get("reason") or "")) > MAX_REASON:
            return f"reason is limited to {MAX_REASON} characters"
        return None

    async def _check_decision(self, data: dict):
        nct, cid = data.get("nct"), data.get("criterion_id")
        if not isinstance(nct, str) or not isinstance(cid, str):
            return None  # FastAPI answers 422 for missing fields
        api = _api()
        try:
            if is_cold(nct, "auto"):
                async with self.cold:
                    review = await run_in_threadpool(api.get_review, nct, "auto")
            else:
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
