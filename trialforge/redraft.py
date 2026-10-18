"""Redraft workspace: check a reviewer's rewritten criterion against the review, deterministically.

The edited sentence goes through the same rule-based extractor that reads protocols (`extract.py`), then is
compared with the protocol as written, the comparable trials, the regimen's toxicity link, FDA guidance and
NHANES. A changed value goes through the unchanged verifier. No model call; document text is data.
"""
from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache

from . import nhanes
from .comparators import HIGHER_IS_STRICTER, LOWER_IS_STRICTER
from .extract import LABELS, Line, extract_ecog, extract_labs, extract_washouts
from .verifier import NECESSITY, OVERCLAIM, verify

LEVELS = ("fail", "warn", "info", "pass")
RELATION = {"same": "same as draft", "comparator stricter": "stricter than draft", "comparator looser": "more permissive than draft"}
GE, LE = {"≥", ">"}, {"≤", "<"}


def _dir(analyte: str, base: float, other: float, base_op: str = "", other_op: str = "") -> str:
    """Strict direction of `other` relative to `base`: no tolerance, so a precedent is 'same' only at the exact value and
    operator (comparators.direction treats washouts within 10% as the same, which would invent precedents here)."""
    if base == other:
        if base_op == other_op or not base_op or not other_op:
            return "same"
        inclusive = {"≥", "≤"}
        return "comparator stricter" if other_op not in inclusive and base_op in inclusive else "comparator looser"
    if analyte in HIGHER_IS_STRICTER or analyte.startswith("washout"):
        return "comparator looser" if other < base else "comparator stricter"
    if analyte in LOWER_IS_STRICTER:
        return "comparator looser" if other > base else "comparator stricter"
    return "different"


def _cond_key(c) -> tuple:
    return (c.get("when"), c.get("operator"), c.get("value_norm")) if isinstance(c, dict) else (str(c),)


def _cond_text(c) -> str:
    return str(c.get("text") or c.get("when") or c) if isinstance(c, dict) else str(c)


def _fmt(v) -> str:
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


def _limit(c: dict) -> str:
    unit = "" if c["unit_norm"] and c["unit_norm"].lower() in c["label"].lower() else f" {c['unit_norm']}"
    return f"{c['operator']}{_fmt(c['value_norm'])}{unit}"


def parse(text: str, section: str) -> list[dict]:
    """Every lab, ECOG and washout criterion the protocol extractor finds in `text`."""
    lines = [Line(None, i, raw, section) for i, raw in enumerate(text.splitlines() or [text], start=1) if raw.strip()]
    found: list[dict] = []
    for fn in (extract_labs, extract_ecog, extract_washouts):
        found += [asdict(c) for c in fn(lines, None, "redraft")]
    return found


@lru_cache(maxsize=256)
def _below(analyte: str, value: float) -> dict:
    return nhanes.below_threshold(analyte, value)


def _flag(level: str, code: str, message: str, source: dict | None = None) -> dict:
    return {"level": level, "code": code, "message": message, "source": source}


def analyze(review: dict, criterion_id: str, text: str, rationale: str = "", resolvers: dict | None = None) -> dict:
    crit = next((c for c in review["target"]["criteria"] if c["id"] == criterion_id), None)
    if crit is None:
        raise KeyError(criterion_id)
    item = next((rv for rv in review["reviews"] if rv["criterion"]["id"] == criterion_id), {})
    src = crit.get("source") or {}
    conds = list(crit.get("conditions") or [])
    original = {"text": src.get("text") or crit.get("item_text") or "", "operator": crit["operator"], "value": crit["value_norm"],
                "unit": crit["unit_norm"], "page": src.get("page"), "url": src.get("url"), "conditions": [_cond_text(c) for c in conds]}
    flags: list[dict] = []
    found = parse(text, crit["section"])
    p = next((c for c in found if c["id"] == criterion_id), None)
    parsed, precedents, verification, population = None, None, None, None
    changed = {"operator": False, "value": False, "unit": False, "conditions_dropped": []}
    analyte = crit["analyte"]

    others = sorted({c["label"] for c in found if c["id"] != criterion_id})
    if p is None:
        flags.append(_flag("fail", "unparsed",
                           (f"This text reads as a {', '.join(others)} limit, not {crit['label']}." if others else
                            f"No {crit['label']} limit found. Write it with an operator, a number and a unit, as in "
                            f"'{crit['label']} {_limit(crit)}'.")))
    elif crit["value_norm"] is None:
        parsed = {"operator": p["operator"], "value": p["value_norm"], "unit": p["unit_norm"],
                  "conditions": [_cond_text(c) for c in p.get("conditions") or []], "text": f"{p['label']} {_limit(p)}"}
        flags.append(_flag("info", "protocol_limit_unreadable", "The protocol's own limit is not machine-readable, so the draft "
                                                               "cannot be compared with it."))
    else:
        pconds = list(p.get("conditions") or [])
        parsed = {"operator": p["operator"], "value": p["value_norm"], "unit": p["unit_norm"],
                  "conditions": [_cond_text(c) for c in pconds], "text": f"{p['label']} {_limit(p)}"}
        keys = {_cond_key(c) for c in pconds}
        changed = {"operator": p["operator"] != crit["operator"], "value": p["value_norm"] != crit["value_norm"],
                   "unit": p["unit_norm"] != crit["unit_norm"],
                   "conditions_dropped": [_cond_text(c) for c in conds if _cond_key(c) not in keys]}
        reversed_ = (crit["operator"] in GE and p["operator"] in LE) or (crit["operator"] in LE and p["operator"] in GE)
        if others:
            flags.append(_flag("info", "other_criteria_ignored", f"Only {crit['label']} is checked here; the draft also states "
                                                                 f"{', '.join(others)}."))
        for c in changed["conditions_dropped"]:
            flags.append(_flag("warn", "condition_dropped", f"The protocol's condition is not recognized in the draft: {c}."))
        if reversed_:
            flags.append(_flag("fail", "operator_reversed", f"The draft reverses the limit ({crit['operator']} in the protocol, "
                                                            f"{p['operator']} in the draft): it would admit the patients the protocol "
                                                            "excludes. Precedent, verifier and population checks are skipped."))
        elif changed["operator"]:
            flags.append(_flag("warn", "operator_changed", f"The boundary changed from {crit['operator']} to {p['operator']}: "
                                                           "check whether the limit value itself is meant to qualify."))
        if changed["unit"]:
            flags.append(_flag("warn", "unit_changed", f"The unit changed from {crit['unit_norm']} to {p['unit_norm']}; "
                                                       "comparisons below use the draft's unit."))
        relax = _dir(analyte, crit["value_norm"], p["value_norm"], crit["operator"], p["operator"]) == "comparator looser"
        if not reversed_ and (changed["value"] or changed["operator"]) and not changed["unit"]:
            how = "more permissive than" if relax else "stricter than"
            flags.append(_flag("info", "value_changed", f"The draft limit {_limit(p)} is {how} the protocol's {_limit(crit)}."))
        elif not any((changed["value"], changed["operator"], changed["unit"])):
            flags.append(_flag("pass", "unchanged", f"The limit matches the protocol as written ({_limit(crit)})."))

        if not reversed_:
            rows = []
            for row in review["comparison"].get(criterion_id, []):
                cc = row.get("criterion")
                if (not cc or row.get("direction") == "different measure" or cc.get("unit_norm") != p["unit_norm"]
                        or cc.get("value_norm") is None or cc.get("operator") not in (GE if p["operator"] in GE else LE)):
                    continue
                rel = RELATION.get(_dir(analyte, p["value_norm"], cc["value_norm"], p["operator"], cc["operator"]), "different")
                rows.append({"nct_id": row["nct_id"], "acronym": row.get("acronym"), "value": cc["value_norm"], "unit": cc["unit_norm"],
                             "operator": cc["operator"], "relation": rel, "page": (cc.get("source") or {}).get("page"),
                             "url": (cc.get("source") or {}).get("url")})
            same = [r for r in rows if r["relation"] == "same as draft"]
            precedents = {"total": len(rows), "same": len(same), "stricter": sum(r["relation"] == "stricter than draft" for r in rows),
                          "looser": sum(r["relation"] == "more permissive than draft" for r in rows),
                          "values": [{k: r[k] for k in ("nct_id", "acronym", "value", "unit", "relation")} for r in rows]}
            names = ", ".join(r["acronym"] or r["nct_id"] for r in same)
            if not rows:
                flags.append(_flag("warn", "no_precedent_at_value", "No comparable trial states a directly comparable limit for this "
                                                                    "criterion: Insufficient evidence for any specific value."))
            elif same:
                msg = f"{len(same)} of {len(rows)} comparable trials used {_limit(p)} ({names})."
                if len(same) == len(rows) and len(rows) > 1:
                    msg += " Agreement may reflect template carry-forward."
                first = same[0]
                flags.append(_flag("info" if relax else "pass", "precedent_at_value", msg,
                                   {"label": first["acronym"] or first["nct_id"], "url": first["url"], "page": first["page"]}))
                if relax:
                    flags.append(_flag("info", "permissive_precedent", "A more permissive precedent shows a limit was used, not that it was safe."))
            else:
                flags.append(_flag("warn", "no_precedent_at_value",
                                   f"No comparable trial used {_limit(p)}: {precedents['stricter']} used a stricter and "
                                   f"{precedents['looser']} a more permissive limit. Without a precedent at this value: Insufficient evidence."))

            if (changed["value"] or changed["operator"]) and not changed["unit"]:
                rec = {"criterion_id": criterion_id, "action": "relax" if relax else "tighten", "proposed_value": p["value_norm"],
                       "proposed_unit": crit["unit_norm"],
                       "claims": [{"type": "comparator_threshold", "nct_id": r["nct_id"], "value": r["value"], "unit": r["unit"]} for r in same],
                       "text": rationale.strip() or f"Consider {_limit(p)} instead of {_limit(crit)}."}
                ver = verify(rec, review, resolvers or {})
                verification = {"status": ver["status"], "outcome": ver.get("outcome", ""), "checks": ver.get("checks", [])}
                level = {"REJECTED": "fail", "PASSED_WITH_WARNINGS": "warn", "PASSED": "pass"}.get(ver["status"], "info")
                worst = next((c for want in ("fail", "warn") for c in ver.get("checks", []) if c.get("result") == want), None)
                msg = f"Verifier: {ver['status'].replace('_', ' ').lower()}"
                outcome = str(ver.get("outcome") or "")
                if outcome and outcome.lower() != ver["status"].replace("_", " ").lower():
                    msg += f"; outcome: {outcome[0].lower() + outcome[1:]}"
                if worst:
                    msg += f" ({worst['check'].replace('_', ' ')}: {str(worst.get('detail', '')).rstrip('.')})"
                flags.append(_flag(level, "verifier", msg + "."))

            if analyte in nhanes.ANALYTES and p["operator"] in GE and not changed["unit"]:
                cur, new = _below(analyte, crit["value_norm"]), _below(analyte, p["value_norm"])
                population = {"current_pct": cur["overall"]["pct"], "proposed_pct": new["overall"]["pct"],
                              "rule": "share of US adults below the limit", "caveat": nhanes.CAVEAT}
                versus = f" ({cur['overall']['pct']}% below the protocol's {_fmt(crit['value_norm'])})" if changed["value"] else ""
                flags.append(_flag("info", "population",
                                   f"{new['overall']['pct']}% of US adults fall below {_fmt(p['value_norm'])} {p['unit_norm']}{versus}. "
                                   f"{nhanes.CAVEAT}", {"label": "NHANES", "url": None, "page": None}))

    for ev in item.get("evidence", []):
        if ev.get("kind") == "regimen" and ev.get("stance") == "supports":
            summary = str(ev.get("summary", "")).rstrip(".")
            if "supports having" not in summary:
                summary += ". This supports having a limit, not a specific value"
            flags.append(_flag("info", "toxicity_link", summary + "."))
        if ev.get("kind") == "fda" and ev.get("strength") == "specific":
            quote = " ".join(str(ev.get("quote") or "").split())
            quote = quote if len(quote) <= 240 else quote[:237].rsplit(" ", 1)[0] + "..."
            flags.append(_flag("info", "fda_guidance", f"FDA guidance on this criterion: \"{quote}\"" if quote else
                               "FDA guidance addresses this criterion.",
                               {"label": ev.get("citation") or "FDA guidance", "url": ev.get("link"), "page": None}))

    for label, s in (("draft", text), ("rationale note", rationale)):
        hits = sorted({m.group(0) for m in OVERCLAIM.finditer(s or "")})
        if hits:
            flags.append(_flag("fail", "overclaim", f"The {label} claims {', '.join(repr(h) for h in hits)}: safety, efficacy or "
                                                    "enrollment effects cannot be established from public precedents."))
        need = sorted({m.group(0) for m in NECESSITY.finditer(s or "")})
        if need:
            flags.append(_flag("warn", "necessity_language", f"The {label} says {', '.join(repr(h) for h in need)}; necessity cannot "
                                                             "be established from public precedents. Prefer 'may be more restrictive than needed'."))

    flags.sort(key=lambda f: LEVELS.index(f["level"]))
    return {"criterion_id": criterion_id, "label": crit["label"] or LABELS.get(analyte, criterion_id),
            "original": original, "parsed": parsed, "changed": changed, "flags": flags, "precedents": precedents,
            "verification": verification, "population": population,
            "summary": {lvl: sum(f["level"] == lvl for f in flags) for lvl in LEVELS}}
