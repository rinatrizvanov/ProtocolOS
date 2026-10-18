"""Rationale report for a cached review: categories, arm attribution and missing criteria.

Pure functions over a `review.run_review` result; nothing here changes classification or scores, and the
deterministic verifier stays the authority on any suggested change.

- `categories(item, review)`: which kinds of rationale a criterion plausibly has (safety, efficacy
  enrichment, precedent), from `review_criterion`'s inferred purposes and its evidence items.
- `arm_attribution(review, criterion_id)`: which arms list the agents behind a regimen safety rationale.
  `extract.py` pools drugs across arms, so this is a rule over the registry arm labels and intervention
  names. The text says "listed in", never that an agent caused anything.
- `missing_criteria(review)`: criteria most comparable protocols state and this protocol's extraction lacks.
  Extraction misses are possible, so each item is a question to check, not a finding.
"""
from __future__ import annotations

import math
import re

from . import druglib

SCHEMA_VERSION = 1
BLIND_SPOT = ("Rationale in non-public sources (preclinical toxicology, internal development data, regulator "
              "correspondence) cannot be seen by ProtocolOS.")
METHOD = ("Deterministic rules over the cached review: categories from the inferred purposes and the review's protocol, "
          "regimen, comparator and FDA items; "
          "arm attribution from registry arm labels and intervention names; missing criteria from the comparators' "
          "extracted criteria. Categories are inferred unless the protocol text supports the threshold.")
ARM_METHOD = ("Rule over registry arm labels and intervention names: an arm lists an agent when a named agent matches "
              "(curated drug table, including aliases) or, for cytotoxic agents, when the arm text contains 'chemo'. "
              "Registry arm type EXPERIMENTAL counts as investigational; ACTIVE_COMPARATOR, PLACEBO_COMPARATOR, "
              "SHAM_COMPARATOR and NO_INTERVENTION count as comparator; other types are not assigned.")
LABELS = {"safety": "Safety", "enrichment": "Efficacy enrichment", "precedent": "Precedent"}
# FDA Enrichment Strategies (2019) section III, "Decreasing Variability": the label for the enrichment badge when the
# basis is tolerability, heterogeneity or completion; predictive or interpretability bases keep LABELS["enrichment"].
VARIABILITY_LABEL = "Enrichment: lower variability"
VARIABILITY = {"tolerability", "heterogeneity", "completion"}
EFFICACY = {"predictive", "interpretability"}
# Safety purposes that name regimen agents (review.PURPOSE_RULES) for a criterion druglib.LAB_RELEVANCE does not cover;
# the arm line attributes the same agents the Safety badge lists.
SAFETY_RELEVANCE = {"washout_vaccine": ("immunotherapy", "live vaccines with immunomodulating therapy may pose infection "
                                                         "or immune risk")}
INVESTIGATIONAL_TYPES = {"EXPERIMENTAL"}
COMPARATOR_TYPES = {"ACTIVE_COMPARATOR", "PLACEBO_COMPARATOR", "SHAM_COMPARATOR", "NO_INTERVENTION"}
CHEMO = re.compile(r"chemo", re.I)


def _fmt(c: dict) -> str:
    v = c.get("value_norm")
    if v is not None and float(v).is_integer():
        v = int(v)
    return f"{c.get('operator') or ''}{v} {c.get('unit_norm') or ''}".strip()


def _status(item: dict) -> str:
    stated = any(e.get("kind") == "protocol" and e.get("stance") == "supports" for e in item.get("evidence", []))
    return "stated in protocol" if stated else "inferred"


def _protocol_sources(item: dict) -> list[dict]:
    out = []
    for e in item.get("evidence", []):
        if e.get("kind") == "protocol" and e.get("stance") == "supports":
            src = {"kind": "protocol", "label": f"Protocol p. {e.get('page')}"}
            if e.get("page") is not None:
                src["page"] = e["page"]
            if e.get("url"):
                src["url"] = e["url"]
            out.append(src)
    return out


def _acronyms(review: dict) -> dict[str, str | None]:
    return {c["study"]["nct_id"]: c["study"].get("acronym") for c in review.get("comparators", [])}


def _qualifiers(purpose: str) -> set[str]:
    """{"tolerability", "heterogeneity"} for "Statistical design (tolerability / heterogeneity)"."""
    m = re.search(r"\(([^)]*)\)", purpose or "")
    return {q.strip().lower() for q in m.group(1).split("/")} if m else set()


def _enrichment_label(enrich: list[dict]) -> str:
    quals = set().union(*(_qualifiers(p.get("purpose", "")) for p in enrich))
    if quals & EFFICACY or any(p.get("purpose") == "Predictive enrichment" for p in enrich):
        return LABELS["enrichment"]
    return VARIABILITY_LABEL if quals & VARIABILITY else LABELS["enrichment"]


def categories(item: dict, review: dict) -> list[dict]:
    """RationaleCategory dicts (plan-v2 section 6.1) for one `review_criterion` output."""
    status = _status(item)
    purposes = item.get("purposes", [])
    evidence = item.get("evidence", [])
    out: list[dict] = []

    safety = [p for p in purposes if p.get("purpose") == "Safety"]
    if safety:
        sources = _protocol_sources(item)
        if any(e.get("kind") == "regimen" and e.get("stance") == "supports" for e in evidence):
            sources.append({"kind": "curated", "label": "Curated pharmacology table"})
        out.append({"key": "safety", "label": LABELS["safety"], "status": status,
                    "basis": " ".join(p["basis"] for p in safety), "sources": sources})

    enrich = [p for p in purposes
              if str(p.get("purpose", "")).startswith("Statistical design")
              or (p.get("purpose") == "Predictive enrichment" and p.get("status") == "possible (inferred)")]
    if enrich:
        sources = _protocol_sources(item)
        for p in enrich:
            fc = p.get("fda_context")
            if fc:
                src = {"kind": "fda", "label": fc.get("citation") or "FDA guidance"}
                if fc.get("link"):
                    src["url"] = fc["link"]
                sources.append(src)
        # A Predictive enrichment entry next to a "Statistical design (... / predictive)" one only points back to it.
        named = any("predictive" in p["purpose"] for p in enrich if p.get("purpose") != "Predictive enrichment")
        basis = " ".join(f"{p['purpose']}: {p['basis']}" for p in enrich
                         if not (named and p.get("purpose") == "Predictive enrichment"))
        out.append({"key": "enrichment", "label": _enrichment_label(enrich), "status": status, "basis": basis,
                    "sources": sources})

    acr = _acronyms(review)
    comps = [e for e in evidence if e.get("kind") == "comparator" and e.get("stance") in ("supports", "context")]
    fda = [e for e in evidence if e.get("kind") == "fda" and e.get("strength") == "specific"]
    # A badge reads as support, so FDA passages that only challenge the criterion do not earn it on their own.
    if comps or any(e.get("stance") != "challenges" for e in fda):
        sources = []
        for e in comps:
            src = {"kind": "comparator", "label": acr.get(e.get("nct_id")) or e.get("nct_id") or "Comparable trial",
                   "nct_id": e.get("nct_id")}
            if e.get("page") is not None:
                src["page"] = e["page"]
            if e.get("url"):
                src["url"] = e["url"]
            sources.append(src)
        for e in fda:
            src = {"kind": "fda", "label": e.get("citation") or "FDA guidance"}
            if e.get("link"):
                src["url"] = e["link"]
            sources.append(src)
        parts = []
        if comps:
            parts.append(f"{len(comps)} comparable trial(s) used the same, a stricter or a related threshold; "
                         "agreement may reflect template carry-forward")
        if fda:
            against = sum(e.get("stance") == "challenges" for e in fda)
            parts.append(f"{len(fda)} criterion-specific FDA passage(s) address this criterion"
                         + (f", {against} of them challenging it as written" if against else "")
                         + (" (issued after this trial started; applied retrospectively)"
                            if any(e.get("retrospective") for e in fda) else ""))
        out.append({"key": "precedent", "label": LABELS["precedent"], "status": status,
                    "basis": "; ".join(parts) + ".", "sources": sources})
    return out


def _role(arm_type: str | None) -> str | None:
    t = (arm_type or "").upper()
    if t in INVESTIGATIONAL_TYPES:
        return "investigational"
    if t in COMPARATOR_TYPES:
        return "comparator"
    return None


def _arm_text(arm: dict) -> str:
    return " ".join([arm.get("label") or "", *(arm.get("interventions") or [])])


def _driver(has: list[bool], roles: list[str | None]) -> str:
    if not has or not any(has):
        return "undetermined"
    if all(has):
        return "all_arms"
    with_roles = {r for h, r in zip(has, roles) if h}
    if None in with_roles:
        return "undetermined"
    if with_roles == {"investigational"}:
        return "investigational"
    if with_roles == {"comparator"}:
        return "comparator"
    return "mixed"


def _and(xs: list[str]) -> str:
    return ", ".join(xs[:-1]) + " and " + xs[-1] if len(xs) > 1 else "".join(xs)


def _labels(arms: list[dict]) -> str:
    return "; ".join(f"'{a['label']}'" for a in arms)


def arm_attribution(review: dict, criterion_id: str) -> dict:
    """ArmAttribution dict (plan-v2 section 6.1) for one criterion of the target trial."""
    target = review["target"]
    crit = next((c for c in target["criteria"] if c["id"] == criterion_id), None)
    analyte = crit["analyte"] if crit else criterion_id
    regimen = target.get("regimen") or {}
    raw_arms = regimen.get("arms") or []
    base = {"criterion_id": criterion_id, "property": None, "agents": [], "arms": [], "method": ARM_METHOD}

    rel = druglib.LAB_RELEVANCE.get(analyte) or SAFETY_RELEVANCE.get(analyte)
    if not rel:
        return {**base, "driver": "not_applicable", "arms": [
            {"label": a.get("label") or "", "type": a.get("type"), "has_agent": False, "matched_by": "none"} for a in raw_arms],
            "text": "This criterion has no regimen-specific toxicity link in the curated pharmacology table, so arm "
                    "attribution does not apply."}
    prop, why = rel
    flagged = druglib.drugs_with(set(regimen.get("drugs") or {}), prop)
    base["property"] = why
    if not flagged:
        return {**base, "driver": "not_applicable", "arms": [
            {"label": a.get("label") or "", "type": a.get("type"), "has_agent": False, "matched_by": "none"} for a in raw_arms],
            "text": f"Pharmacology link: {why}. No agent in the regimen is flagged for it in the curated pharmacology "
                    "table, so arm attribution does not apply."}

    cytotoxic = {n for n in flagged if druglib.BY_NAME[n].myelosuppressive}
    per_agent: dict[str, list[bool]] = {n: [] for n in flagged}
    named_hits: dict[str, list[bool]] = {n: [] for n in flagged}
    arms, has, roles = [], [], []
    for a in raw_arms:
        text = _arm_text(a)
        named = set(druglib.find_drugs(text)) & set(flagged)
        chemo = bool(CHEMO.search(text)) and bool(cytotoxic)
        matched_by = "named agent" if named else ("arm text 'chemo'" if chemo else "none")
        arms.append({"label": a.get("label") or "", "type": a.get("type"), "has_agent": bool(named or chemo),
                     "matched_by": matched_by})
        has.append(bool(named or chemo))
        roles.append(_role(a.get("type")))
        for n in flagged:
            per_agent[n].append(n in named or (n in cytotoxic and chemo))
            named_hits[n].append(n in named)
    agents = [{"name": n, "drug_class": druglib.BY_NAME[n].drug_class, "arms": _driver(per_agent[n], roles)}
              for n in flagged]
    driver = _driver(has, roles)
    listed = [n for n in flagged if any(per_agent[n])]
    unmatched = [n for n in flagged if not any(per_agent[n])]
    with_arms = [a for a in arms if a["has_agent"]]
    without = [a for a in arms if not a["has_agent"]]
    # Arms that name none of the flagged agents and match only because their text says "chemo".
    chemo_only = [a for a in with_arms if a["matched_by"] == "arm text 'chemo'"]
    one = len(listed) == 1
    # Subject of the arm sentence: only the agents some arm matched, so an unmatched agent is never placed in an arm.
    subject = ("It is" if one else "They are") if not unmatched else f"Of these, {_and(listed)} {'is' if one else 'are'}"
    them = "it" if one else "them"
    lead = f"Pharmacology link: {why}. Regimen agents flagged: {', '.join(flagged)}. "
    if not raw_arms:
        body = "The registry lists no arms, so the arm that lists them could not be determined."
    elif not with_arms:
        body = "No registry arm label or intervention name lists them, so the arm could not be determined."
    elif driver == "all_arms":
        alike = ", investigational and comparator alike" if {"investigational", "comparator"} <= set(roles) else ""
        span = "both arms" if len(arms) == 2 else f"all {len(arms)} arms"
        if all(all(named_hits[n]) for n in listed):
            each = (("It is" if one else "Each is") if not unmatched
                    else f"Of these, {_and(listed)} {'is' if one else 'are each'}")
            body = f"{each} listed in {span}{alike}."
        elif len(chemo_only) == len(arms):
            body = (f"Every arm's label or intervention names mention chemotherapy ({_labels(arms)}), but the registry "
                    f"does not name which chemotherapy agents each arm uses. {subject} counted as listed in {span} "
                    f"through the arm text 'chemo'{alike}.")
        elif one:
            body = f"{subject} counted as listed in each of the {len(arms)} arms{alike}."
        else:
            body = f"At least one of them is listed in each of the {len(arms)} arms{alike}."
    elif driver == "investigational":
        body = (f"{subject} listed in the investigational arm(s) only ({_labels(with_arms)}); the other arm(s) "
                f"({_labels(without)}) do not list {them}.")
    elif driver == "comparator":
        body = (f"{subject} listed in the comparator / standard-of-care arm(s) only ({_labels(with_arms)}); the other "
                f"arm(s) ({_labels(without)}) do not list {them}.")
    elif driver == "mixed":
        body = f"{subject} listed in some investigational and some comparator arms ({_labels(with_arms)}), not in all arms."
    else:
        body = (f"{subject} listed in {_labels(with_arms)}; the registry does not mark those arms as investigational or "
                "comparator, so the driving arm could not be determined.")
    if chemo_only and len(chemo_only) < len(arms):
        single = len(chemo_only) == 1
        body += (f" {_labels(chemo_only)} {'matches' if single else 'match'} only through the arm text 'chemo': the "
                 f"registry does not name which chemotherapy agents {'that arm uses' if single else 'those arms use'}.")
    if with_arms and unmatched:
        body += (f" The regimen includes {_and(unmatched)}, but no arm label or intervention names "
                 f"{'it' if len(unmatched) == 1 else 'them'}.")
    text = lead + body
    return {**base, "driver": driver if raw_arms else "undetermined", "agents": agents, "arms": arms, "text": text}


def missing_criteria(review: dict) -> list[dict]:
    """Criterion ids stated by at least max(2, ceil(0.75*M)) of the M comparators and not extracted from the target."""
    comps = review.get("comparators", [])
    m = len(comps)
    if m == 0:
        return []
    need = max(2, math.ceil(0.75 * m))
    have = {c["id"] for c in review["target"]["criteria"]}
    found: dict[str, list[tuple[dict, dict]]] = {}
    order: list[str] = []
    for comp in comps:
        seen = set()
        for c in comp.get("criteria", []):
            cid = c.get("id")
            if not cid or cid in have or cid in seen:
                continue
            seen.add(cid)
            if cid not in found:
                found[cid] = []
                order.append(cid)
            found[cid].append((comp, c))
    out = []
    for cid in order:
        rows = found[cid]
        if len(rows) < need:
            continue
        examples = []
        for comp, c in rows:
            src = c.get("source") or {}
            examples.append({"nct_id": comp["study"]["nct_id"], "acronym": comp["study"].get("acronym"),
                             "threshold": _fmt(c), "page": src.get("page"), "quote": src.get("text") or "",
                             "url": src.get("url")})
        out.append({"criterion_id": cid, "label": rows[0][1].get("label") or cid, "comparators_with": len(rows),
                    "comparators_total": m, "examples": examples,
                    "text": f"Not extracted from this protocol; present in {len(rows)} of {m} comparable protocols. "
                            "Check the protocol."})
    return out


def rationale_report(review: dict) -> dict:
    """RationaleReport dict (plan-v2 section 6.1) for a cached review."""
    criteria = {}
    for item in review["reviews"]:
        cid = item["criterion"]["id"]
        criteria[cid] = {"categories": categories(item, review), "arm_attribution": arm_attribution(review, cid)}
    return {"schema_version": SCHEMA_VERSION, "nct_id": review["target"]["study"]["nct_id"], "criteria": criteria,
            "missing": missing_criteria(review), "blind_spot": BLIND_SPOT, "method": METHOD}


def texts(report: dict) -> list[str]:
    """Every human-readable string in a report (used to check the overclaim rule)."""
    out = [report["blind_spot"], report["method"]]
    for v in report["criteria"].values():
        out += [c["basis"] for c in v["categories"]] + [c["label"] for c in v["categories"]]
        out += [v["arm_attribution"]["text"], v["arm_attribution"]["method"]]
    out += [m["text"] for m in report["missing"]]
    return out
