"""API checks for the ProtocolOS rename and the unguarded as_of validation (CR-v2-8).

Uses the cached EL3 review in data/reviews/; the as_of checks fail before any network call.
"""
import importlib

import pytest
from fastapi.testclient import TestClient

EL3 = "NCT03409614"


@pytest.fixture
def open_app(monkeypatch, tmp_path):
    """The engine without the public-demo guard."""
    import trialforge.api as api
    from trialforge import packet

    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    api = importlib.reload(api)
    monkeypatch.setattr(packet, "DECISIONS", tmp_path / "decisions")
    with TestClient(api.app) as client:
        yield client


def test_swagger_title(open_app):
    spec = open_app.get("/openapi.json").json()
    assert spec["info"]["title"] == "ProtocolOS"
    assert spec["info"].get("description")
    assert "ProtocolOS" in open_app.get("/docs").text


@pytest.mark.parametrize("bad", ["../../x", "2026-1-1", "latest", "auto;rm", "none/.."])
def test_as_of_rejected_without_guard(open_app, bad):
    r = open_app.get(f"/api/review/{EL3}", params={"as_of": bad})
    assert r.status_code == 400
    assert "as_of" in r.json()["detail"]


def test_as_of_rejected_on_packet_without_guard(open_app):
    assert open_app.get(f"/api/packet/{EL3}", params={"as_of": "../../x"}).status_code == 400


def test_packet_file_name_and_notes(open_app):
    r = open_app.get(f"/api/packet/{EL3}", params={"format": "md"})
    assert r.status_code == 200
    assert f'filename="ProtocolOS_{EL3}_review_packet.md"' in r.headers["content-disposition"]
    assert r.text.startswith("# ProtocolOS eligibility review packet")
    assert "cannot be seen by ProtocolOS" in r.text
    assert "Reason: <label>." in r.text
    assert "TrialLens" not in r.text


def test_defer_label():
    from trialforge.packet import DECISION_OPTIONS

    assert DECISION_OPTIONS["defer"] == "Defer / needs more information"


def test_favicon(open_app):
    r = open_app.get("/favicon.ico")
    assert r.status_code == 200
    assert r.content
