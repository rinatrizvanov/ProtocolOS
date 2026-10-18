"""GET /api/build and the fallback static mount (trialforge/web_next.py). No network."""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from trialforge import web_next

EL3 = "NCT03409614"


def _app(out_dir):
    app = FastAPI()

    @app.get("/")
    def index():
        return {"page": "vanilla"}

    web_next.install(app, out_dir=out_dir)
    return app


def test_build_info(monkeypatch, tmp_path):
    monkeypatch.setenv("PROTOCOLOS_BUILD_SHA", "abc1234")
    monkeypatch.setenv("PROTOCOLOS_BUILT_AT", "2026-10-18T04:00:00Z")
    with TestClient(_app(tmp_path / "missing")) as c:
        r = c.get("/api/build")
    assert r.status_code == 200
    assert r.json() == {"sha": "abc1234", "web_next": False, "built_at": "2026-10-18T04:00:00Z"}


def test_build_info_legacy_and_default(monkeypatch, tmp_path):
    for n in ("PROTOCOLOS_BUILD_SHA", "TRIALLENS_BUILD_SHA", "PROTOCOLOS_BUILT_AT", "TRIALLENS_BUILT_AT"):
        monkeypatch.delenv(n, raising=False)
    with TestClient(_app(tmp_path)) as c:
        body = c.get("/api/build").json()
    assert body["sha"] == "unknown" and body["built_at"] == web_next.STARTED_AT
    monkeypatch.setenv("TRIALLENS_BUILD_SHA", "legacy1")
    with TestClient(_app(tmp_path)) as c:
        assert c.get("/api/build").json()["sha"] == "legacy1"


def test_install_is_idempotent(tmp_path):
    app = _app(tmp_path)
    web_next.install(app, out_dir=tmp_path)
    assert sum(getattr(r, "path", "") == "/api/build" for r in app.routes) == 1


def test_fallback_off_without_export(tmp_path):
    with TestClient(_app(tmp_path / "out")) as c:
        assert c.get("/", follow_redirects=False).json() == {"page": "vanilla"}
        assert c.get("/app/").status_code == 404


def test_fallback_mount_serves_export(tmp_path):
    out = tmp_path / "out"
    (out / "review").mkdir(parents=True)
    (out / "index.html").write_text("<html>ProtocolOS landing</html>")
    (out / "review" / "index.html").write_text("<html>ProtocolOS review</html>")
    with TestClient(_app(out)) as c:
        assert c.get("/api/build").json()["web_next"] is True
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 307 and r.headers["location"] == "/app/"
        assert "ProtocolOS landing" in c.get("/app/").text
        assert "ProtocolOS review" in c.get("/app/review/").text
        # `/` with a query and any other path pass through untouched
        assert c.get(f"/?nct={EL3}", follow_redirects=False).json() == {"page": "vanilla"}
        assert c.post("/", follow_redirects=False).status_code == 405


@pytest.fixture
def real_app(monkeypatch):
    import trialforge.api as api

    yield api
    importlib.reload(api)


def test_real_app_vanilla_root_and_build(real_app, monkeypatch):
    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    api = importlib.reload(real_app)
    with TestClient(api.app) as c:
        r = c.get(f"/?nct={EL3}", follow_redirects=False)
        assert r.status_code == 200 and "text/html" in r.headers["content-type"]
        assert set(c.get("/api/build").json()) >= {"sha", "web_next", "built_at"}


def test_real_app_still_guarded_when_public(real_app, monkeypatch):
    from trialforge import demo_guard

    monkeypatch.delenv("TRIALLENS_PUBLIC", raising=False)
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    api = importlib.reload(real_app)
    demo_guard.install(api.app)
    with TestClient(api.app) as c:
        assert c.get("/api/build").status_code == 200
        assert c.get(f"/api/review/{EL3}?refresh=1").status_code == 403
        assert c.get("/api/review/NCT123").status_code == 400
    monkeypatch.delenv("PROTOCOLOS_PUBLIC")
