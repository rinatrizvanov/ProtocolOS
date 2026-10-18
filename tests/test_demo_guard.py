"""Public-demo guard (PROTOCOLOS_PUBLIC=1, legacy TRIALLENS_PUBLIC=1). Uses the cached EL3 review in data/reviews/; no network."""
import importlib

import pytest
from fastapi.testclient import TestClient

EL3 = "NCT03409614"


def _ensure_graph_routes(app):
    """After WS-A merges but before the api.py hook, routes_graph is importable but not installed."""
    rg = pytest.importorskip("trialforge.routes_graph")
    if not any(getattr(r, "path", "") == "/api/graph/{nct}" for r in app.routes):
        rg.install(app)


@pytest.fixture
def decisions_dir(tmp_path, monkeypatch):
    from trialforge import packet

    monkeypatch.setattr(packet, "DECISIONS", tmp_path / "decisions")
    return tmp_path / "decisions"


@pytest.fixture
def public(monkeypatch, decisions_dir):
    import trialforge.api as api
    from trialforge import demo_guard

    monkeypatch.delenv("TRIALLENS_PUBLIC", raising=False)
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    for name in ("PROTOCOLOS_ALLOW_MODEL", "TRIALLENS_ALLOW_MODEL"):
        monkeypatch.delenv(name, raising=False)
    api = importlib.reload(api)
    demo_guard.install(api.app)  # no-op when the C2 hook already installed it
    with TestClient(api.app) as client:
        yield client, api
    monkeypatch.delenv("PROTOCOLOS_PUBLIC")
    importlib.reload(api)


@pytest.fixture
def open_app(monkeypatch, decisions_dir):
    import trialforge.api as api

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    api = importlib.reload(api)
    with TestClient(api.app) as client:
        yield client, api


def test_as_of_traversal_rejected(public):
    client, _ = public
    assert client.get(f"/api/review/{EL3}", params={"as_of": "../../x"}).status_code == 400
    assert client.get(f"/api/packet/{EL3}", params={"as_of": "../../x"}).status_code == 400
    r = client.post("/api/whatif", json={"nct": EL3, "criterion_id": "hemoglobin", "value": 9, "as_of": "../x"})
    assert r.status_code == 400


def test_bad_nct_rejected(public):
    client, _ = public
    assert client.get("/api/review/NCT0340961").status_code == 400
    assert client.get("/api/protocol/..%2Fx/page/1").status_code in (400, 404)
    assert client.get("/api/protocol/NCT0340961x/page/1").status_code == 400


def test_decision_nct_traversal_rejected(public, decisions_dir):
    client, _ = public
    r = client.post("/api/decision", json={"nct": "../x", "criterion_id": "hemoglobin", "decision": "defer"})
    assert r.status_code == 400
    assert not decisions_dir.exists() or not any(decisions_dir.iterdir())


def test_decision_unknown_criterion_rejected(public, decisions_dir):
    client, _ = public
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "../../etc", "decision": "defer"})
    assert r.status_code == 400
    assert "not a criterion" in r.json()["detail"]


def test_refresh_forbidden(public):
    client, _ = public
    assert client.get(f"/api/review/{EL3}", params={"refresh": 1}).status_code == 403
    assert client.get(f"/api/review/{EL3}", params={"refresh": "true"}).status_code == 403


def test_model_endpoints_disabled(public):
    client, _ = public
    r = client.post("/api/critique", json={"nct": EL3, "criterion_id": "hemoglobin"})
    assert r.status_code == 503 and r.json()["detail"] == "disabled on the public demo"
    r = client.post("/api/parse", json={"nct": EL3, "text": "relax hemoglobin"})
    assert r.status_code == 503 and r.json()["detail"] == "disabled on the public demo"


def test_oversize_body_rejected(public):
    client, _ = public
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "hemoglobin", "decision": "defer", "reviewer": "x" * 17000})
    assert r.status_code == 400 and "too large" in r.json()["detail"]


def test_long_reason_rejected(public):
    client, _ = public
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "hemoglobin", "decision": "defer", "reason": "x" * 1001})
    assert r.status_code == 400


def test_review_and_decision_allowed(public, decisions_dir):
    client, _ = public
    r = client.get(f"/api/review/{EL3}")
    assert r.status_code == 200
    hb = next(x for x in r.json()["reviews"] if x["criterion"]["id"] == "hemoglobin")
    assert hb["classification"] == "Review recommended"
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "hemoglobin", "decision": "needs_medical_review",
                                           "reason": "x" * 1000, "reviewer": "guard test"})
    assert r.status_code == 200 and r.json()["hemoglobin"]["decision"] == "needs_medical_review"
    assert (decisions_dir / f"{EL3}.json").exists()


def test_verify_llm_baseline_forced_off(public, monkeypatch):
    client, api = public
    monkeypatch.setattr(api.llm, "available", lambda: True)
    monkeypatch.setattr(api.llm, "llm_only_verify", lambda rec, r: {"status": "PAID CALL"})
    rec = {"criterion_id": "hemoglobin", "action": "justify_in_protocol", "proposed_value": None, "claims": [], "text": ""}
    r = client.post("/api/verify", json={"nct": EL3, "recommendation": rec, "with_llm_baseline": True})
    assert r.status_code == 200
    assert "llm_only" not in r.json() and "deterministic" in r.json()


def test_graph_allowed(public):
    client, api = public
    _ensure_graph_routes(api.app)
    r = client.get(f"/api/graph/{EL3}", params={"criterion_id": "hemoglobin"})
    assert r.status_code == 200
    assert client.get(f"/api/graph/{EL3}", params={"as_of": "../x"}).status_code == 400


def test_investigate_allowed_and_deterministic(public, monkeypatch, tmp_path):
    client, api = public
    inv = pytest.importorskip("trialforge.investigate")
    _ensure_graph_routes(api.app)
    monkeypatch.setattr(inv, "AUDIT_DIR", tmp_path / "investigations", raising=False)
    r = client.post("/api/investigate", json={"nct": EL3, "criterion_id": "hemoglobin", "question": "why_flagged",
                                              "as_of": "auto", "mode": "model"})
    assert r.status_code == 200
    assert r.json()["mode"] == "deterministic"


def test_install_is_idempotent(public):
    from trialforge import demo_guard

    _, api = public
    n = len(api.app.user_middleware)
    demo_guard.install(api.app)
    assert len(api.app.user_middleware) == n


def test_nothing_blocked_without_public(open_app, decisions_dir):
    client, api = open_app
    assert not getattr(api.app.state, "demo_guard_installed", False)
    # the guard would answer 400 for both; the unguarded app accepts them
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "not_a_criterion", "decision": "defer", "reason": "x" * 1001})
    assert r.status_code == 200
    assert client.get(f"/api/review/{EL3}").status_code == 200


def test_legacy_public_alias_turns_guard_on(monkeypatch, decisions_dir):
    """The legacy TRIALLENS_PUBLIC=1 still turns the guard on after the ProtocolOS rename."""
    import trialforge.api as api

    monkeypatch.delenv("PROTOCOLOS_PUBLIC", raising=False)
    monkeypatch.setenv("TRIALLENS_PUBLIC", "1")
    api = importlib.reload(api)
    try:
        assert getattr(api.app.state, "demo_guard_installed", False)
        with TestClient(api.app) as client:
            assert client.get(f"/api/review/{EL3}?refresh=1").status_code == 403
    finally:
        monkeypatch.delenv("TRIALLENS_PUBLIC")
        importlib.reload(api)


def test_settings_alias_prefers_new_name(monkeypatch):
    from trialforge import settings

    monkeypatch.setenv("TRIALLENS_PUBLIC", "0")
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    assert settings.flag("PUBLIC") and settings.env("PUBLIC") == "1"
    monkeypatch.delenv("PROTOCOLOS_PUBLIC")
    assert not settings.flag("PUBLIC")
    monkeypatch.delenv("TRIALLENS_PUBLIC")
    assert settings.env("PUBLIC", "x") == "x"
