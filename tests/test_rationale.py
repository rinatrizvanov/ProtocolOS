"""Rationale report: categories, arm attribution, missing criteria and the /api/rationale route.

Uses the cached reviews in data/reviews/ (no network); a trial whose review is not cached is skipped.
"""
import copy
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scripts.brand_check import LEGACY
from trialforge import rationale
from trialforge.api import REVIEW_CACHE
from trialforge.verifier import OVERCLAIM

EL3 = "NCT03409614"
CACHED = ["NCT03409614", "NCT02578680", "NCT03088540", "NCT02819518"]
REPORT_KEYS = ["blind_spot", "criteria", "method", "missing", "nct_id", "schema_version"]


def _cached(nct: str) -> dict:
    p = REVIEW_CACHE / f"{nct}_auto.json"
    if not p.exists():
        pytest.skip(f"{nct} review not cached (python -m scripts.prewarm {nct})")
    return json.loads(p.read_text())


@pytest.fixture(scope="module")
def el3():
    return _cached(EL3)


def test_el3_hemoglobin_safety_and_all_arms(el3):
    rep = rationale.rationale_report(el3)
    hb = rep["criteria"]["hemoglobin"]
    keys = [c["key"] for c in hb["categories"]]
    assert "safety" in keys
    safety = next(c for c in hb["categories"] if c["key"] == "safety")
    assert safety["label"] == "Safety" and safety["status"] in ("inferred", "stated in protocol")
    arm = hb["arm_attribution"]
    assert arm["driver"] == "all_arms"
    assert arm["property"] == "myelosuppression (anemia)"
    assert len(arm["arms"]) == 5 and all(a["has_agent"] for a in arm["arms"])
    assert "listed in" in arm["text"] and "caus" not in arm["text"].lower()


def test_el3_ecog_not_applicable(el3):
    arm = rationale.arm_attribution(el3, "ecog")
    assert arm["driver"] == "not_applicable" and arm["property"] is None and arm["agents"] == []


def test_category_rules(el3):
    item = next(rv for rv in el3["reviews"] if rv["criterion"]["id"] == "hemoglobin")
    item = copy.deepcopy(item)
    item["purposes"] = [{"purpose": "Predictive enrichment", "status": "possible (inferred)", "basis": "b"}]
    item["evidence"] = [{"kind": "fda", "stance": "challenges", "strength": "specific", "citation": "FDA x", "link": "u"},
                        {"kind": "protocol", "stance": "supports", "page": 3, "url": "p"}]
    cats = {c["key"]: c for c in rationale.categories(item, el3)}
    assert set(cats) == {"enrichment", "precedent"}
    assert cats["enrichment"]["status"] == "stated in protocol"
    assert {s["kind"] for s in cats["precedent"]["sources"]} == {"fda"}
    item["purposes"] = [{"purpose": "Predictive enrichment", "status": "not indicated", "basis": "b"}]
    item["evidence"] = [{"kind": "comparator", "stance": "challenges", "strength": "moderate", "nct_id": "NCT1"},
                        {"kind": "fda", "stance": "challenges", "strength": "general"}]
    assert rationale.categories(item, el3) == []


def _review(arms, drugs=("carboplatin", "pembrolizumab")):
    return {"target": {"study": {"nct_id": "NCT00000000"},
                       "criteria": [{"id": "anc", "analyte": "anc"}],
                       "regimen": {"drugs": {d: {} for d in drugs}, "arms": arms}},
            "comparators": [], "reviews": []}


@pytest.mark.parametrize("arms,driver", [
    ([{"label": "Pembrolizumab + Carboplatin", "type": "EXPERIMENTAL", "interventions": []},
      {"label": "Placebo", "type": "PLACEBO_COMPARATOR", "interventions": ["Drug: Saline"]}], "investigational"),
    ([{"label": "Pembrolizumab", "type": "EXPERIMENTAL", "interventions": []},
      {"label": "Standard-of-care chemotherapy", "type": "ACTIVE_COMPARATOR", "interventions": []}], "comparator"),
    ([{"label": "A", "type": "EXPERIMENTAL", "interventions": ["Drug: Carboplatin"]},
      {"label": "B", "type": "EXPERIMENTAL", "interventions": []},
      {"label": "C", "type": "ACTIVE_COMPARATOR", "interventions": ["Drug: Carboplatin"]}], "mixed"),
    ([{"label": "A", "type": "OTHER", "interventions": ["Drug: Carboplatin"]},
      {"label": "B", "type": "EXPERIMENTAL", "interventions": []}], "undetermined"),
    ([], "undetermined"),
])
def test_arm_driver_rules(arms, driver):
    arm = rationale.arm_attribution(_review(arms), "anc")
    assert arm["driver"] == driver
    assert "listed in" in arm["text"] or driver == "undetermined"
    assert not OVERCLAIM.search(arm["text"]) and "caus" not in arm["text"].lower()


def test_arm_text_names_only_matched_agents_and_other_arms():
    arms = [{"label": "Pembrolizumab", "type": "EXPERIMENTAL", "interventions": []},
            {"label": "Carboplatin doublet", "type": "ACTIVE_COMPARATOR", "interventions": []},
            {"label": "Placebo", "type": "PLACEBO_COMPARATOR", "interventions": []}]
    arm = rationale.arm_attribution(_review(arms, ("carboplatin", "cisplatin", "pembrolizumab")), "anc")
    assert arm["driver"] == "comparator"
    assert "Of these, carboplatin is listed in the comparator / standard-of-care arm(s) only ('Carboplatin doublet')" in arm["text"]
    assert "the other arm(s) ('Pembrolizumab'; 'Placebo') do not list it" in arm["text"]
    assert "investigational arm(s) (" not in arm["text"] and arm["text"].endswith("matched cisplatin.")
    assert {a["name"]: a["arms"] for a in arm["agents"]} == {"carboplatin": "comparator", "cisplatin": "undetermined"}


def test_all_arms_text_distinguishes_each_from_at_least_one():
    each = rationale.arm_attribution(_review([{"label": "A", "type": "EXPERIMENTAL", "interventions": ["Drug: Carboplatin"]},
                                              {"label": "B", "type": "ACTIVE_COMPARATOR", "interventions": ["Drug: Carboplatin"]}]), "anc")
    assert each["driver"] == "all_arms" and "It is listed in both arms, investigational and comparator alike." in each["text"]
    some = rationale.arm_attribution(_review([{"label": "A", "type": "EXPERIMENTAL", "interventions": ["Drug: Carboplatin"]},
                                              {"label": "B", "type": "ACTIVE_COMPARATOR", "interventions": ["Drug: Gemcitabine"]}],
                                             ("carboplatin", "gemcitabine")), "anc")
    assert some["driver"] == "all_arms" and "At least one of them is listed in each of the 2 arms" in some["text"]


def test_no_flagged_agent_is_not_applicable():
    arm = rationale.arm_attribution(_review([{"label": "Pembrolizumab", "type": "EXPERIMENTAL"}], ("pembrolizumab",)), "anc")
    assert arm["driver"] == "not_applicable" and arm["property"] == "myelosuppression (neutropenia)"


def test_missing_criteria_synthetic(el3):
    assert [m["criterion_id"] for m in rationale.missing_criteria(el3)] == []
    r = copy.deepcopy(el3)
    r["target"]["criteria"] = [c for c in r["target"]["criteria"] if c["id"] != "hemoglobin"]
    missing = rationale.missing_criteria(r)
    assert len(missing) == 1
    m = missing[0]
    assert m["criterion_id"] == "hemoglobin" and m["comparators_total"] == len(el3["comparators"])
    assert m["comparators_with"] == len(m["examples"]) >= 2
    assert m["text"].startswith("Not extracted from this protocol; present in ")
    assert all(e["threshold"] and e["nct_id"].startswith("NCT") for e in m["examples"])


def test_missing_threshold():
    def comp(i, ids):
        return {"study": {"nct_id": f"NCT0000000{i}", "acronym": None}, "criteria": [{"id": x, "label": x} for x in ids]}

    base = {"target": {"criteria": []}}
    # M = 4 -> need 3; M = 2 -> need 2; M = 1 -> never
    four = dict(base, comparators=[comp(1, ["a", "b"]), comp(2, ["a", "b"]), comp(3, ["a"]), comp(4, [])])
    assert [m["criterion_id"] for m in rationale.missing_criteria(four)] == ["a"]
    two = dict(base, comparators=[comp(1, ["a"]), comp(2, ["a"])])
    assert [m["criterion_id"] for m in rationale.missing_criteria(two)] == ["a"]
    one = dict(base, comparators=[comp(1, ["a"])])
    assert rationale.missing_criteria(one) == []


@pytest.mark.parametrize("nct", CACHED)
def test_all_texts_pass_overclaim(nct):
    rep = rationale.rationale_report(_cached(nct))
    assert sorted(rep) == REPORT_KEYS and rep["schema_version"] == 1 and rep["nct_id"] == nct
    texts = rationale.texts(rep)
    assert texts and not [t for t in texts if OVERCLAIM.search(t)]
    assert "ProtocolOS" in rep["blind_spot"] and not LEGACY.search(" ".join(texts))
    for v in rep["criteria"].values():
        assert "caus" not in v["arm_attribution"]["text"].lower()


@pytest.fixture
def client(monkeypatch):
    from trialforge import routes_rationale

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    app = FastAPI()
    routes_rationale.install(app)
    routes_rationale.install(app)  # idempotent
    assert sum(getattr(r, "path", "") == "/api/rationale/{nct}" for r in app.routes) == 1
    return TestClient(app)


def test_route_ok_and_bad_nct(client, el3):
    r = client.get(f"/api/rationale/{EL3}")
    assert r.status_code == 200
    d = r.json()
    assert sorted(d) == REPORT_KEYS and d["criteria"]["hemoglobin"]["arm_attribution"]["driver"] == "all_arms"
    assert client.get("/api/rationale/NOTANNCT").status_code == 400
    assert client.get(f"/api/rationale/{EL3}?as_of=../x").status_code == 400


def test_route_public_cold_403(client, monkeypatch, el3):
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    cold = "NCT00000001"
    assert not (REVIEW_CACHE / f"{cold}_auto.json").exists()
    r = client.get(f"/api/rationale/{cold}")
    assert r.status_code == 403 and r.json() == {"detail": "review not cached on the public demo"}
    assert client.get(f"/api/rationale/{EL3}").status_code == 200
    assert client.get("/api/rationale/NOTANNCT").status_code == 400


def test_installed_on_the_api_app(el3):
    import trialforge.api as api

    assert any(getattr(r, "path", "") == "/api/rationale/{nct}" for r in api.app.routes)
