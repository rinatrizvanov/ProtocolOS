"""Condition criteria (brain metastases, HIV, hepatitis B/C, prior malignancy, QTc): extraction from criterion text,
their direction, and how the review engine applies the July 2020 FDA guidances. The extraction cases are plain
sentences; the review and API cases use the cached EL3 review in data/ and skip on a clone without it."""
import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from trialforge import review
from trialforge.comparators import direction
from trialforge.extract import LIFETIME_YEARS, Line, criterion_text, extract_conditions
from trialforge.guidance import verify_quote
from trialforge.verifier import expected_guidance, verify

EL3_CACHED = Path("data/reviews/NCT03409614_auto.json").exists()


def _read(text: str, section: str = "exclusion") -> dict:
    return {c.id: c for c in extract_conditions([Line(1, 1, text, section)], None, "test")}


@pytest.mark.parametrize("text, section, cid, level", [
    ("Known brain metastases.", "exclusion", "brain_mets", 0),
    ("Known active brain metastases. Patients with previously treated brain metastases may participate provided they are stable.",
     "exclusion", "brain_mets", 1),
    ("Brain metastases must be asymptomatic or treated and stable off steroids.", "inclusion", "brain_mets", 2),
    ("Known history of human immunodeficiency virus (HIV) infection.", "exclusion", "hiv", 0),
    ("Uncontrolled HIV infection. Patients with HIV are eligible if CD4+ count is at least 350 cells/uL.", "exclusion", "hiv", 1),
    ("Positive test for hepatitis B surface antigen (HBsAg).", "exclusion", "hbv", 0),
    ("Active hepatitis B (detectable HBV DNA).", "exclusion", "hbv", 1),
    ("Known hepatitis C virus infection.", "exclusion", "hcv", 0),
    ("Active hepatitis C (detectable HCV RNA).", "exclusion", "hcv", 1),
])
def test_policy_levels(text, section, cid, level):
    c = _read(text, section)[cid]
    assert (c.operator, c.value_norm, c.unit_norm) == ("policy", level, "policy level")
    assert c.display and criterion_text(c.to_dict()) == c.display


def test_prior_malignancy_interval_and_exceptions():
    c = _read("Another malignancy that is progressing or required active treatment within the past 3 years, "
              "except basal cell carcinoma of the skin.")["prior_malignancy"]
    assert (c.operator, c.value_norm, c.unit_norm) == ("≥", 3, "years")
    assert c.exceptions == ["basal cell carcinoma of the skin"]
    lifetime = _read("No history of prior malignancy.", "inclusion")["prior_malignancy"]
    assert lifetime.value_norm == LIFETIME_YEARS and "at any time" in lifetime.display


def test_qtc_exclusion_becomes_allowed_maximum():
    c = _read("QTcF > 470 ms at screening.")["qtc"]
    assert (c.operator, c.value_norm, c.unit_norm) == ("≤", 470, "ms")


def test_other_anticancer_therapy_is_not_a_prior_malignancy():
    assert "prior_malignancy" not in _read("Other anti-cancer therapy within 4 weeks before the first dose.")


def test_direction_of_condition_criteria():
    assert direction("brain_mets", 1, 2) == "comparator looser"  # a higher policy level admits more patients
    assert direction("hiv", 1, 0) == "comparator stricter"
    assert direction("prior_malignancy", 5, 2) == "comparator looser"  # a shorter required interval
    assert direction("qtc", 470, 500) == "comparator looser"


def _policy_crit(cid: str, level: int) -> dict:
    c = next(iter(_read({"brain_mets": "Known brain metastases.", "hiv": "Known HIV infection."}[cid]).values())).to_dict()
    return {**c, "value": float(level), "value_norm": float(level)}


def _target() -> dict:
    return {"study": {"nct_id": "NCT00000000", "start_date": "2018-01"}, "regimen": {"drugs": {}, "unrecognized": []}, "criteria": []}


def test_specific_recommendation_challenges_only_below_its_level():
    excluded = review.review_criterion(_policy_crit("hiv", 0), _target(), [], None, set())
    assert excluded["classification"] == review.CLASS_REVIEW
    assert "FDA's July 2020 guidance makes a specific recommendation" in excluded["explanation"]
    assert excluded["suggested_action"]["text"] == review.POLICY_SUGGESTIONS["hiv"]
    allowed = review.review_criterion(_policy_crit("hiv", 1), _target(), [], None, set())
    cd4 = next(e for e in allowed["evidence"] if e.get("key") == "hiv_cd4")
    assert cd4["stance"] == "context" and allowed["classification"] != review.CLASS_REVIEW


def test_active_brain_metastases_passage_stays_general():
    # conditional on CNS activity or a common CNS spread, so it is shown but never scored
    r = review.review_criterion(_policy_crit("brain_mets", 1), _target(), [], None, set())
    active = next(e for e in r["evidence"] if e.get("key") == "bm_active_not_auto")
    assert (active["stance"], active["strength"]) == ("challenges", "general") and r["scores"]["challenge"] == 0


def test_verifier_expects_the_guidance_for_the_analyte():
    crit = _policy_crit("hiv", 0)
    assert expected_guidance(crit) == "infection" and expected_guidance({"category": "lab", "analyte": "anc"}) == "lab"
    quote = "Patients with CD4+ T-cell (CD4+) counts ≥ 350 cells/uL should generally be eligible for any study."
    ctx = {"target": {**_target(), "criteria": [crit]}, "comparators": []}
    resolvers = {"fda_quote": lambda g, q: {**verify_quote(g, q), "section": "", "fda_lines": ""}}

    def checks(guidance: str) -> dict:
        rec = {"criterion_id": "hiv", "action": "justify_in_protocol",
               "claims": [{"type": "fda_quote", "guidance": guidance, "quote": quote}]}
        return {c["check"]: c["result"] for c in verify(rec, ctx, resolvers)["checks"]}

    assert checks("infection")["fda_quote"] == "pass"
    assert checks("lab")["fda_quote"] == "fail"  # the quote is not in the laboratory guidance


@pytest.fixture
def client(monkeypatch):
    import trialforge.api as api

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(importlib.reload(api).app)


def test_review_cached_before_the_schema_stamp_is_computed_again(monkeypatch, tmp_path):
    import json

    import trialforge.api as api

    monkeypatch.setattr(api, "REVIEW_CACHE", tmp_path)
    monkeypatch.setattr(api, "REVIEW_STATE", None)
    monkeypatch.setattr(api, "_mem", {})
    (tmp_path / "NCT00000001_auto.json").write_text(json.dumps({"reviews": [], "stale": True}))
    calls = []
    monkeypatch.setattr(api, "run_review", lambda nct, as_of=None: calls.append(nct) or {"reviews": []})
    r = api.get_review("NCT00000001")
    assert calls == ["NCT00000001"] and r["review_schema"] == api.REVIEW_SCHEMA and "stale" not in r
    monkeypatch.setattr(api, "_mem", {})
    assert api.get_review("NCT00000001")["review_schema"] == api.REVIEW_SCHEMA and calls == ["NCT00000001"]  # read, not recomputed


@pytest.mark.skipif(not EL3_CACHED, reason="needs the cached EL3 review")
def test_policy_criteria_refuse_numeric_what_if_and_redraft(client):
    r = client.post("/api/whatif", json={"nct": "NCT03409614", "criterion_id": "brain_mets", "value": 2})
    assert r.status_code == 400 and "policy" in r.json()["detail"]
    r = client.post("/api/redraft", json={"nct": "NCT03409614", "criterion_id": "hiv", "text": "HIV allowed"})
    assert r.status_code == 400 and "condition criterion" in r.json()["detail"]
