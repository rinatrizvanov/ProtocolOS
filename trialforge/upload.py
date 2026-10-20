"""Your own protocol against a draft's precedents (the draft page's "Compare with your protocol").

The uploaded PDF goes through the extractor used for ClinicalTrials.gov protocols (extract.protocol_criteria); each
criterion found is scored by the unchanged review engine (review.review_criterion) against the draft's precedents,
with the draft idea's regimen. The file exists only in a temporary directory while its text is read; the extracted
criteria and their review are kept under the visitor's session (STATE/uploads/<session>/), so only that browser can
open them again. The public demo asks for protocols that are already public.
"""
from __future__ import annotations

import json
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path

from . import comparators, draft, review
from .extract import protocol_criteria
from .sources import STATE, PdfDoc, pdf_pages

UPLOADS = STATE / "uploads"
MAX_BYTES = 25 * 1024 * 1024
MAX_PER_SESSION = 20
UPLOAD_ID_RE = re.compile(r"u-[0-9a-f]{12}")
PRECEDENT_BUDGET_S = 120.0


class UploadError(ValueError):
    """The upload cannot be reviewed; the message is shown to the visitor."""


def read_pdf(data: bytes, name: str) -> PdfDoc:
    """Per-page text of an uploaded PDF; the file is deleted before this returns."""
    from pypdf.errors import PdfReadError

    if not data.startswith(b"%PDF"):
        raise UploadError("The file is not a PDF.")
    with tempfile.TemporaryDirectory(prefix="protocolos-upload-") as tmp:
        path = Path(tmp) / "protocol.pdf"
        path.write_bytes(data)
        try:
            pages = pdf_pages(path)
        except (subprocess.CalledProcessError, PdfReadError, ValueError) as e:
            raise UploadError(f"The PDF could not be read ({type(e).__name__}).") from e
    if not any(p.strip() for p in pages):
        raise UploadError("The PDF has no text layer (a scan without OCR); its criteria cannot be read.")
    return PdfDoc(f"upload:{name}", "", path, pages)


def review_protocol(doc: PdfDoc, name: str, d: dict) -> dict:
    """Score each criterion of the uploaded protocol against the precedents of draft `d`."""
    t0 = time.monotonic()
    criteria, lines, method = protocol_criteria(doc)
    if not criteria:
        raise UploadError("No eligibility criterion the extractor covers (lab limits, ECOG, washouts) was found in the PDF.")
    precedents, _, _ = draft._load_precedents([p["nct_id"] for p in d["precedents"]], PRECEDENT_BUDGET_S, t0)
    if not precedents:
        raise UploadError("The draft's precedents could not be read on this server; draft the idea again.")
    idea = d["idea"]
    elig_pages = sorted({ln.page for ln in lines})
    target = {"study": {"nct_id": "UPLOAD", "title": name, "acronym": None, "start_date": idea.get("as_of"),
                        "eligibility_pages": elig_pages},
              "criteria": [c.to_dict() for c in criteria],
              "regimen": {"drugs": draft._regimen(idea["recognized_drugs"]), "arms": [], "unrecognized": idea["unrecognized_drugs"]},
              "tags": set(idea.get("setting") or [])}
    table = comparators.compare(target, precedents)
    reviews = []
    for c in target["criteria"]:
        item = review.review_criterion(c, target, table[c["id"]], doc, set(elig_pages))
        reviews.append({"criterion": c, "classification": item["classification"], "explanation": item["explanation"],
                        "suggested_action": item["suggested_action"], "scores": item["scores"]})
    return {"draft_id": d["draft_id"], "file_name": name, "pages": len(doc.pages), "region_method": method,
            "precedents": [p["study"]["nct_id"] for p in precedents], "target": {"study": target["study"]},
            "reviews": reviews, "computed_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def _folder(session: str) -> Path:
    return UPLOADS / session


def save(session: str, result: dict) -> dict:
    folder = _folder(session)
    if folder.exists() and sum(1 for _ in folder.glob("u-*.json")) >= MAX_PER_SESSION:
        raise UploadError(f"This browser has reached {MAX_PER_SESSION} uploaded protocols on the demo server.")
    folder.mkdir(parents=True, exist_ok=True)
    result = {**result, "upload_id": f"u-{secrets.token_hex(6)}"}
    (folder / f"{result['upload_id']}.json").write_text(json.dumps(result, default=sorted))
    return result


def load(session: str, upload_id: str) -> dict | None:
    if not UPLOAD_ID_RE.fullmatch(upload_id):
        return None
    p = _folder(session) / f"{upload_id}.json"
    return json.loads(p.read_text()) if p.exists() else None
