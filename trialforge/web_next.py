"""Build info and the optional static web-next mount (ProtocolOS deploy, plan-v2 sections 4 and 6.2).

Installed by the module hook loop in `routes_graph.install`. Two things:

- `GET /api/build` -> {"sha", "web_next", "built_at"}: the git SHA the container was built from
  (PROTOCOLOS_BUILD_SHA, legacy TRIALLENS_BUILD_SHA, else "unknown"), whether the static export exists,
  and PROTOCOLOS_BUILT_AT (else the time this process started, UTC).
- The fallback mount, active only when `web-next/out/index.html` exists: the static export at `/app`
  and a 307 from exactly `/` (empty query) to `/app/`. Any other path, and `/?nct=...`, pass through
  untouched, so the vanilla dashboard stays where it was. The primary frontend is the Vercel deploy;
  this is the single-container fallback.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from .settings import env

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web-next" / "out"
STARTED_AT = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class RootRedirect:
    """ASGI middleware: GET or HEAD of exactly `/` with an empty query string -> 307 to `/app/`."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] == "http" and scope["path"] == "/" and not scope.get("query_string")
                and scope["method"] in ("GET", "HEAD")):
            await send({"type": "http.response.start", "status": 307,
                        "headers": [(b"location", b"/app/"), (b"content-length", b"0")]})
            await send({"type": "http.response.body", "body": b""})
            return
        await self.app(scope, receive, send)


def install(app, out_dir: Path | None = None) -> None:
    """Add `/api/build` and, when the export exists, the `/app` mount and the root redirect. Idempotent."""
    if getattr(app.state, "protocolos_web_next", False):
        return
    app.state.protocolos_web_next = True
    out = Path(out_dir) if out_dir is not None else OUT
    has_export = (out / "index.html").is_file()

    @app.get("/api/build")
    def build_info():
        return {"sha": env("BUILD_SHA") or "unknown", "web_next": has_export,
                "built_at": env("BUILT_AT") or STARTED_AT}

    if has_export:
        app.mount("/app", StaticFiles(directory=out, html=True), name="web_next")
        app.add_middleware(RootRedirect)
