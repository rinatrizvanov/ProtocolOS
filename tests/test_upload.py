"""Your own protocol against a draft (trialforge/upload.py, routes_draft.py). Uses the cached EL3 protocol PDF and the
EL3 design-time draft preset in data/; tests that need them skip on a clone without the caches."""
import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from trialforge import upload

DRAFT = "d-d5a333947f18"  # EL3 at design time, its own protocol excluded
SESSION = {"X-ProtocolOS-Session": "c" * 32}
PDF = next(Path("data/protocols").glob("NCT03409614__*.pdf"), None)
KEY = {"X-Model-Provider": "anthropic", "X-Model-Key": "sk-ant-test-" + "x" * 24}


@pytest.fixture
def uploads(monkeypatch, tmp_path):
    monkeypatch.setattr(upload, "UPLOADS", tmp_path / "uploads")
    return tmp_path / "uploads"


@pytest.fixture
def app_client(monkeypatch):
    import trialforge.api as api

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(importlib.reload(api).app)


def test_not_a_pdf_is_refused():
    with pytest.raises(upload.UploadError, match="not a PDF"):
        upload.read_pdf(b"hello", "x.pdf")


@pytest.mark.skipif(PDF is None or not Path(f"data/drafts/{DRAFT}.json").exists(), reason="needs the cached EL3 protocol and draft")
def test_upload_review_is_kept_for_its_session_only(app_client, uploads):
    r = app_client.post(f"/api/draft/{DRAFT}/protocol", content=PDF.read_bytes(),
                        headers={**SESSION, "content-type": "application/pdf", "X-File-Name": "EL3 protocol.pdf"})
    assert r.status_code == 200, r.text
    j = r.json()
    hb = next(x for x in j["reviews"] if x["criterion"]["id"] == "hemoglobin")
    assert (hb["criterion"]["operator"], hb["criterion"]["value_norm"], hb["criterion"]["source"]["page"]) == ("≥", 10.0, 67)
    assert hb["classification"] in ("Review recommended", "Evidence supports retaining", "Insufficient evidence")
    assert "NCT03409614" not in j["precedents"] and j["file_name"] == "EL3 protocol.pdf"
    assert list(uploads.glob("*/*.json")) and not list(uploads.rglob("*.pdf"))  # the PDF itself is not kept
    own = app_client.get(f"/api/draft/{DRAFT}/protocol/{j['upload_id']}", headers=SESSION)
    assert own.status_code == 200 and own.json()["reviews"] == j["reviews"]
    assert app_client.get(f"/api/draft/{DRAFT}/protocol/{j['upload_id']}", headers={"X-ProtocolOS-Session": "d" * 32}).status_code == 404


def test_upload_needs_a_session_and_a_cached_draft(app_client, uploads):
    r = app_client.post(f"/api/draft/{DRAFT}/protocol", content=b"%PDF-1.4", headers={"content-type": "application/pdf"})
    assert r.status_code == 400 and r.json()["code"] == "session_required"
    assert app_client.post("/api/draft/d-000000000000/protocol", content=b"%PDF", headers=SESSION).status_code == 404
    assert app_client.post("/api/draft/bad/protocol", content=b"%PDF", headers=SESSION).status_code == 400


def test_upload_size_limit(app_client, uploads, monkeypatch):
    monkeypatch.setattr(upload, "MAX_BYTES", 1000)
    r = app_client.post(f"/api/draft/{DRAFT}/protocol", content=b"%PDF" + b"x" * 2000, headers={**SESSION, "content-type": "application/pdf"})
    assert r.status_code == 413


@pytest.fixture
def public_client(monkeypatch, uploads):
    import trialforge.api as api
    from trialforge import access

    monkeypatch.delenv("TRIALLENS_PUBLIC", raising=False)
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    access.reset()
    api = importlib.reload(api)
    yield TestClient(api.app), api
    monkeypatch.delenv("PROTOCOLOS_PUBLIC")
    importlib.reload(api)


@pytest.mark.skipif(PDF is None or not Path(f"data/drafts/{DRAFT}.json").exists(), reason="needs the cached EL3 protocol and draft")
def test_public_upload_needs_the_visitors_key(public_client, monkeypatch):
    client, api = public_client
    body = PDF.read_bytes()  # far above the guard's 16 KB limit for other request bodies
    r = client.post(f"/api/draft/{DRAFT}/protocol", content=body, headers={**SESSION, "content-type": "application/pdf"})
    assert r.status_code == 401 and r.json()["code"] == "key_required"
    monkeypatch.setattr(api.llm, "check", lambda creds: api.llm.KeyCheck(True, "ok", "ok"))
    r = client.post(f"/api/draft/{DRAFT}/protocol", content=body, headers={**SESSION, **KEY, "content-type": "application/pdf"})
    assert r.status_code == 200 and r.json()["reviews"]
