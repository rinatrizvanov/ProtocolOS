"""Public-demo guard (PROTOCOLOS_PUBLIC=1, legacy TRIALLENS_PUBLIC=1). Uses the cached EL3 review in data/reviews/; no network."""
import importlib

import pytest
from fastapi.testclient import TestClient

EL3 = "NCT03409614"
SESSION = {"X-ProtocolOS-Session": "0123456789abcdef0123456789abcdef"}
KEY = {"X-Model-Provider": "anthropic", "X-Model-Key": "sk-ant-test-" + "x" * 24}


@pytest.fixture
def key_ok(monkeypatch):
    """Every key counts as valid; no request reaches a provider."""
    from trialforge import llm

    monkeypatch.setattr(llm, "check", lambda creds: llm.KeyCheck(True, "ok", "ok"))
    return llm


def _ensure_graph_routes(app):
    """Install the graph routes if this app instance does not have them (api.py normally installs them)."""
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

    from trialforge import access

    monkeypatch.delenv("TRIALLENS_PUBLIC", raising=False)
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    access.reset()
    api = importlib.reload(api)
    demo_guard.install(api.app)  # no-op when the api.py install hook already installed it
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
    r = client.post("/api/decision", json={"nct": EL3, "criterion_id": "../../etc", "decision": "defer"}, headers=SESSION)
    assert r.status_code == 400
    assert "not a criterion" in r.json()["detail"]


def test_decision_on_uncached_trial_computes_nothing(public, decisions_dir, monkeypatch):
    client, api = public
    monkeypatch.setattr(api, "run_review", lambda *a, **k: pytest.fail("cold review computed"))
    r = client.post("/api/decision", json={"nct": "NCT00000001", "criterion_id": "anc", "decision": "defer"}, headers=SESSION)
    assert r.status_code == 403


def test_refresh_forbidden(public):
    client, _ = public
    assert client.get(f"/api/review/{EL3}", params={"refresh": 1}).status_code == 403
    assert client.get(f"/api/review/{EL3}", params={"refresh": "true"}).status_code == 403


def test_model_endpoints_need_the_visitors_key(public, monkeypatch):
    client, api = public
    for path, body in (("/api/critique", {"nct": EL3, "criterion_id": "hemoglobin"}), ("/api/parse", {"nct": EL3, "text": "relax hemoglobin"})):
        r = client.post(path, json=body)
        assert r.status_code == 401 and r.json()["code"] == "key_required"
    monkeypatch.setattr(api.llm, "check", lambda creds: api.llm.KeyCheck(False, "key_invalid", "Anthropic rejected this API key."))
    r = client.post("/api/critique", json={"nct": EL3, "criterion_id": "hemoglobin"}, headers=KEY)
    assert r.status_code == 401 and r.json()["code"] == "key_invalid"


def test_critique_runs_with_a_valid_key(public, key_ok, monkeypatch):
    client, api = public
    seen = {}
    monkeypatch.setattr(api.llm, "critique", lambda item, regimen, creds: seen.update(creds=creds) or {"verdict": "agree"})
    r = client.post("/api/critique", json={"nct": EL3, "criterion_id": "hemoglobin"}, headers=KEY)
    assert r.status_code == 200 and r.json() == {"verdict": "agree"}
    assert seen["creds"].provider == "anthropic" and seen["creds"].source == "request"


def test_server_key_never_used_when_public(public, monkeypatch):
    client, api = public
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-server-" + "x" * 24)
    assert api.llm.from_env() is None
    r = client.post("/api/critique", json={"nct": EL3, "criterion_id": "hemoglobin"})
    assert r.status_code == 401


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
    body = {"nct": EL3, "criterion_id": "hemoglobin", "decision": "needs_medical_review", "reason": "x" * 1000, "reviewer": "guard test"}
    r = client.post("/api/decision", json=body)
    assert r.status_code == 400 and r.json()["code"] == "session_required"
    r = client.post("/api/decision", json=body, headers=SESSION)
    assert r.status_code == 200 and r.json()["hemoglobin"]["decision"] == "needs_medical_review"
    sid = SESSION["X-ProtocolOS-Session"]
    assert (decisions_dir / "sessions" / sid / f"{EL3}.json").exists()
    assert not (decisions_dir / f"{EL3}.json").exists()


def test_decisions_are_per_session(public, decisions_dir):
    client, _ = public
    body = {"nct": EL3, "criterion_id": "hemoglobin", "decision": "defer", "reviewer": "visitor a"}
    assert client.post("/api/decision", json=body, headers=SESSION).status_code == 200

    def decision(headers=None, params=None):
        p = client.get(f"/api/packet/{EL3}", headers=headers, params=params).json()
        return next(i["decision"] for i in p["items"] if i["criterion_id"] == "hemoglobin")

    assert decision(SESSION)["decision"] == "defer"
    assert decision({"X-ProtocolOS-Session": "f" * 32}) is None
    assert decision() is None
    assert decision(params={"session": SESSION["X-ProtocolOS-Session"]})["decision"] == "defer"  # export link


def test_verify_llm_baseline_needs_a_key(public, key_ok, monkeypatch):
    client, api = public
    monkeypatch.setattr(api.llm, "llm_only_verify", lambda rec, r, creds: {"status": "PASSED", "reasons": [creds.provider]})
    rec = {"criterion_id": "hemoglobin", "action": "justify_in_protocol", "proposed_value": None, "claims": [], "text": ""}
    r = client.post("/api/verify", json={"nct": EL3, "recommendation": rec, "with_llm_baseline": True})
    assert r.status_code == 200
    assert "llm_only" not in r.json() and "deterministic" in r.json()
    r = client.post("/api/verify", json={"nct": EL3, "recommendation": rec, "with_llm_baseline": True}, headers=KEY)
    assert r.status_code == 200 and r.json()["llm_only"]["reasons"] == ["anthropic"]


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
    body = {"nct": EL3, "criterion_id": "hemoglobin", "question": "why_flagged", "as_of": "auto", "mode": "model"}
    r = client.post("/api/investigate", json=body)
    assert r.status_code == 401 and r.json()["code"] == "key_required"
    r = client.post("/api/investigate", json=dict(body, mode="deterministic"))
    assert r.status_code == 200 and r.json()["mode"] == "deterministic"


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



@pytest.mark.parametrize("as_of", [None, "2018-03", "2018-03-06"])
def test_draft_idea_as_of_passes_guard(public, monkeypatch, as_of):
    """The guard's review as_of rule must not reject a draft idea; routes_draft validates the idea's own as_of."""
    pytest.importorskip("trialforge.routes_draft")
    from trialforge import draft

    client, api = public
    monkeypatch.setattr(api.llm, "check", lambda creds: api.llm.KeyCheck(True, "ok", "ok"))
    seen = []
    monkeypatch.setattr(draft, "get_or_draft", lambda idea, **kw: seen.append(idea) or {"status": "ok", "draft_id": "d-000000000000"})
    idea = dict(draft.PRESETS["nsclc-pd1-chemo"]["idea"], as_of=as_of)
    r = client.post("/api/draft", json=idea, headers=KEY)
    assert r.status_code == 200, r.text
    assert seen and seen[0]["as_of"] == as_of


@pytest.mark.parametrize("nct", ["NCT%D9%A0%D9%A0%D9%A0%D9%A0%D9%A0%D9%A0%D9%A0%D9%A1", "NCT0340961", "nct03409614x"])
def test_rationale_path_nct_validated_by_guard(public, nct):
    """Non-ASCII digits and malformed ids never reach a cold review through /api/rationale."""
    client, _ = public
    assert client.get(f"/api/rationale/{nct}").status_code == 400


# ----------------------------------------------------------------------------- new trials need the visitor's key

COLD = "NCT00000001"


@pytest.fixture
def cold_review(public, monkeypatch, tmp_path):
    """An uncached trial whose review computation is stubbed (no network), cached under tmp_path."""
    client, api = public
    monkeypatch.setattr(api, "REVIEW_CACHE", tmp_path / "reviews")
    calls = []
    base = api.get_review(EL3)

    def fake(nct, as_of=None):
        calls.append(nct)
        r = dict(base)
        r["target"] = dict(base["target"], study=dict(base["target"]["study"], nct_id=nct))
        return r

    monkeypatch.setattr(api, "run_review", fake)
    return client, api, calls


def test_uncached_trial_needs_key(cold_review):
    client, _, calls = cold_review
    r = client.get(f"/api/review/{COLD}")
    assert r.status_code == 401 and r.json()["code"] == "key_required" and not calls
    for path in (f"/api/packet/{COLD}", f"/api/graph/{COLD}", f"/api/rationale/{COLD}"):
        assert client.get(path).status_code == 401
    assert client.post("/api/whatif", json={"nct": COLD, "criterion_id": "hemoglobin", "value": 9}).status_code == 401
    assert not calls


def test_uncached_trial_with_valid_key_is_analysed_once(cold_review, key_ok):
    client, _, calls = cold_review
    r = client.get(f"/api/review/{COLD}", headers=KEY)
    assert r.status_code == 200 and r.json()["target"]["study"]["nct_id"] == COLD and calls == [COLD]
    assert client.get(f"/api/review/{COLD}").status_code == 200 and calls == [COLD]  # now cached: no key needed


def test_invalid_key_is_refused(cold_review, monkeypatch):
    client, api, calls = cold_review
    monkeypatch.setattr(api.llm, "check", lambda creds: api.llm.KeyCheck(False, "key_invalid", "OpenAI rejected this API key."))
    r = client.get(f"/api/review/{COLD}", headers={"X-Model-Provider": "openai", "X-Model-Key": "sk-proj-" + "y" * 30})
    assert r.status_code == 401 and r.json() == {"detail": "OpenAI rejected this API key.", "code": "key_invalid"} and not calls
    r = client.get(f"/api/review/{COLD}", headers={"X-Model-Provider": "other", "X-Model-Key": "sk-" + "y" * 30})
    assert r.status_code == 400 and r.json()["code"] == "key_malformed"


def test_new_analyses_are_rate_limited(cold_review, key_ok, monkeypatch):
    client, _, calls = cold_review
    monkeypatch.setenv("PROTOCOLOS_NEW_PER_HOUR", "1")
    assert client.get(f"/api/review/{COLD}", headers=KEY).status_code == 200
    r = client.get("/api/review/NCT00000002", headers=KEY)
    assert r.status_code == 429 and r.json()["code"] == "rate_limited" and calls == [COLD]
    r = client.get("/api/review/NCT00000002", headers=dict(KEY, **{"X-Forwarded-For": "203.0.113.9"}))
    assert r.status_code == 200
    # another visitor's key behind the same address has a limit of its own
    other = dict(KEY, **{"X-Model-Key": "sk-ant-other-" + "w" * 24})
    assert client.get("/api/review/NCT00000003", headers=other).status_code == 200


def test_daily_limit(cold_review, key_ok, monkeypatch):
    client, _, calls = cold_review
    monkeypatch.setenv("PROTOCOLOS_NEW_PER_DAY", "1")
    assert client.get(f"/api/review/{COLD}", headers=KEY).status_code == 200
    r = client.get("/api/review/NCT00000002", headers=dict(KEY, **{"X-Forwarded-For": "203.0.113.9"}))
    assert r.status_code == 429 and r.json()["code"] == "daily_limit"


def test_protocol_page_only_from_cache(public, monkeypatch):
    client, api = public
    monkeypatch.setattr(api, "fetch_protocol", lambda nct: pytest.fail("protocol downloaded"))
    assert client.get(f"/api/protocol/{COLD}/page/1").status_code == 403


def test_protocol_page_fetched_for_a_comparator_of_a_cached_review(public, monkeypatch):
    """A comparator's protocol that is not on disk yet (a deploy without the PDFs) is downloaded on first view."""
    client, api = public
    comparator = api.get_review(EL3)["comparators"][0]["study"]["nct_id"]
    monkeypatch.setattr(api, "protocol_cached", lambda nct: False)
    fake = type("Doc", (), {"pages": ["page one"], "url": "https://example.org/p.pdf"})()
    monkeypatch.setattr(api, "fetch_protocol", lambda nct: fake)
    r = client.get(f"/api/protocol/{comparator}/page/1")
    assert r.status_code == 200 and r.json()["text"] == "page one"
    assert client.get(f"/api/protocol/{COLD}/page/1").status_code == 403


def test_model_check_endpoint(public, monkeypatch):
    client, api = public
    assert client.post("/api/model/check").json()["code"] == "key_required"
    monkeypatch.setattr(api.llm, "check", lambda creds: api.llm.KeyCheck(True, "ok", "ok"))
    r = client.post("/api/model/check", headers=dict(KEY, **{"X-Model-Name": "claude-haiku-5-5"}))
    assert r.status_code == 200 and r.json()["model"] == "claude-haiku-5-5" and "your key" in r.json()["label"]
    r = client.post("/api/model/check", headers=dict(KEY, **{"X-Model-Name": "gpt-6-luna"}))
    assert r.status_code == 400 and r.json()["code"] == "key_malformed"


def test_status_names_providers_not_a_server_key(public):
    client, _ = public
    s = client.get("/api/status").json()
    assert set(s["llm"]["providers"]) == {"anthropic", "openai"} and s["llm"]["local_key"] is None
    assert "chalk" not in s
