"""Fetch and cache primary source documents.

Everything TrialForge reasons over comes from here: ClinicalTrials.gov registry
records, protocol PDFs posted to ClinicalTrials.gov, the FDA July 2026 eligibility
guidances, and NHANES public-use files. Documents are cached under data/ so a demo
never depends on network latency, but the cache is only ever filled from the
official URLs below.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import httpx

from .settings import env

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
# What visitors create (reviews and drafts made on request, decisions, the audit log) goes under
# PROTOCOLOS_STATE_DIR when it is set, a volume that survives redeploys; the image's own caches stay under data/.
STATE = Path(env("STATE_DIR")) if env("STATE_DIR") else DATA
REGISTRY_DIR = DATA / "registry"
PROTOCOL_DIR = DATA / "protocols"
FDA_DIR = DATA / "fda"
NHANES_DIR = DATA / "nhanes"

CTGOV_API = "https://clinicaltrials.gov/api/v2/studies"
UA = {"User-Agent": "TrialForge/0.1 (HackHarvard 2026 research prototype)"}

FDA_GUIDANCES = {
    "lab": {
        "title": "Cancer Clinical Trial Eligibility Criteria: Laboratory Values",
        "date": "July 2026",
        "issued": "2026-07",
        "url": "https://www.fda.gov/media/178013/download",
    },
    "ps": {
        "title": "Cancer Clinical Trial Eligibility Criteria: Performance Status",
        "date": "July 2026",
        "issued": "2026-07",
        "url": "https://www.fda.gov/media/178018/download",
    },
    "washout": {
        "title": "Cancer Clinical Trial Eligibility Criteria: Washout Periods and Concomitant Medications",
        "date": "July 2026",
        "issued": "2026-07",
        "url": "https://www.fda.gov/media/178016/download",
    },
    "enrichment": {
        "title": "Enrichment Strategies for Clinical Trials to Support Determination of Effectiveness of Human Drugs and Biological Products",
        "date": "March 2019",
        "issued": "2019-03",
        "url": "https://www.fda.gov/media/121320/download",
    },
}

NHANES_BASE = "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/2017/DataFiles"
NHANES_FILES = ["DEMO_J", "CBC_J"]


@dataclass
class PdfDoc:
    """A PDF with per-page text. Page numbers are 1-based PDF page indices."""

    source_id: str
    url: str
    path: Path
    pages: list[str]

    def page_lines(self):
        for pno, text in enumerate(self.pages, start=1):
            for lno, line in enumerate(text.splitlines(), start=1):
                yield pno, lno, line

    @property
    def full_text(self) -> str:
        return "\n".join(self.pages)


def _get(url: str, timeout: float = 90.0) -> bytes:
    with httpx.Client(headers=UA, follow_redirects=True, timeout=timeout) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.content


# Word-generated PDFs that use the Adobe Symbol font expose its glyphs as Unicode private-use
# codepoints (U+F000 + Symbol code). Decoding them is a fixed table lookup, not a guess.
SYMBOL_FONT = {
    "": "≥", "": "≤", "": "×", "": "µ", "": ">", "": "<",
    "": "±", "": "≈", "": "°", "": "-", "": "·", "": "•", "": "•",
}
_SYMBOL_RE = None


def decode_symbol_font(text: str) -> str:
    global _SYMBOL_RE
    if _SYMBOL_RE is None:
        import re

        _SYMBOL_RE = re.compile("|".join(map(re.escape, SYMBOL_FONT)))
    return _SYMBOL_RE.sub(lambda m: SYMBOL_FONT[m.group(0)], text)


def _letter_spaced(pages: list[str]) -> bool:
    """True for an OCR text layer that pdftotext and pypdf split into letters ("Pr ot o c ol D S 8 2 0 1"): most
    tokens are one or two letters long (about 0.9 of them in such protocols, at most 0.32 in the others cached)."""
    tokens = re.findall(r"[A-Za-z]+", "\n".join(pages))
    return len(tokens) > 200 and sum(len(t) <= 2 for t in tokens) / len(tokens) > 0.6


def _pdfminer_pages(path: Path) -> list[str]:
    """Per-page text with pdfminer's character-gap word joining; a wide word margin rejoins the split letters."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams, LTTextContainer

    return ["".join(el.get_text() for el in page if isinstance(el, LTTextContainer))
            for page in extract_pages(str(path), laparams=LAParams(word_margin=1.0, char_margin=2.0))]


def pdf_pages(path: Path) -> list[str]:
    """Extract text per page. Prefer poppler's pdftotext (layout-preserving); letter-spaced OCR text goes to pdfminer."""
    if shutil.which("pdftotext"):
        out = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, check=True
        ).stdout
        pages = out.split("\f")
        if pages and not pages[-1].strip():
            pages = pages[:-1]
    else:
        from pypdf import PdfReader

        pages = [p.extract_text() or "" for p in PdfReader(str(path)).pages]
    if _letter_spaced(pages):
        pages = _pdfminer_pages(path)
    return [decode_symbol_font(p) for p in pages]


def _cached_pdf(source_id: str, url: str, path: Path, refresh: bool = False) -> PdfDoc:
    txt_path = path.with_suffix(".pages.json")
    # The engine reads only the page text, so a deploy may ship the .pages.json without the PDF (docs/DEPLOY.md).
    if not refresh and txt_path.exists():
        return PdfDoc(source_id, url, path, json.loads(txt_path.read_text()))
    path.parent.mkdir(parents=True, exist_ok=True)
    if refresh or not path.exists():
        content = _get(url)
        if not content.startswith(b"%PDF"):
            raise ValueError(f"{url} did not return a PDF")
        path.write_bytes(content)
    txt_path.write_text(json.dumps(pdf_pages(path)))
    return PdfDoc(source_id, url, path, json.loads(txt_path.read_text()))


# ---------------------------------------------------------------- registry

def fetch_study(nct_id: str, refresh: bool = False) -> dict:
    nct_id = nct_id.strip().upper()
    path = REGISTRY_DIR / f"{nct_id}.json"
    if refresh or not path.exists():
        REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
        data = json.loads(_get(f"{CTGOV_API}/{nct_id}"))
        path.write_text(json.dumps(data))
    return json.loads(path.read_text())


def search_studies(params: dict, max_results: int = 200) -> list[dict]:
    """Thin wrapper over the v2 search endpoint (not cached; used for comparator discovery)."""
    out, token = [], None
    with httpx.Client(headers=UA, timeout=60) as c:
        while len(out) < max_results:
            p = dict(params, pageSize=min(100, max_results - len(out)))
            if token:
                p["pageToken"] = token
            r = c.get(CTGOV_API, params=p)
            r.raise_for_status()
            j = r.json()
            out += j.get("studies", [])
            token = j.get("nextPageToken")
            if not token:
                break
    return out


def protocol_documents(study: dict) -> list[dict]:
    nct = study["protocolSection"]["identificationModule"]["nctId"]
    docs = study.get("documentSection", {}).get("largeDocumentModule", {}).get("largeDocs", [])
    result = []
    for d in docs:
        if d.get("hasProtocol"):
            result.append(
                {
                    "filename": d["filename"],
                    "type": d.get("typeAbbrev"),
                    "date": d.get("date"),
                    "url": f"https://cdn.clinicaltrials.gov/large-docs/{nct[-2:]}/{nct}/{d['filename']}",
                }
            )
    return result


def fetch_protocol(nct_id: str, refresh: bool = False) -> PdfDoc | None:
    study = fetch_study(nct_id)
    docs = protocol_documents(study)
    if not docs:
        return None
    d = docs[0]
    return _cached_pdf(
        f"protocol:{nct_id}", d["url"], PROTOCOL_DIR / f"{nct_id}__{d['filename']}", refresh
    )


def protocol_cached(nct_id: str) -> bool:
    """True when fetch_protocol(nct_id) would read only the cache (registry record and page text on disk)."""
    nct_id = nct_id.strip().upper()
    path = REGISTRY_DIR / f"{nct_id}.json"
    if not path.exists():
        return False
    docs = protocol_documents(json.loads(path.read_text()))
    return bool(docs) and (PROTOCOL_DIR / f"{nct_id}__{docs[0]['filename']}").with_suffix(".pages.json").exists()


# ---------------------------------------------------------------- FDA

def fetch_guidance(key: str, refresh: bool = False) -> PdfDoc:
    g = FDA_GUIDANCES[key]
    return _cached_pdf(f"fda:{key}", g["url"], FDA_DIR / f"fda_{key}.pdf", refresh)


# ---------------------------------------------------------------- NHANES

def fetch_nhanes(refresh: bool = False) -> dict[str, Path]:
    NHANES_DIR.mkdir(parents=True, exist_ok=True)
    paths = {}
    for f in NHANES_FILES:
        p = NHANES_DIR / f"{f}.xpt"
        if refresh or not p.exists():
            p.write_bytes(_get(f"{NHANES_BASE}/{f}.xpt"))
        paths[f] = p
    return paths


if __name__ == "__main__":
    import sys

    ids = sys.argv[1:] or ["NCT03409614", "NCT03088540", "NCT02578680"]
    for n in ids:
        s = fetch_study(n)
        doc = fetch_protocol(n)
        title = s["protocolSection"]["identificationModule"]["briefTitle"]
        print(n, title[:70], "| protocol pages:", len(doc.pages) if doc else None)
    for k in FDA_GUIDANCES:
        print(k, len(fetch_guidance(k).pages), "pages")
    print({k: v.stat().st_size for k, v in fetch_nhanes().items()})
