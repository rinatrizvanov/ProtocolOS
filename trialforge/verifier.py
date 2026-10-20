"""Deterministic verification of proposed eligibility recommendations.

A recommendation is structured so its claims can be checked mechanically:

{
  "criterion_id": "anc",
  "action": "relax" | "remove" | "tighten" | "retain" | "add_provision" | "justify_in_protocol",
  "proposed_value": 1.0,            # optional, in the criterion's normalized unit
  "proposed_unit": "×10⁹/L",        # optional
  "claims": [
     {"type": "drug_property", "drug": "cemiplimab", "property": "myelosuppressive", "value": false},
     {"type": "comparator_threshold", "nct_id": "NCT02578680", "value": 9.0, "unit": "g/dL"},
     {"type": "fda_quote", "guidance": "lab", "quote": "..."},
     {"type": "protocol_quote", "quote": "..."}
  ],
  "text": "free-text rationale"
}

Outcome: REJECTED (any failed check), PASSED_WITH_WARNINGS, or PASSED. Each check reports why.
This module only depends on the review context dict and the injected resolvers.
"""
from __future__ import annotations

import re

from .extract import criterion_text

NCT_RE = re.compile(r"^NCT\d{8}$")

PLAUSIBLE = {
    "hemoglobin": (5.0, 15.0, "g/dL"),
    "anc": (0.3, 5.0, "×10⁹/L"),
    "platelets": (20.0, 300.0, "×10⁹/L"),
    "bilirubin": (1.0, 10.0, "×ULN"),
    "ast_alt": (1.0, 20.0, "×ULN"),
    "renal": (10.0, 120.0, "mL/min"),
    "ecog": (0.0, 4.0, "ECOG"),
    "brain_mets": (0.0, 2.0, "policy level"),
    "hiv": (0.0, 1.0, "policy level"),
    "hbv": (0.0, 1.0, "policy level"),
    "hcv": (0.0, 1.0, "policy level"),
    "prior_malignancy": (0.0, 100.0, "years"),  # extract.LIFETIME_YEARS stands for "no prior malignancy at any time"
    "qtc": (400.0, 550.0, "ms"),
}
UNIT_ALIASES = {
    "g/dl": "g/dL", "x10^9/l": "×10⁹/L", "×10^9/l": "×10⁹/L", "x 10^9/l": "×10⁹/L", "×10⁹/l": "×10⁹/L",
    "10^9/l": "×10⁹/L", "xuln": "×ULN", "×uln": "×ULN", "uln": "×ULN", "ml/min": "mL/min", "days": "days", "ecog": "ECOG",
    "years": "years", "ms": "ms", "msec": "ms", "policylevel": "policy level",
}
RELEVANT_PROPERTY = {
    "hemoglobin": "myelosuppressive", "anc": "myelosuppressive", "platelets": "myelosuppressive",
    "bilirubin": "hepatic", "ast_alt": "hepatic", "renal": "renal", "washout_corticosteroid": "immunotherapy",
}
GUIDANCE_FOR_CATEGORY = {"lab": "lab", "performance_status": "ps", "washout": "washout"}
# condition criteria have one category but three guidances
GUIDANCE_FOR_ANALYTE = {"brain_mets": "brain", "hiv": "infection", "hbv": "infection", "hcv": "infection",
                        "prior_malignancy": "organ", "qtc": "organ"}
HIGHER_IS_STRICTER = {"hemoglobin", "anc", "platelets", "renal", "prior_malignancy"}

OVERCLAIM = re.compile(
    r"\b(?:is|are|would be|will be)\s+(?:completely\s+|entirely\s+)?safe\b|no (?:additional |increased )?risk|proven|guarantee[sd]?|"
    r"will (?:increase|improve|boost|accelerate) (?:enrol+ment|accrual|recruitment)|clinically validated|"
    r"FDA (?:requires|mandates|has approved)",
    re.I,
)
NECESSITY = re.compile(r"\bunnecessary\b|\bnot needed\b|\bno longer needed\b|\bserves no purpose\b", re.I)


def _norm_unit(u: str | None) -> str | None:
    if u is None:
        return None
    k = u.strip().lower().replace(" ", "")
    return UNIT_ALIASES.get(k, u.strip())


def expected_guidance(crit: dict) -> str | None:
    """The FDA guidance that addresses this criterion; a quote from another one fails the fda_topic check."""
    return GUIDANCE_FOR_ANALYTE.get(crit.get("analyte")) or GUIDANCE_FOR_CATEGORY.get(crit.get("category"))


def _looser(analyte: str, new: float, old: float) -> bool:
    if analyte in HIGHER_IS_STRICTER or analyte.startswith("washout"):
        return new < old
    return new > old


def verify(rec: dict, ctx: dict, resolvers: dict | None = None) -> dict:
    """ctx = output of review.run_review (or an equivalent, self-contained dict).

    resolvers (optional) supplies network-backed checks so this module stays pure:
      - "nct_exists": fn(nct_id) -> bool | None
      - "nct_threshold": fn(nct_id, analyte) -> dict(criterion) | None
      - "fda_quote": fn(guidance_key, quote) -> {"ok": bool, ...}
      - "protocol_quote": fn(nct_id, quote) -> bool
    """
    resolvers = resolvers or {}
    checks: list[dict] = []

    def fail(name, msg):
        checks.append({"check": name, "result": "fail", "detail": msg})

    def warn(name, msg):
        checks.append({"check": name, "result": "warn", "detail": msg})

    def ok(name, msg):
        checks.append({"check": name, "result": "pass", "detail": msg})

    target = ctx["target"]
    crits = {c["id"]: c for c in target["criteria"]}
    crit = crits.get(rec.get("criterion_id"))
    if crit is None:
        fail("criterion_exists", f"Criterion '{rec.get('criterion_id')}' was not extracted from {target['study']['nct_id']}.")
        return _result(checks)
    ok("criterion_exists", f"{crit['label']} {criterion_text(crit)} (p.{crit['source']['page']}).")
    analyte = crit["analyte"]
    action = rec.get("action", "")
    regimen = target["regimen"]["drugs"]
    claims = rec.get("claims", []) or []

    # -- proposed value / units
    pv = rec.get("proposed_value")
    if pv is not None:
        unit = _norm_unit(rec.get("proposed_unit")) or crit["unit_norm"]
        if unit != crit["unit_norm"]:
            fail("units", f"Proposed unit '{rec.get('proposed_unit')}' does not match the criterion unit '{crit['unit_norm']}'.")
        else:
            lo, hi, _ = PLAUSIBLE.get(analyte, (0, 365, crit["unit_norm"]))
            if not (lo <= float(pv) <= hi):
                fail("plausibility", f"Proposed value {pv} {unit} is outside the plausible range {lo}–{hi} for {crit['label']}.")
            else:
                ok("plausibility", f"Proposed value {pv} {unit} is in a plausible range.")
            if action == "relax" and not _looser(analyte, float(pv), crit["value_norm"]):
                fail("direction", f"Action is 'relax' but {pv} is not more permissive than the current {crit['operator']}{crit['value_norm']}.")
            if action == "tighten" and _looser(analyte, float(pv), crit["value_norm"]):
                fail("direction", f"Action is 'tighten' but {pv} is more permissive than the current value.")

    # -- claims
    comparator_support = []
    for cl in claims:
        t = cl.get("type")
        if t == "comparator_threshold":
            nct = str(cl.get("nct_id", "")).strip().upper()
            if not NCT_RE.match(nct):
                fail("comparator_id", f"'{nct}' is not a valid NCT identifier.")
                continue
            comp_crit = None
            known = {c["study"]["nct_id"]: c for c in ctx.get("comparators", [])}
            if nct in known:
                comp_crit = next((c for c in known[nct]["criteria"] if c["analyte"] == analyte), None)
            else:
                exists = resolvers.get("nct_exists", lambda _n: None)(nct)
                if exists is False:
                    fail("comparator_exists", f"{nct} does not exist on ClinicalTrials.gov.")
                    continue
                if exists is None:
                    warn("comparator_exists", f"{nct} is not among the retrieved comparators and could not be checked.")
                    continue
                comp_crit = resolvers.get("nct_threshold", lambda *_: None)(nct, analyte)
            if comp_crit is None:
                warn("comparator_value", f"No {crit['label']} threshold could be extracted for {nct}; the claimed value is unverified.")
                continue
            cv = cl.get("value")
            cu = _norm_unit(cl.get("unit")) or comp_crit["unit_norm"]
            if cu != comp_crit["unit_norm"] or cv is None or abs(float(cv) - comp_crit["value_norm"]) > 1e-6:
                fail("comparator_value",
                     f"Claimed {nct} threshold {cv} {cl.get('unit','')} does not match the source: {comp_crit['operator']}{comp_crit['value_norm']} {comp_crit['unit_norm']} (p.{comp_crit['source']['page']}: \"{comp_crit['source']['text'][:90]}\").")
                continue
            ok("comparator_value", f"{nct} {crit['label']} {comp_crit['operator']}{comp_crit['value_norm']} {comp_crit['unit_norm']} matches the protocol (p.{comp_crit['source']['page']}).")
            comparator_support.append((nct, comp_crit))
            if action == "relax" and not _looser(analyte, comp_crit["value_norm"], crit["value_norm"]):
                fail("comparator_direction", f"{nct} is not more permissive than the target ({comp_crit['value_norm']} vs {crit['value_norm']}), so it cannot support relaxing.")
            # regimen coverage for lab criteria
            prop = RELEVANT_PROPERTY.get(analyte)
            if prop and nct in known:
                t_cls = {d["class"] for d in regimen.values() if d.get(prop)}
                c_cls = {d["class"] for d in known[nct]["regimen"]["drugs"].values() if d.get(prop)}
                missing = sorted(t_cls - c_cls)
                if missing:
                    warn("comparator_regimen", f"{nct} regimen lacks {', '.join(missing)} present in the target; its threshold is weaker evidence.")
            if action in ("relax", "remove"):
                warn("permissive_comparator", "A more permissive comparator shows a threshold was used, not that it was safe or that the stricter one is unnecessary.")
        elif t == "fda_quote":
            g = cl.get("guidance")
            res = resolvers.get("fda_quote", lambda *_: {"ok": None})(g, cl.get("quote", ""))
            if res.get("ok") is False:
                fail("fda_quote", f"FDA quote not verified: {res.get('reason')}.")
                continue
            if res.get("ok") is None:
                warn("fda_quote", "FDA quote could not be checked in this environment.")
                continue
            expected = expected_guidance(crit)
            if g != expected:
                fail("fda_topic", f"Cited guidance '{g}' does not address {crit['category'].replace('_',' ')} criteria (expected '{expected}').")
                continue
            ok("fda_quote", f"Quote found verbatim in FDA {g} guidance, {res.get('section','')}, lines {res.get('fda_lines')}.")
        elif t == "protocol_quote":
            found = resolvers.get("protocol_quote", lambda *_: None)(target["study"]["nct_id"], cl.get("quote", ""))
            if found is False:
                fail("protocol_quote", "Quoted protocol text was not found in the protocol document.")
            elif found is None:
                warn("protocol_quote", "Protocol quote could not be checked.")
            else:
                ok("protocol_quote", "Quoted protocol text found verbatim.")
        elif t == "drug_property":
            drug = str(cl.get("drug", "")).lower()
            prop = cl.get("property")
            if drug not in regimen:
                fail("drug_in_regimen", f"'{drug}' is not part of this trial's regimen ({', '.join(sorted(regimen))}).")
                continue
            actual = regimen[drug].get(prop)
            if actual is None:
                warn("drug_property", f"Property '{prop}' is not tracked for {drug}.")
            elif bool(actual) != bool(cl.get("value")):
                fail("drug_property", f"Claim '{drug} {prop}={cl.get('value')}' contradicts the curated pharmacology table ({prop}={actual}).")
            else:
                ok("drug_property", f"{drug} {prop}={actual} is consistent with the curated table.")
        else:
            warn("claim_type", f"Unrecognized claim type '{t}' was not checked.")

    # -- regimen contradiction: relaxing/removing a toxicity-linked criterion while ignoring other arms
    prop = RELEVANT_PROPERTY.get(analyte)
    if prop and action in ("relax", "remove"):
        offenders = sorted(n for n, d in regimen.items() if d.get(prop))
        claimed_neg = [cl for cl in claims if cl.get("type") == "drug_property" and cl.get("property") == prop and not cl.get("value")]
        if offenders and claimed_neg:
            fail("regimen_contradiction",
                 f"The rationale cites {', '.join(c['drug'] for c in claimed_neg)} as not {prop}, but the trial's arms also include "
                 f"{', '.join(offenders)} ({prop}). A threshold on {crit['label'].lower()} has a safety rationale for this regimen.")
        elif offenders:
            warn("regimen_relevance", f"Arms include {', '.join(offenders)} ({prop}); relaxing requires regimen-matched evidence.")
        if action == "remove" and offenders:
            fail("removal", f"Removing the {crit['label']} criterion is not supported while arms include {prop} agents.")

    if action in ("relax", "remove") and not comparator_support and not any(c["result"] == "pass" and c["check"] == "fda_quote" for c in checks):
        fail("evidence_required", "A relaxation must cite at least one verified comparator threshold or verified FDA passage.")
    elif action == "relax" and not comparator_support:
        warn("guidance_only", "Supported only by general guidance; no trial-level evidence that the proposed value was used in a comparable setting.")

    text = rec.get("text", "") or ""
    if OVERCLAIM.search(text):
        fail("overclaim", f"Overclaims: \"{OVERCLAIM.search(text).group(0)}\". Safety, efficacy or enrollment effects cannot be established from the retrieved evidence.")
    elif NECESSITY.search(text):
        warn("necessity_language", f"\"{NECESSITY.search(text).group(0)}\": necessity cannot be established from retrieved evidence; prefer 'may be more restrictive than needed'.")

    # temporal check (as-of)
    as_of = ctx.get("as_of")
    for nct, cc in comparator_support:
        start = next((c["study"]["start_date"] for c in ctx.get("comparators", []) if c["study"]["nct_id"] == nct), None)
        if as_of and start and start > as_of:
            warn("as_of", f"{nct} started {start}, after the review cutoff {as_of}.")
    return _result(checks, action)


# Factual checks compare a claim with a source document. Clinical-logic checks apply hand-written
# reasoning rules (regimen contradiction, direction, evidence sufficiency, overclaiming). Neither is
# clinical validation; the distinction is shown to reviewers.
FACTUAL_CHECKS = {
    "criterion_exists", "units", "plausibility", "comparator_id", "comparator_exists", "comparator_value",
    "fda_quote", "protocol_quote", "drug_in_regimen", "drug_property", "claim_type",
}

OUTCOMES = {
    "REJECTED": "Rejected",
    "PASSED_WITH_WARNINGS": "Supported with qualifications",
    "PASSED": "Supported",
}


def _result(checks, action=None):
    for c in checks:
        c["category"] = "factual" if c["check"] in FACTUAL_CHECKS else "clinical-logic"
    if any(c["result"] == "fail" for c in checks):
        status = "REJECTED"
    elif any(c["result"] == "warn" for c in checks):
        status = "PASSED_WITH_WARNINGS"
    else:
        status = "PASSED"
    outcome = OUTCOMES[status]
    # Changing a threshold is a clinical judgment even when every factual check passes: escalate.
    if status != "REJECTED" and action in ("relax", "remove", "tighten"):
        outcome = "Needs medical review"
    return {"status": status, "outcome": outcome, "checks": checks}


def default_resolvers():
    """Network/document-backed resolvers used by the app (kept out of verify() for purity)."""
    from .extract import analyze_trial
    from .guidance import normalize, verify_quote
    from .sources import fetch_protocol, fetch_study

    def nct_exists(n):
        try:
            fetch_study(n)
            return True
        except Exception as e:
            return False if "404" in str(e) else None

    def nct_threshold(n, analyte):
        try:
            a = analyze_trial(n)
            return next((c for c in a["criteria"] if c["analyte"] == analyte), None)
        except Exception:
            return None

    def protocol_quote(n, quote):
        doc = fetch_protocol(n)
        if not doc:
            return None
        return normalize(quote) in normalize(doc.full_text)

    return {"nct_exists": nct_exists, "nct_threshold": nct_threshold, "fda_quote": verify_quote, "protocol_quote": protocol_quote}
