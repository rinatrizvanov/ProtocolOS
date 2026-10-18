"""Redraft workspace checks (POST /api/redraft). Uses the cached EL3 review in data/reviews/; no network."""
import importlib

import pytest
from fastapi.testclient import TestClient

EL3 = "NCT03409614"


@pytest.fixture
def review():
    from trialforge.api import get_review

    return get_review(EL3, "auto")


def codes(d, level=None):
    return {f["code"] for f in d["flags"] if level is None or f["level"] == level}


def test_lower_limit_flags_change_precedents_and_population(review):
    from trialforge.redraft import analyze

    d = analyze(review, "hemoglobin", "Hemoglobin ≥ 9.0 g/dL", "")
    assert d["parsed"]["value"] == 9.0 and d["changed"]["value"] and not d["changed"]["operator"]
    assert {"value_changed", "precedent_at_value", "permissive_precedent", "population", "verifier"} <= codes(d)
    assert d["precedents"]["same"] >= 1 and d["population"]["proposed_pct"] < d["population"]["current_pct"]
    assert [f["level"] for f in d["flags"]] == sorted((f["level"] for f in d["flags"]), key=("fail", "warn", "info", "pass").index)


def test_unchanged_text_passes_without_verifier(review):
    from trialforge.redraft import analyze

    d = analyze(review, "hemoglobin", review_text(review, "hemoglobin"), "")
    assert "unchanged" in codes(d, "pass") and d["verification"] is None and not d["changed"]["value"]


def review_text(review, cid):
    return next(c for c in review["target"]["criteria"] if c["id"] == cid)["source"]["text"]


def test_unparsed_and_wrong_criterion_fail(review):
    from trialforge.redraft import analyze

    assert "unparsed" in codes(analyze(review, "hemoglobin", "Hemoglobin above normal", ""), "fail")
    d = analyze(review, "hemoglobin", "Platelet count ≥100,000/mm3", "")
    assert "unparsed" in codes(d, "fail") and "Platelet" in d["flags"][0]["message"]


def test_overclaiming_rationale_fails(review):
    from trialforge.redraft import analyze
    from trialforge.verifier import OVERCLAIM

    d = analyze(review, "hemoglobin", "Hemoglobin ≥ 9.0 g/dL", "This change is safe and will increase enrollment.")
    assert "overclaim" in codes(d, "fail")
    own = [f["message"] for f in d["flags"] if f["code"] not in ("overclaim", "verifier")]
    assert not any(OVERCLAIM.search(m) for m in own)


def test_no_precedent_at_value_is_insufficient(review):
    from trialforge.redraft import analyze

    d = analyze(review, "hemoglobin", "Hemoglobin ≥ 7.5 g/dL", "")
    msg = next(f["message"] for f in d["flags"] if f["code"] == "no_precedent_at_value")
    assert "Insufficient evidence" in msg


def test_route(monkeypatch):
    import trialforge.api as api

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    api = importlib.reload(api)
    with TestClient(api.app) as c:
        ok = c.post("/api/redraft", json={"nct": EL3, "criterion_id": "hemoglobin", "text": "Hemoglobin ≥ 9 g/dL"})
        assert ok.status_code == 200 and ok.json()["parsed"]["value"] == 9.0
        assert c.post("/api/redraft", json={"nct": EL3, "criterion_id": "nope", "text": "x"}).status_code == 404
        assert c.post("/api/redraft", json={"nct": EL3, "criterion_id": "hemoglobin", "text": "x", "extra": 1}).status_code == 422
        assert c.post("/api/redraft", json={"nct": "NCT0340961X", "criterion_id": "hemoglobin", "text": "x"}).status_code == 400


def test_route_public_cold_403(monkeypatch):
    import trialforge.api as api
    from trialforge import demo_guard

    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    api = importlib.reload(api)
    monkeypatch.setattr(demo_guard, "is_cold", lambda nct, as_of: True)
    try:
        with TestClient(api.app) as c:
            r = c.post("/api/redraft", json={"nct": "NCT00000001", "criterion_id": "hemoglobin", "text": "x"})
            assert r.status_code == 403
    finally:
        monkeypatch.delenv("PROTOCOLOS_PUBLIC")
        importlib.reload(api)


def test_washout_precedent_needs_the_exact_value(review):
    from trialforge.redraft import analyze

    cid = next(c["id"] for c in review["target"]["criteria"] if c["analyte"].startswith("washout") and review["comparison"].get(c["id"]))
    rows = [r for r in review["comparison"][cid] if r.get("criterion") and r["criterion"].get("value_norm")]
    v = rows[0]["criterion"]["value_norm"] + 3  # within the 10% washout tolerance of comparators.direction for v >= 30
    crit = next(c for c in review["target"]["criteria"] if c["id"] == cid)
    d = analyze(review, cid, f"{crit['label']} {crit['operator']}{v:g} days", "")
    assert all(x["value"] == v for x in d["precedents"]["values"] if x["relation"] == "same as draft")


def test_operator_must_match_and_reversal_fails(review):
    from trialforge.redraft import analyze

    d = analyze(review, "anc", "Absolute neutrophil count >1.5 × 10^9/L", "")
    assert d["precedents"]["same"] == 0 and "operator_changed" in codes(d)
    r = analyze(review, "hemoglobin", "Hemoglobin <9 g/dL", "")
    assert "operator_reversed" in codes(r, "fail") and r["precedents"] is None and r["verification"] is None


def test_conditions_are_text(review):
    from trialforge.redraft import analyze

    crit = next((c for c in review["target"]["criteria"] if c.get("conditions")), None)
    if crit is None:
        pytest.skip("no criterion with conditions in the cached EL3 review")
    d = analyze(review, crit["id"], f"{crit['label']} {crit['operator']}{crit['value_norm']:g} {crit['unit_norm']}", "")
    assert all(isinstance(c, str) for c in d["original"]["conditions"] + d["changed"]["conditions_dropped"])
    assert not any("{" in f["message"] for f in d["flags"])


def test_duffy_caveat_only_on_anc(review):
    from trialforge.redraft import analyze

    hgb = analyze(review, "hemoglobin", "Hemoglobin ≥ 9.0 g/dL", "")
    anc = analyze(review, "anc", "Absolute neutrophil count ≥1.0 × 10^9/L", "")
    assert "Duffy" not in hgb["population"]["caveat"] and "Duffy" in anc["population"]["caveat"]
    assert not any("Duffy" in f["message"] for f in hgb["flags"])
