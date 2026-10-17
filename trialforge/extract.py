"""Rule-based extraction of eligibility criteria and treatment regimens.

Extraction is deterministic on purpose: every extracted value carries the verbatim
source line and page so that it can be audited, and the evaluation suite measures
it against hand-verified gold labels. (An optional LLM pass can be added later; it
would have to agree with these anchors to be shown.)
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from . import druglib
from .sources import PdfDoc, fetch_protocol, fetch_study, protocol_documents

OP = r"(≥|>=|=>|>|≤|<=|=<|<)"
NUM = r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)"
ULN = r"(?:x|×|X|times)\s*(?:the\s+)?(?:institutional\s+)?(?:upper\s+limit\s+of\s+(?:the\s+)?normal|ULN)"
GAP = r"[^≥≤<>=\d\n]{0,70}?"

HEADING_INCL = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:Subject\s+|Patient\s+|Participant\s+|Key\s+)?Inclusion\s+Criteria\s*:?\s*$", re.I
)
HEADING_EXCL = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:Subject\s+|Patient\s+|Participant\s+|Key\s+)?Exclusion\s+Criteria\s*:?\s*$", re.I
)
NUMBERED_HEADING = re.compile(r"^\s*\d+(?:\.\d+)+\.?\s+[A-Z][A-Za-z ,/()-]{2,80}$")
END_WORDS = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s+)?(Trial Treatments?(\(s\))?|Study Treatments?|Study Drugs?|Premature Withdrawal.*|"
    r"Lifestyle (Restrictions|Considerations).*|Screen Failures?|Method of Treatment Assignment.*|"
    r"Treatment Assignment.*|Randomi[sz]ation.*|Withdrawal.*|Study Treatment Administration.*|"
    r"Concomitant (Medications?|Therapy).*|Investigational Medicinal Product.*)\s*$",
    re.I,
)
ITEM_START = re.compile(r"^\s{0,14}(\d{1,2})[.)]\s+\S")
PAGE_FURNITURE = re.compile(
    r"(CONFIDENTIAL|Clinical Study Protocol|Protocol/Amendment No|Product: MK|Page \d+ of \d+|Approved - \d|"
    r"Final Protocol|Regeneron Pharmaceuticals, Inc\.\s*$|^\s*\d{1,3}\s*$)",
    re.I,
)


@dataclass
class SourceRef:
    doc: str  # "protocol" | "registry"
    url: str
    page: int | None
    line: int | None
    text: str


@dataclass
class Criterion:
    id: str
    analyte: str
    category: str  # lab | performance_status | washout
    label: str
    section: str  # inclusion | exclusion
    operator: str | None
    value: float | None
    unit: str | None
    value_norm: float | None
    unit_norm: str | None
    conditions: list[dict] = field(default_factory=list)
    exceptions: list[str] = field(default_factory=list)
    source: SourceRef | None = None
    item_text: str = ""
    method: str = "rule-based"

    def to_dict(self):
        return asdict(self)


@dataclass
class Line:
    page: int | None
    line: int | None
    text: str
    section: str


LABELS = {
    "hemoglobin": "Hemoglobin",
    "anc": "Absolute neutrophil count",
    "platelets": "Platelet count",
    "bilirubin": "Total bilirubin",
    "ast_alt": "AST / ALT",
    "renal": "Renal function",
    "ecog": "ECOG performance status",
}


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _norm_op(op: str, section: str) -> str:
    op = {"=>": "≥", ">=": "≥", "=<": "≤", "<=": "≤"}.get(op, op)
    if section == "exclusion":  # "exclude if ANC <1.5" == "require ANC ≥1.5"
        op = {"<": "≥", "≤": ">", ">": "≤", "≥": "<"}[op]
    return op


# ------------------------------------------------------------- region finding

def _is_heading(raw: str) -> bool:
    s = raw.strip()
    return 0 < len(s) < 70 and not s.endswith((".", ",", ";", ":")) and s[0].isalnum() and (s[0].isupper() or s[0].isdigit())


def eligibility_lines(doc: PdfDoc) -> list[Line]:
    """Return lines of the eligibility section (inclusion + exclusion) with page/line anchors.

    Protocols often contain the heading more than once (synopsis "Key Inclusion Criteria" and the
    full section). Every occurrence is tried and the region containing the most lab/ECOG
    requirement lines wins; ties go to the later (full-section) occurrence.
    """
    starts = [(pno, lno) for pno, lno, raw in doc.page_lines() if HEADING_INCL.match(raw)]
    best, best_score = [], -1
    for sp, sl in starts:
        region = _region_from(doc, sp, sl)
        score = sum(1 for l in region if any(k.search(l.text) for k in LAB_KEYWORDS.values()) or ECOG_KW.search(l.text))
        if score >= best_score:
            best, best_score = region, score
    return best


def _region_from(doc: PdfDoc, start_page: int, start_line: int) -> list[Line]:
    out: list[Line] = []
    state = None
    for pno, lno, raw in doc.page_lines():
        if state is None:
            if pno == start_page and lno == start_line:
                state = "inclusion"
            continue
        if pno - start_page > 10:
            break
        if HEADING_EXCL.match(raw):
            state = "exclusion"
            continue
        if state == "exclusion" and _is_heading(raw) and (END_WORDS.match(raw) or (NUMBERED_HEADING.match(raw) and "riteria" not in raw)):
            break
        if not raw.strip() or PAGE_FURNITURE.search(raw):
            continue
        out.append(Line(pno, lno, raw, state))
    return out


LAB_ANCHOR = re.compile(
    r"laboratory\s+values\s+must|adequate\s+(?:organ|hematologic|haematologic|bone\s+marrow)|organ\s+function\s+as\s+(?:defined|indicated)",
    re.I,
)


def anchor_lines(doc: PdfDoc) -> list[Line]:
    """Fallback when no eligibility heading is extractable (e.g. image-only pages).

    Locates the lab-requirements block by anchor phrases and returns that page and the next
    one as inclusion lines. ECOG/washout extraction is not attempted from this region.
    """
    for pno, text in enumerate(doc.pages, start=1):
        if LAB_ANCHOR.search(text) and re.search(r"neutrophil|platelet|hemoglobin", text, re.I):
            out = []
            for p in (pno, pno + 1):
                if p > len(doc.pages):
                    break
                for lno, raw in enumerate(doc.pages[p - 1].splitlines(), start=1):
                    if raw.strip() and not PAGE_FURNITURE.search(raw):
                        out.append(Line(p, lno, raw, "inclusion"))
            return out
    return []


def registry_lines(study: dict) -> list[Line]:
    text = study["protocolSection"].get("eligibilityModule", {}).get("eligibilityCriteria", "")
    out, state = [], "inclusion"
    for i, raw in enumerate(text.splitlines(), start=1):
        if re.search(r"exclusion criteria", raw, re.I):
            state = "exclusion"
            continue
        if re.search(r"inclusion criteria", raw, re.I) or not raw.strip():
            continue
        out.append(Line(None, i, raw, state))
    return out


def group_items(lines: list[Line]) -> list[list[Line]]:
    items, cur = [], []
    for ln in lines:
        if ITEM_START.match(ln.text) and cur:
            items.append(cur)
            cur = []
        if cur and cur[0].section != ln.section:
            items.append(cur)
            cur = []
        cur.append(ln)
    if cur:
        items.append(cur)
    return items


def _join(lines: list[Line]) -> str:
    return re.sub(r"\s+", " ", " ".join(l.text.strip() for l in lines)).strip()


# ------------------------------------------------------------- lab parsing

UNIT_10_9 = r"(?:[x×]\s*10\s*(?:\^|\*\*)?\s*9\s*/\s*L|[x×]\s*109\s*/\s*L|[x×]\s*10E9\s*/\s*L|×\s*10⁹\s*/\s*L|10\^9/L|G/L)"
# "x 10^3/µL" is numerically identical to x10^9/L; PDFs often render it as "x 103/µL"
UNIT_10_3_UL = r"(?:[x×]\s*10\s*(?:\^)?\s*3\s*/\s*(?:mcL|[µμȣu]L|mm3|mm³))"
# PDF text extraction frequently drops or garbles the micro sign (µ -> ȣ or nothing)
UNIT_PER_UL = r"(?:cells\s*)?/\s*(?:mcL|[µμȣu]L|mm3|mm³|mm\^3|cu\.?\s*mm)"
UNIT_PER_UL_GLYPH_LOST = r"cells\s*/\s*L"

LAB_PATTERNS = {
    "hemoglobin": re.compile(
        rf"(?:hemoglobin|haemoglobin|\bHgb\b|\bHb\b){GAP}{OP}\s*{NUM}\s*(g/dL|g/dl|g/L|g/l)", re.I
    ),
    "anc": re.compile(
        rf"(?:absolute\s+neutrophil\s+count|\bANC\b|neutrophils?\b){GAP}{OP}\s*{NUM}\s*({UNIT_10_9}|{UNIT_10_3_UL}|{UNIT_PER_UL})", re.I
    ),
    "platelets": re.compile(
        rf"(?:platelets?(?:\s+count)?|\bPLT\b){GAP}{OP}\s*{NUM}\s*({UNIT_10_9}|{UNIT_10_3_UL}|{UNIT_PER_UL})", re.I
    ),
    "bilirubin": re.compile(rf"(?:total\s+bilirubin|serum\s+total\s+bilirubin|\bbilirubin\b){GAP}{OP}\s*{NUM}\s*{ULN}", re.I),
    "ast_alt": re.compile(
        rf"(?:\bAST\b|\bALT\b|SGOT|SGPT|aminotransferase|transaminase)[^≥≤<>=\n]{{0,90}}?{OP}\s*{NUM}\s*{ULN}", re.I
    ),
    "renal": re.compile(
        rf"(creatinine\s+clearance|\bCrCl\b|\bCLcr\b|glomerular\s+filtration\s+rate|\beGFR\b|\bGFR\b){GAP}{OP}\s*{NUM}\s*(mL/min(?:/1\.73\s*m2|/1\.73m2)?)",
        re.I,
    ),
}
LAB_KEYWORDS = {
    "hemoglobin": re.compile(r"hemoglobin|haemoglobin|\bHgb\b|\bHb\b", re.I),
    "anc": re.compile(r"absolute\s+neutrophil|\bANC\b|neutrophil", re.I),
    "platelets": re.compile(r"platelet|\bPLT\b", re.I),
    "bilirubin": re.compile(r"bilirubin", re.I),
    "ast_alt": re.compile(r"\bAST\b|\bALT\b|SGOT|SGPT|aminotransferase|transaminase", re.I),
    "renal": re.compile(r"creatinine\s+clearance|\bCrCl\b|\bCLcr\b|glomerular|\bGFR\b|\beGFR\b", re.I),
}
# Fallback when the comparison glyph (≥/≤) was lost in PDF text extraction, e.g. "ANC  1500 cells/L".
# Only used in the inclusion section, where the direction is implied by the list ("adequate organ
# function"); every such value is flagged operator_inferred so the UI and verifier can see it.
FALLBACK_PATTERNS = {
    "hemoglobin": (re.compile(rf"(?:hemoglobin|haemoglobin|\bHgb\b)\s{{2,}}{NUM}\s*(g/dL|g/L)\b", re.I), "≥"),
    "anc": (re.compile(rf"(?:\bANC\b|absolute\s+neutrophil\s+count)\s{{2,}}{NUM}\s*({UNIT_PER_UL_GLYPH_LOST}|{UNIT_PER_UL}|{UNIT_10_9})", re.I), "≥"),
    "platelets": (re.compile(rf"(?:platelet\s+count|platelets)\s{{2,}}{NUM}\s*({UNIT_PER_UL_GLYPH_LOST}|{UNIT_PER_UL}|{UNIT_10_9})", re.I), "≥"),
    "bilirubin": (re.compile(rf"(?:serum\s+|total\s+)?bilirubin\s{{2,}}{NUM}\s+(ULN|upper\s+limit\s+of\s+normal)", re.I), "≤"),
    "ast_alt": (re.compile(rf"(?:AST,?\s+(?:and\s+|or\s+)?ALT|ALT\s+and\s+AST)[^\d\n]{{0,40}}?\s{{2,}}{NUM}\s+(ULN|upper\s+limit\s+of\s+normal)", re.I), "≤"),
}
LIVER_COND = [
    re.compile(rf"{OP}\s*{NUM}\s*{ULN}[^.;\n]{{0,70}}?(?:liver|hepatic)\s+(?:metastas[ei]s|involvement)", re.I),
    re.compile(rf"(?:liver|hepatic)\s+(?:metastas[ei]s|involvement)\)?\s*[,:]?\s*{OP}\s*{NUM}\s*{ULN}", re.I),
]
EXCLUDE_LINE = re.compile(r"Hy[’'`]?s\s+law|dose[- ]limiting|DLT|grade\s*[≥>]?\s*\d|toxicit", re.I)


def _normalize(analyte: str, value: float, unit: str) -> tuple[float, str]:
    u = unit.replace(" ", "")
    if analyte == "hemoglobin":
        return (value / 10.0, "g/dL") if u.lower() == "g/l" else (value, "g/dL")
    if analyte in ("anc", "platelets"):
        if re.match(UNIT_10_3_UL, unit, re.I):
            return value, "×10⁹/L"
        if re.match(UNIT_PER_UL, unit, re.I) or re.match(UNIT_PER_UL_GLYPH_LOST, unit, re.I):
            return value / 1000.0, "×10⁹/L"
        return value, "×10⁹/L"
    if analyte in ("bilirubin", "ast_alt"):
        return value, "×ULN"
    if analyte == "renal":
        return value, "mL/min"
    return value, unit


def extract_labs(lines: list[Line], url: str, doc_kind: str) -> list[Criterion]:
    out: list[Criterion] = []
    seen: set[str] = set()
    items = group_items(lines)
    for item in items:
        item_text = _join(item)
        for idx, ln in enumerate(item):
            if EXCLUDE_LINE.search(ln.text):
                continue
            ctx_lines = item[idx : idx + 3]
            ctx = _join(ctx_lines)
            for analyte, pat in LAB_PATTERNS.items():
                if analyte in seen:
                    continue
                m = pat.search(ln.text) or (pat.search(ctx) if analyte in ("ast_alt", "bilirubin", "renal") else None)
                if not m:
                    continue
                # the analyte keyword must be on this line (avoid attributing a value to the line above)
                if not LAB_KEYWORDS[analyte].search(ln.text):
                    continue
                g = m.groups()
                if analyte == "renal":
                    measure, op, val, unit = g[0], g[1], g[2], g[3]
                else:
                    op, val = g[0], g[1]
                    unit = g[2] if len(g) > 2 and g[2] else "ULN"
                section = ln.section
                opn = _norm_op(op, section)
                value = _num(val)
                vnorm, unorm = _normalize(analyte, value, unit)
                crit = Criterion(
                    id=f"{analyte}",
                    analyte=analyte,
                    category="lab",
                    label=LABELS[analyte] if analyte != "renal" else f"Renal function ({measure.strip()})",
                    section=section,
                    operator=opn,
                    value=value,
                    unit=unit.strip(),
                    value_norm=vnorm,
                    unit_norm=unorm,
                    source=SourceRef(doc_kind, url, ln.page, ln.line, ln.text.strip()),
                    item_text=ctx,
                )
                if analyte in ("bilirubin", "ast_alt"):
                    for cp in LIVER_COND:
                        for cm in cp.finditer(ctx):
                            cv = _num(cm.group(2))
                            if cv != value:
                                crit.conditions.append(
                                    {"when": "liver metastases", "operator": _norm_op(cm.group(1), section), "value_norm": cv, "text": cm.group(0)}
                                )
                                break
                        if crit.conditions:
                            break
                    if re.search(r"Gilbert", ctx, re.I):
                        crit.exceptions.append("Gilbert's syndrome")
                    if analyte == "bilirubin" and re.search(r"direct\s+bilirubin", ctx, re.I):
                        crit.exceptions.append("direct bilirubin alternative")
                if analyte == "hemoglobin" and re.search(r"transfus", ctx, re.I):
                    crit.exceptions.append("transfusion-related qualifier present")
                out.append(crit)
                seen.add(analyte)
    # second pass: values whose comparison glyph was lost in text extraction
    for ln in lines:
        if ln.section != "inclusion" or EXCLUDE_LINE.search(ln.text):
            continue
        for analyte, (pat, implied_op) in FALLBACK_PATTERNS.items():
            if analyte in seen:
                continue
            m = pat.search(ln.text)
            if not m:
                continue
            value = _num(m.group(1))
            unit = m.group(2).strip()
            vnorm, unorm = _normalize(analyte, value, unit)
            out.append(
                Criterion(
                    id=analyte,
                    analyte=analyte,
                    category="lab",
                    label=LABELS[analyte],
                    section="inclusion",
                    operator=implied_op,
                    value=value,
                    unit=unit,
                    value_norm=vnorm,
                    unit_norm=unorm,
                    exceptions=["operator_inferred: comparison symbol missing from PDF text; direction implied by inclusion list"],
                    source=SourceRef(doc_kind, url, ln.page, ln.line, ln.text.strip()),
                    item_text=ln.text.strip(),
                    method="rule-based (glyph-loss fallback)",
                )
            )
            seen.add(analyte)
    return out


# ------------------------------------------------------------- performance status

ECOG_KW = re.compile(r"ECOG|Eastern\s+Cooperative\s+Oncology\s+Group|performance\s+status", re.I)


def extract_ecog(lines: list[Line], url: str, doc_kind: str) -> list[Criterion]:
    for item in group_items(lines):
        for idx, ln in enumerate(item):
            if not ECOG_KW.search(ln.text) or ln.section != "inclusion":
                continue
            ctx = _join(item[max(0, idx - 1) : idx + 2])
            if not re.search(r"ECOG|Eastern\s+Cooperative", ctx, re.I):
                continue
            mx = None
            m = re.search(r"(?:≤|<=|=<)\s*([0-4])\b", ctx) or re.search(r"<\s*([1-4])\b", ctx)
            if m:
                mx = int(m.group(1)) - (1 if m.group(0).strip().startswith("<") and "=" not in m.group(0) and "≤" not in m.group(0) else 0)
            m2 = re.search(r"\b([0-4])\s*(?:,\s*([0-4])\s*,?)?\s*(?:or|-|–|to|and)\s*([0-4])\b", ctx)
            if mx is None and m2:
                mx = int(m2.group(3))
            # single allowed value, e.g. "ECOG performance status of 0" / "ECOG PS 0"
            m3 = re.search(r"(?:performance\s+status|ECOG(?:\s+PS)?)(?:\s+score)?\s*(?:of|=|:)?\s*([0-2])\b(?!\s*(?:or|,|-|–|to|and)\s*[0-4])", ctx, re.I)
            if mx is None and m3:
                mx = int(m3.group(1))
            if mx is None:
                continue
            return [
                Criterion(
                    id="ecog",
                    analyte="ecog",
                    category="performance_status",
                    label=LABELS["ecog"],
                    section="inclusion",
                    operator="≤",
                    value=float(mx),
                    unit="ECOG",
                    value_norm=float(mx),
                    unit_norm="ECOG",
                    source=SourceRef(doc_kind, url, ln.page, ln.line, ln.text.strip()),
                    item_text=ctx,
                )
            ]
    return []


# ------------------------------------------------------------- washouts

WASHOUT_CATEGORIES = [
    ("washout_corticosteroid", "Corticosteroid washout", re.compile(r"corticosteroid|prednisone|steroid", re.I)),
    ("washout_investigational", "Investigational agent washout", re.compile(r"investigational\s+(?:agent|drug|product|device|therapy)|study\s+of\s+an\s+investigational", re.I)),
    ("washout_radiotherapy", "Radiotherapy washout", re.compile(r"radiotherapy|radiation\s+therapy|irradiat", re.I)),
    ("washout_surgery", "Major surgery washout", re.compile(r"major\s+surgery", re.I)),
    ("washout_vaccine", "Live vaccine washout", re.compile(r"live(?:[- ]virus)?\s+vaccin", re.I)),
    ("washout_immunomodulator", "Prior immunomodulator washout", re.compile(r"anti-?CTLA|immunomodulat|immune[- ]modulat", re.I)),
]
DURATION = re.compile(r"(\d+)\s*(day|week|month)s?\b", re.I)
TO_DAYS = {"day": 1, "week": 7, "month": 30}


CNS_CONTEXT = re.compile(r"brain\s+metast|CNS\s+metast|central\s+nervous\s+system|leptomening|spinal\s+cord", re.I)


def extract_washouts(lines: list[Line], url: str, doc_kind: str) -> list[Criterion]:
    """Time-based washouts stated as exclusion criteria.

    Inclusion-section intervals (e.g. "recurrence >6 months after adjuvant therapy") are disease
    history requirements, not washouts, and brain-metastasis stability windows are a different
    construct, so both are skipped.
    """
    out = []
    taken = set()
    for item in group_items([l for l in lines if l.section == "exclusion"]):
        text = _join(item)
        if CNS_CONTEXT.search(text):
            continue
        for cid, label, kw in WASHOUT_CATEGORIES:
            if cid in taken:
                continue
            km = kw.search(text)
            if not km:
                continue
            sent_start = text.rfind(". ", 0, km.start()) + 1
            sent_end = text.find(". ", km.end())
            sent = text[sent_start : (sent_end if sent_end != -1 else len(text))]
            # the duration must sit close to the keyword (same clause), not anywhere in the sentence
            k_rel = km.start() - sent_start
            cands = [d for d in DURATION.finditer(sent) if abs(d.start() - k_rel) <= 110]
            if not cands:
                continue
            dm = min(cands, key=lambda d: abs(d.start() - k_rel))
            days = int(dm.group(1)) * TO_DAYS[dm.group(2).lower()]
            # source line = first line in the item containing the duration string
            src = next((l for l in item if dm.group(0) in re.sub(r"\s+", " ", l.text)), item[0])
            crit = Criterion(
                id=cid,
                analyte=cid,
                category="washout",
                label=label,
                section=item[0].section,
                operator="≥",
                value=float(int(dm.group(1))),
                unit=dm.group(2).lower() + "s",
                value_norm=float(days),
                unit_norm="days",
                source=SourceRef(doc_kind, url, src.page, src.line, src.text.strip()),
                item_text=sent.strip(),
            )
            if re.search(r"half-?\s*li(?:ves|fe)", sent, re.I):
                crit.conditions.append({"when": "PK-based alternative", "text": "or a number of half-lives (whichever is longer)"})
            out.append(crit)
            taken.add(cid)
    return out


# ------------------------------------------------------------- regimen

DOSE_CONTEXT = re.compile(r"mg/m|AUC\s*\d|mg/kg|\bQ[1-4]W\b|every\s+[1-4]\s+weeks|\bIV\b|infusion|\d+\s*mg\b", re.I)


def extract_regimen(study: dict, doc: PdfDoc | None) -> dict:
    """Drugs used in any arm. Sources: registry interventions + protocol pages with dosing context."""
    ps = study["protocolSection"]
    am = ps.get("armsInterventionsModule", {})
    reg_text = " ".join(
        [i.get("name", "") + " " + " ".join(i.get("otherNames", []) or []) + " " + i.get("description", "") for i in am.get("interventions", [])]
        + [a.get("label", "") + " " + a.get("description", "") for a in am.get("armGroups", [])]
    )
    drugs: dict[str, dict] = {}
    for name in druglib.find_drugs(reg_text):
        drugs[name] = {"sources": ["registry interventions/arms"]}
    if doc:
        # Study-treatment sections follow the eligibility section in ICH E6-style protocols; background
        # sections (which discuss approved competitor regimens with doses) precede it. Only count dosing
        # context from the eligibility section onward, or from the synopsis "treatment" block.
        elig = eligibility_lines(doc)
        first_page = min((l.page for l in elig), default=1)
        counts: dict[str, int] = {}
        dose_pages: dict[str, list[int]] = {}
        for pno, page in enumerate(doc.pages, start=1):
            if pno < first_page:
                continue
            plines = page.splitlines()
            for name, hits in druglib.find_drugs(page).items():
                counts[name] = counts.get(name, 0) + len(hits)
                for j, ln in enumerate(plines):
                    # dose is often on the adjacent line of a table/list ("Carboplatin" / "AUC 5")
                    if druglib.find_drugs(ln).get(name) and DOSE_CONTEXT.search(" ".join(plines[max(0, j - 1) : j + 2])):
                        dose_pages.setdefault(name, []).append(pno)
                        break
        for name, n in counts.items():
            if n >= 5 and len(set(dose_pages.get(name, []))) >= 3:
                d = drugs.setdefault(name, {"sources": []})
                pages = sorted(set(dose_pages[name]))[:5]
                d["sources"].append(f"protocol: {n} mentions; dosing context on pp. {', '.join(map(str, pages))}")
    for name, d in drugs.items():
        drug = druglib.BY_NAME[name]
        d.update(
            {
                "class": drug.drug_class,
                "myelosuppressive": drug.myelosuppressive,
                "renal": drug.renal,
                "hepatic": drug.hepatic,
                "immunotherapy": drug.immunotherapy,
            }
        )
    arms = [
        {"label": a.get("label"), "type": a.get("type"), "interventions": a.get("interventionNames", [])}
        for a in am.get("armGroups", [])
    ]
    # Registry drug/biological interventions the curated table does not recognize. Their presence means
    # TrialLens must not conclude that "no arm contains a myelosuppressive (or hepatic, ...) agent".
    unrecognized = []
    for i in am.get("interventions", []):
        if i.get("type") not in ("DRUG", "BIOLOGICAL", "COMBINATION_PRODUCT"):
            continue
        text = i.get("name", "") + " " + " ".join(i.get("otherNames", []) or [])
        if druglib.find_drugs(text) or re.search(r"placebo|saline|vehicle|chemotherapy|standard of care|supplement|vitamin|folic", text, re.I):
            continue
        unrecognized.append(i.get("name", "").strip())
    return {"drugs": drugs, "arms": arms, "unrecognized": unrecognized}


# ------------------------------------------------------------- top level

def study_summary(study: dict) -> dict:
    ps = study["protocolSection"]
    st = ps["statusModule"]
    return {
        "nct_id": ps["identificationModule"]["nctId"],
        "title": ps["identificationModule"].get("briefTitle"),
        "official_title": ps["identificationModule"].get("officialTitle"),
        "acronym": ps["identificationModule"].get("acronym"),
        "sponsor": ps.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}).get("name"),
        "status": st.get("overallStatus"),
        "why_stopped": st.get("whyStopped"),
        "start_date": st.get("startDateStruct", {}).get("date"),
        "primary_completion": st.get("primaryCompletionDateStruct", {}).get("date"),
        "phases": ps.get("designModule", {}).get("phases", []),
        "enrollment": ps.get("designModule", {}).get("enrollmentInfo", {}),
        "conditions": ps.get("conditionsModule", {}).get("conditions", []),
        "registry_url": f"https://clinicaltrials.gov/study/{ps['identificationModule']['nctId']}",
        "protocol_docs": protocol_documents(study),
    }


def analyze_trial(nct_id: str, doc_override: PdfDoc | None = None) -> dict:
    """doc_override lets the evaluation run the identical pipeline on a modified protocol text."""
    study = fetch_study(nct_id)
    summary = study_summary(study)
    doc = doc_override
    if doc is None:
        try:
            doc = fetch_protocol(nct_id)
        except Exception as e:  # network or non-PDF; fall back to registry text
            summary["protocol_error"] = str(e)
    criteria: list[Criterion] = []
    if doc:
        lines = eligibility_lines(doc)
        summary["region_method"] = "section headings"
        if lines:
            criteria = extract_labs(lines, doc.url, "protocol") + extract_ecog(lines, doc.url, "protocol") + extract_washouts(lines, doc.url, "protocol")
        else:
            lines = anchor_lines(doc)
            summary["region_method"] = "lab-block anchor (eligibility headings not extractable from PDF text)"
            criteria = extract_labs(lines, doc.url, "protocol")
        summary["eligibility_pages"] = sorted({l.page for l in lines})
        summary["criteria_source"] = "protocol PDF"
        # supplement criteria the PDF region did not yield from the registry text
        have = {c.id for c in criteria}
        reg = registry_lines(study)
        for c in extract_ecog(reg, summary["registry_url"], "registry") + extract_washouts(reg, summary["registry_url"], "registry"):
            if c.id not in have:
                criteria.append(c)
    if not doc or not criteria:
        lines = registry_lines(study)
        criteria = extract_labs(lines, summary["registry_url"], "registry") + extract_ecog(lines, summary["registry_url"], "registry") + extract_washouts(lines, summary["registry_url"], "registry")
        summary["criteria_source"] = "registry eligibility text (no protocol PDF available)" if not doc else "registry eligibility text (protocol section not parsed)"
    regimen = extract_regimen(study, doc)
    return {"study": summary, "criteria": [c.to_dict() for c in criteria], "regimen": regimen, "_doc": doc}


if __name__ == "__main__":
    import sys

    for n in sys.argv[1:]:
        r = analyze_trial(n)
        s = r["study"]
        print(f"\n=== {n} {s['title'][:60]} | {s['criteria_source']} | pages {s.get('eligibility_pages')}")
        print("  regimen:", {k: v["class"] for k, v in r["regimen"]["drugs"].items()})
        for c in r["criteria"]:
            cond = "; ".join(f"{x['when']}: {x.get('operator','')}{x.get('value_norm','')}" for x in c["conditions"])
            print(f"  [{c['section'][:4]}] {c['id']:24s} {c['operator']}{c['value_norm']} {c['unit_norm']:8s} p{c['source']['page']} | {c['source']['text'][:70]} {('| ' + cond) if cond else ''}")
