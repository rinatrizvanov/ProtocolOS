"""Semantic trial search (trialforge/trial_index.py, routes_trials.py) on a synthetic three-trial index; no model download."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from trialforge import trial_index

RECORDS = [
    {"nct_id": "NCT00000011", "title": "Squamous NSCLC chemo-immunotherapy", "acronym": "SQ", "conditions": ["NSCLC"],
     "interventions": ["pembrolizumab"], "phases": ["PHASE3"], "start_date": "2016-06-01", "status": "COMPLETED", "sponsor": "A"},
    {"nct_id": "NCT00000022", "title": "Non-squamous NSCLC chemo-immunotherapy", "acronym": "NSQ", "conditions": ["NSCLC"],
     "interventions": ["pembrolizumab", "pemetrexed"], "phases": ["PHASE3"], "start_date": "2018-03", "status": "COMPLETED", "sponsor": "B"},
    {"nct_id": "NCT00000033", "title": "HER2-low breast cancer ADC", "acronym": "HER", "conditions": ["Breast cancer"],
     "interventions": ["trastuzumab deruxtecan"], "phases": ["PHASE3"], "start_date": "2009-05-01", "status": "COMPLETED", "sponsor": "C"},
]
VECTORS = np.array([[1, 0, 0], [0.8, 0.6, 0], [0, 0, 1]], dtype=np.float32)


class Model:
    """Maps a text to a fixed direction: lung words to the first two trials, breast words to the third."""

    def _vec(self, text):
        return np.array([0.0, 0.0, 1.0]) if "breast" in text.lower() else np.array([0.95, 0.1, 0.0])

    def query_embed(self, texts):
        return (self._vec(t) for t in texts)

    def passage_embed(self, texts):
        return (self._vec(t) for t in texts)


@pytest.fixture
def index(monkeypatch):
    idx = {"meta": {"model": "test", "count": 3}, "records": RECORDS, "vectors": VECTORS,
           "row": {r["nct_id"]: i for i, r in enumerate(RECORDS)}, "model": Model()}
    monkeypatch.setattr(trial_index, "_state", {"index": idx})
    return idx


def test_search_ranks_by_similarity(index):
    assert [r["nct_id"] for r in trial_index.search("squamous lung cancer", k=3)] == ["NCT00000011", "NCT00000022", "NCT00000033"]
    assert trial_index.search("HER2 breast", k=1)[0]["nct_id"] == "NCT00000033"


def test_similar_excludes_the_trial_and_applies_the_date_window(index):
    assert [r["nct_id"] for r in trial_index.similar("NCT00000022", "", k=3)] == ["NCT00000011", "NCT00000033"]
    # the comparator window: started from 2010 up to the cutoff, inclusive (as the keyword search)
    assert [r["nct_id"] for r in trial_index.similar("NCT00000022", "", k=3, until="2016-06-01")] == ["NCT00000011"]
    assert trial_index.similar("NCT00000022", "", k=3, until="2016-05-31") == []


def test_unavailable_without_index(monkeypatch, tmp_path):
    monkeypatch.setattr(trial_index, "_state", {})
    monkeypatch.setattr(trial_index, "INDEX_DIR", tmp_path / "missing")
    assert not trial_index.available() and trial_index.search("anything") == []
    assert trial_index.status()["available"] is False


@pytest.fixture
def client(monkeypatch):
    import trialforge.api as api

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(api.app)


def test_search_route(index, client):
    r = client.get("/api/trials/search", params={"q": "lung cancer immunotherapy", "k": 2})
    assert r.status_code == 200
    rows = r.json()["results"]
    assert [x["nct_id"] for x in rows] == ["NCT00000011", "NCT00000022"] and rows[0]["analysed"] is False
    assert client.get("/api/trials/search", params={"q": "ab"}).status_code == 422


def test_similar_route(index, client):
    r = client.get("/api/trials/similar/NCT00000011", params={"k": 2})
    assert r.status_code == 200 and [x["nct_id"] for x in r.json()["results"]] == ["NCT00000022", "NCT00000033"]
    assert client.get("/api/trials/similar/NCT0000001").status_code == 400
    assert client.get("/api/trials/similar/NCT00000099").status_code == 404  # not indexed, not analysed


def test_search_unavailable_is_503(client, monkeypatch, tmp_path):
    monkeypatch.setattr(trial_index, "_state", {})
    monkeypatch.setattr(trial_index, "INDEX_DIR", tmp_path / "missing")
    assert client.get("/api/trials/search", params={"q": "lung cancer"}).status_code == 503


def test_public_search_is_rate_limited(index, client, monkeypatch):
    from trialforge import routes_trials

    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    monkeypatch.setattr(routes_trials, "SEARCHES", routes_trials.access.Window(3600))
    for _ in range(120):
        assert client.get("/api/trials/search", params={"q": "lung cancer"}).status_code == 200
    r = client.get("/api/trials/search", params={"q": "lung cancer"})
    assert r.status_code == 429 and r.json()["code"] == "rate_limited"
