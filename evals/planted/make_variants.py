"""Generate planted-issue variants of authentic, previously unseen protocols.

SYNTHETIC MODIFICATIONS TO AUTHENTIC PROTOCOLS. Each variant changes exactly one eligibility
threshold on the protocol's own source line (e.g. "Hemoglobin ≥ 9.0 g/dL" -> "Hemoglobin ≥ 11.0 g/dL").
The unmodified protocol is kept as a control.

Outputs (written separately on purpose):
  evals/planted/variants.json    - what to change (base NCT, page, original line, modified line)
  evals/planted/answer_key.json  - what a reviewer should expect (escalate for evidence review or not)

A planted stricter criterion is NOT assumed to be clinically wrong. The expected behaviour is that the
system notices the change and escalates it for evidence review; it is never expected to call it unsafe.

    .venv/bin/python -m evals.planted.make_variants
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from trialforge.extract import analyze_trial
from trialforge.sources import fetch_protocol

HERE = Path(__file__).resolve().parent

# Previously unseen protocols (never used for development, gold labels or tuning). Base values for the
# planted analytes were checked by reading the raw source lines (see README / eval notes).
BASES = {
    "NCT02657434": "IMpower132 (NSCLC)",
    "NCT03164616": "POSEIDON (NSCLC)",
    "NCT02358031": "KEYNOTE-048 (head and neck)",
    "NCT02763579": "IMpower133 (SCLC)",
    "NCT02853331": "KEYNOTE-426 (renal)",
}
# analytes whose base value was verified correct by reading the protocol (KEYNOTE-048 liver rows and
# KEYNOTE-426 ECOG are excluded: the former was mis-extracted, the latter uses Karnofsky, not ECOG)
VERIFIED = {
    "NCT02657434": {"hemoglobin", "anc", "platelets", "ast_alt", "ecog"},
    "NCT03164616": {"hemoglobin", "anc", "platelets", "ast_alt", "ecog"},
    "NCT02358031": {"hemoglobin", "anc", "platelets", "ecog"},
    "NCT02763579": {"hemoglobin", "anc", "platelets", "ast_alt", "ecog"},
    "NCT02853331": {"hemoglobin", "anc", "platelets", "ast_alt", "washout_investigational"},
}
# planted values in normalized units
STRICTER = {"hemoglobin": 11.0, "anc": 2.0, "platelets": 150.0, "ast_alt": 1.5, "ecog": 0.0, "washout_investigational": "double"}
LOOSER = {"hemoglobin": 8.0, "platelets": 75.0}

NUM = r"\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?"


def _fmt_like(token: str, value: float) -> str:
    if "," in token:
        return f"{int(round(value)):,}"
    if "." in token:
        return f"{value:.{len(token.split('.')[1])}f}"
    return str(int(round(value))) if float(value).is_integer() else str(value)


def _swap_numbers(line: str, crit: dict, new_norm: float) -> str:
    """Replace every representation of the old value on the line (raw unit and normalized unit)."""
    old_raw, old_norm = crit["value"], crit["value_norm"]
    factor = (old_raw / old_norm) if old_norm else 1.0  # e.g. 1000 for /µL, 10 for g/L
    new_raw = new_norm * factor

    def repl(m):
        tok = m.group(0)
        v = float(tok.replace(",", ""))
        if abs(v - old_raw) < 1e-9:
            return _fmt_like(tok, new_raw)
        if abs(v - old_norm) < 1e-9:
            return _fmt_like(tok, new_norm)
        if crit["analyte"] == "hemoglobin" and abs(v - old_norm * 10) < 1e-9:  # "(90 g/L)"
            return _fmt_like(tok, new_norm * 10)
        return tok

    # do not touch "109/L" (10^9 rendered without superscript) or "103/µL"
    return re.sub(rf"(?<![\d.])(?:{NUM})(?!\d)", lambda m: m.group(0) if m.group(0) in ("109", "103") else repl(m), line)


def _plant(doc, crit: dict, new_norm) -> dict | None:
    page = crit["source"]["page"]
    lines = doc.pages[page - 1].splitlines()
    idx = next((i for i, l in enumerate(lines) if l.strip() == crit["source"]["text"]), None)
    if idx is None:
        return None
    if crit["analyte"] == "ecog":
        # "0 or 1", "≤1", "0-1" -> "0" on the source line or the next line
        for j in (idx, idx + 1):
            new = re.sub(r"0\s*(?:or|-|–|to)\s*1|≤\s*1\b", "0", lines[j])
            if new != lines[j]:
                return {"page": page, "line_index": j, "original": lines[j], "modified": new}
        return None
    new = _swap_numbers(lines[idx], crit, new_norm)
    if new == lines[idx]:
        return None
    return {"page": page, "line_index": idx, "original": lines[idx], "modified": new}


def main():
    variants, key = [], {}
    for nct, name in BASES.items():
        a = analyze_trial(nct)
        doc = fetch_protocol(nct)
        crits = {c["id"]: c for c in a["criteria"] if c["source"]["doc"] == "protocol"}
        vid = f"{nct}__control"
        variants.append({"id": vid, "base": nct, "name": name, "substitutions": []})
        key[vid] = {"kind": "control", "base": nct, "expected": "no planted change"}
        for kind, table in (("stricter", STRICTER), ("looser", LOOSER)):
            for analyte, target in table.items():
                if analyte not in VERIFIED[nct] or analyte not in crits:
                    continue
                c = crits[analyte]
                new_norm = c["value_norm"] * 2 if target == "double" else target
                sub = _plant(doc, c, new_norm)
                vid = f"{nct}__{kind}__{analyte}"
                if not sub:
                    print("could not plant", vid)
                    continue
                variants.append({"id": vid, "base": nct, "name": name, "substitutions": [sub]})
                key[vid] = {
                    "kind": kind, "base": nct, "analyte": analyte,
                    "original_value": c["value_norm"], "planted_value": new_norm, "unit": c["unit_norm"],
                    "expected": "escalate for evidence review" if kind == "stricter" else "no over-restriction flag caused by the change",
                }
    (HERE / "variants.json").write_text(json.dumps(variants, indent=1, ensure_ascii=False))
    (HERE / "answer_key.json").write_text(json.dumps({"_about": "Expected reviewer-facing behaviour per variant. Stricter plants should be escalated for evidence review (not declared unsafe); looser plants should not be flagged as over-restrictive because of the change. Synthetic modifications of authentic protocols.", "variants": key}, indent=1, ensure_ascii=False))
    print(f"{len(variants)} variants ({sum(1 for v in key.values() if v['kind']=='stricter')} stricter, {sum(1 for v in key.values() if v['kind']=='looser')} looser, {sum(1 for v in key.values() if v['kind']=='control')} controls)")
    for v in variants:
        for s in v["substitutions"]:
            print(f"  {v['id']:45s} p{s['page']}: {s['original'].strip()[:55]!r} -> {s['modified'].strip()[:55]!r}")


if __name__ == "__main__":
    main()
