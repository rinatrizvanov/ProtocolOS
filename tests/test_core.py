"""Fast invariants (uses cached documents in data/; run `python -m trialforge.sources` first on a fresh clone)."""
import pytest

from trialforge.comparators import direction
from trialforge.extract import analyze_trial
from trialforge.guidance import load_passages, verify_quote
from trialforge.sources import decode_symbol_font
from trialforge.verifier import verify


@pytest.fixture(scope="module")
def el3():
    from trialforge.review import run_review

    return run_review("NCT03409614")


def test_all_fda_passages_verify_verbatim():
    ok, failed = load_passages()
    assert failed == [] and len(ok) >= 20


def test_fda_misquote_is_detected():
    q = "Laboratory values should be used as exclusionary criteria only when clearly necessary to mitigate potential safety concerns."
    assert verify_quote("lab", q)["ok"]
    assert not verify_quote("lab", q.replace("should", "must"))["ok"]


def test_symbol_font_decoding():
    assert decode_symbol_font("ANC  1500 cells/L") == "ANC ≥ 1500 cells/µL"


def test_el3_extraction_values():
    crit = {c["id"]: c for c in analyze_trial("NCT03409614")["criteria"]}
    assert (crit["hemoglobin"]["operator"], crit["hemoglobin"]["value_norm"]) == ("≥", 10.0)
    assert crit["anc"]["value_norm"] == 1.5 and crit["platelets"]["value_norm"] == 100.0
    assert crit["ecog"]["value_norm"] == 1.0
    assert crit["hemoglobin"]["source"]["page"] == 67


def test_unit_normalization_per_microliter():
    crit = {c["id"]: c for c in analyze_trial("NCT02578680")["criteria"]}  # "≥1,500 /mcL"
    assert crit["anc"]["value_norm"] == 1.5 and crit["anc"]["unit_norm"] == "×10⁹/L"


def test_direction_semantics():
    assert direction("hemoglobin", 10.0, 9.0) == "comparator looser"
    assert direction("ast_alt", 2.5, 3.0) == "comparator looser"
    assert direction("ast_alt", 3.0, 2.5) == "comparator stricter"
    assert direction("washout_surgery", 28, 21) == "comparator looser"


def test_regimen_contradiction_rejected(el3):
    rec = {"criterion_id": "anc", "action": "relax", "proposed_value": 1.0,
           "claims": [{"type": "drug_property", "drug": "cemiplimab", "property": "myelosuppressive", "value": False}],
           "text": "PD-1 inhibitors are not myelosuppressive."}
    out = verify(rec, el3)
    assert out["status"] == "REJECTED"
    assert any(c["check"] == "regimen_contradiction" for c in out["checks"])


def test_cautious_recommendation_not_rejected(el3):
    rec = {"criterion_id": "hemoglobin", "action": "justify_in_protocol",
           "claims": [{"type": "comparator_threshold", "nct_id": "NCT03215706", "value": 9.0, "unit": "g/dL"}],
           "text": "Document why 10.0 g/dL is required."}
    assert verify(rec, el3)["status"] != "REJECTED"


def test_overclaim_rejected(el3):
    rec = {"criterion_id": "hemoglobin", "action": "relax", "proposed_value": 9.0,
           "claims": [{"type": "comparator_threshold", "nct_id": "NCT03215706", "value": 9.0, "unit": "g/dL"}],
           "text": "9.0 g/dL is safe."}
    assert verify(rec, el3)["status"] == "REJECTED"


def test_el3_classifications(el3):
    cls = {r["criterion"]["id"]: r["classification"] for r in el3["reviews"]}
    assert cls["hemoglobin"] == "Review recommended"
    assert cls["platelets"] == "Evidence supports retaining"


def test_toxicity_rationale_never_marks_value_justified(el3):
    hgb = next(r for r in el3["reviews"] if r["criterion"]["id"] == "hemoglobin")
    reg = [e for e in hgb["evidence"] if e["kind"] == "regimen"]
    assert reg and reg[0]["strength"] == "existence only"


def test_nhanes_weighted_estimates():
    from trialforge.nhanes import below_threshold

    r = below_threshold("anc", 1.5)
    groups = {g["group"]: g for g in r["groups"]}
    assert 0 <= r["overall"]["pct"] <= 100
    assert groups["Non-Hispanic Black"]["pct"] > groups["Non-Hispanic White"]["pct"]
    assert "not an oncology" in r["caveat"]


def test_regimen_rationale_alone_never_retains():
    """KEYNOTE-355 has no comparators before its start date: lab thresholds must not be 'retained'
    on the strength of a chemotherapy toxicity link alone."""
    from trialforge.review import run_review

    r = run_review("NCT02819518")
    assert r["comparators"] == []
    for rv in r["reviews"]:
        if rv["criterion"]["category"] == "lab":
            assert rv["classification"] != "Evidence supports retaining", rv["criterion"]["id"]


def test_page_text_without_the_pdf_needs_no_download(tmp_path, monkeypatch):
    """A deploy may ship only the extracted page text; the engine then never fetches the PDF again."""
    import json

    from trialforge import sources

    pdf = tmp_path / "NCT00000001__Prot_000.pdf"
    pdf.with_suffix(".pages.json").write_text(json.dumps(["page one", "page two"]))
    monkeypatch.setattr(sources, "_get", lambda url, timeout=90.0: pytest.fail("PDF downloaded"))
    doc = sources._cached_pdf("protocol:NCT00000001", "https://example.org/p.pdf", pdf)
    assert doc.pages == ["page one", "page two"] and not pdf.exists()


def test_letter_spaced_ocr_text_is_reextracted(monkeypatch, tmp_path):
    """OCR text layers that come out as split letters are re-read with pdfminer; ordinary text is left alone."""
    from trialforge import sources

    spaced = ["Pr ot o c ol D S 8 2 0 1 -A -U 3 0 3 V ersi o n 5 . 0 Inc l u si o n Cri t eri a " * 40]
    normal = ["Inclusion Criteria: absolute neutrophil count of at least 1.5 x 10^9/L and hemoglobin of 9 g/dL " * 40]
    assert sources._letter_spaced(spaced) and not sources._letter_spaced(normal)
    monkeypatch.setattr(sources.shutil, "which", lambda name: None)  # the pypdf branch, stubbed below
    monkeypatch.setattr(sources, "_pdfminer_pages", lambda path: ["Protocol DS8201-A-U303"])

    class Reader:
        def __init__(self, path, text):
            self.pages = [type("P", (), {"extract_text": lambda self, t=text: t})()]

    import pypdf

    monkeypatch.setattr(pypdf, "PdfReader", lambda path: Reader(path, spaced[0]))
    assert sources.pdf_pages(tmp_path / "x.pdf") == ["Protocol DS8201-A-U303"]
    monkeypatch.setattr(pypdf, "PdfReader", lambda path: Reader(path, normal[0]))
    assert sources.pdf_pages(tmp_path / "x.pdf") == [normal[0]]
