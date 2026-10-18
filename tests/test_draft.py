"""Authoring-mode draft tests (no network): fixed EL3 precedents from the cached review."""
import copy
import json
from pathlib import Path
from unittest import mock

import pytest

from trialforge import comparators, draft, verifier

ROOT = Path(__file__).resolve().parents[1]
EL3 = ROOT / "data" / "reviews" / "NCT03409614_auto.json"
pytestmark = pytest.mark.skipif(not EL3.exists(), reason="cached EL3 review missing")


def _precedents():
    comps = json.loads(EL3.read_text())["comparators"]
    for c in comps:
        c["tags"] = set(c.get("tags") or [])
    return comps


def _run(precedents=None):
    p = draft.PRESETS["el3-design-time"]
    return draft.draft_criteria(p["idea"], fixed_precedents=precedents or _precedents(),
                                exclude=tuple(p["exclude"]))


@pytest.fixture(scope="module")
def el3():
    return _run()


def test_el3_drafts_ok(el3):
    assert el3["status"] == "ok"
    assert el3["draft_id"] == draft.draft_id_for(draft.PRESETS["el3-design-time"]["idea"], ("NCT03409614",))
    assert el3["summary"]["drafted"] >= 3


def test_drafted_has_passing_comparator_value_and_not_rejected(el3):
    for c in el3["criteria"]:
        if c["status"] == "drafted":
            v = c["verification"]
            assert v["status"] != "REJECTED", c["id"]
            assert any(k["check"] == "comparator_value" and k["result"] == "pass" for k in v["checks"]), c["id"]
            assert c["proposed"]["source_nct_id"]


def test_insufficient_has_no_proposed(el3):
    for c in el3["criteria"]:
        assert c["status"] in ("drafted", "insufficient_evidence")
        if c["status"] == "insufficient_evidence":
            assert c["proposed"] is None


def test_no_overclaim_and_protocolos_notes(el3):
    hits = [s for s in draft._strings(el3) if verifier.OVERCLAIM.search(s)]
    assert hits == []
    assert any("ProtocolOS" in n for n in el3["notes"])


def test_no_protocol_specific_phrases(el3):
    # a draft has no protocol of its own yet, so review-engine phrases about one are rewritten
    for s in draft._strings(el3["criteria"]):
        assert "existing rationale" not in s, s
        assert "found in the protocol" not in s, s


def test_source_links_have_no_null_keys(el3):
    for c in el3["criteria"]:
        for cat in c["rationale"]["categories"]:
            for src in cat["sources"]:
                assert None not in src.values(), (c["id"], src)


def test_mutated_claim_is_rejected(el3):
    c = next(c for c in el3["criteria"] if c["status"] == "drafted" and c["category"] == "lab")
    precs = _precedents()
    src = next(p for p in precs if p["study"]["nct_id"] == c["proposed"]["source_nct_id"])
    dcrit = copy.deepcopy(next(k for k in src["criteria"] if k["id"] == c["id"]))
    wrong = dcrit["value_norm"] * 3 + 7
    claims = [{"type": "comparator_threshold", "nct_id": src["study"]["nct_id"], "value": wrong,
               "unit": dcrit["unit_norm"]}]
    res = draft.verify_draft_criterion(dcrit, claims, precs, draft._regimen(
        draft.normalize_idea(draft.PRESETS["el3-design-time"]["idea"])["recognized_drugs"]),
        ["first-line", "metastatic"], None)
    assert res["status"] == "REJECTED"


def test_operator_mismatch_gives_insufficient(el3):
    hb = next(c for c in el3["criteria"] if c["id"] == "hemoglobin")
    assert hb["status"] == "drafted"
    precs = _precedents()
    other = next(p for p in precs if p["study"]["nct_id"] != hb["proposed"]["source_nct_id"]
                 and any(k["id"] == "hemoglobin" and k["value_norm"] == hb["proposed"]["value"]
                         for k in p["criteria"]))
    for k in other["criteria"]:
        if k["id"] == "hemoglobin":
            k["operator"] = ">"
    out = _run(precs)
    hb2 = next(c for c in out["criteria"] if c["id"] == "hemoglobin")
    assert hb2["status"] == "insufficient_evidence"
    assert hb2["proposed"] is None
    assert all(cat["key"] != "precedent" for cat in hb2["rationale"]["categories"])


def test_retrieval_failure_is_not_no_precedents():
    idea = {"condition": "non-small cell lung cancer", "drugs": ["nivolumab", "carboplatin"],
            "setting": ["first-line"], "phase": "PHASE3", "as_of": "2017-01"}
    with mock.patch.object(comparators, "_cached_search", side_effect=ConnectionError("offline")):
        out = draft.draft_criteria(idea)
    assert out["status"] == "retrieval_failed"


def test_retrieval_failure_is_not_cached_or_counted(monkeypatch, tmp_path):
    monkeypatch.setenv("TRIALLENS_PUBLIC", "1")
    monkeypatch.setenv("TRIALLENS_MAX_COLD_DRAFTS", "1")
    monkeypatch.delenv("PROTOCOLOS_PUBLIC", raising=False)
    monkeypatch.delenv("PROTOCOLOS_MAX_COLD_DRAFTS", raising=False)
    monkeypatch.setattr(draft, "DRAFTS_DIR", tmp_path)
    monkeypatch.setattr(draft, "_COLD_COUNT", 0)
    idea = {"condition": "small cell lung cancer", "drugs": ["etoposide"], "setting": [], "phase": "PHASE3"}
    with mock.patch.object(comparators, "_cached_search", side_effect=ConnectionError("offline")):
        for _ in range(3):
            assert draft.get_or_draft(idea)["status"] == "retrieval_failed"
    assert draft._COLD_COUNT == 0
    assert list(tmp_path.iterdir()) == []


def test_public_cap_returns_429(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from trialforge.api import app

    monkeypatch.setenv("TRIALLENS_PUBLIC", "1")
    monkeypatch.setenv("TRIALLENS_MAX_COLD_DRAFTS", "1")
    monkeypatch.delenv("PROTOCOLOS_PUBLIC", raising=False)
    monkeypatch.delenv("PROTOCOLOS_MAX_COLD_DRAFTS", raising=False)
    monkeypatch.setattr(draft, "DRAFTS_DIR", tmp_path)
    monkeypatch.setattr(draft, "_COLD_COUNT", 0)

    def fake(idea, fixed_precedents=None, exclude=()):
        return {"draft_id": draft.draft_id_for(idea, exclude), "status": "ok", "criteria": [],
                "summary": {"drafted": 0, "cached": False}, "warnings": [], "notes": []}

    monkeypatch.setattr(draft, "draft_criteria", fake)
    client = TestClient(app)
    a = {"condition": "small cell lung cancer", "drugs": ["etoposide"], "setting": [], "phase": "PHASE3"}
    b = {"condition": "small cell lung cancer", "drugs": ["atezolizumab"], "setting": [], "phase": "PHASE3"}
    c = {"condition": "small cell lung cancer", "drugs": ["durvalumab"], "setting": [], "phase": "PHASE3"}
    assert client.post("/api/draft", json=a).status_code == 200
    r = client.post("/api/draft", json=b)
    assert r.status_code == 429
    assert r.json()["detail"] == "new ideas limit reached on the public demo; presets still work"
    assert client.post("/api/draft", json=a).status_code == 200  # cached ideas still answer
    assert client.post("/api/draft", json=c).status_code == 429
    assert client.post("/api/draft", json={**a, "extra": 1}).status_code == 422
    assert client.post("/api/draft", json={**a, "condition": "   "}).status_code == 422
    assert client.get("/api/draft/not-an-id").status_code == 400
    assert client.get("/api/draft/d-000000000000").status_code == 404
