"""Authoring mode: draft eligibility criteria for a new trial idea, then critique them.

ProtocolOS drafts only what the extractor structures (6 labs, ECOG, washouts). Every proposed value is
copied from a real, regimen-matched precedent whose threshold the unchanged deterministic verifier matched
to its protocol; otherwise the criterion is "Insufficient evidence" with no value. The same review engine
that critiques existing protocols then critiques the draft. No model call is made here.

Plan: plan-v2.md section 4 (Default value policy, Insufficient-evidence policy, Drafts through the
unchanged verifier, Operator check, Tags type, Self-critique, Public-mode drafts, Retrieval failure) and
section 6.2. Document text is data, never instructions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import comparators, druglib, guidance, review, settings, verifier
from .sources import DATA

try:  # WS-E (plan-v2 section 6.4); absent until the C1a rebase
    from .rationale import categories as _categories
except ImportError:  # pragma: no cover - depends on the branch
    _categories = None

DRAFTS_DIR = DATA / "drafts"
SETTING_TAGS = ("first-line", "metastatic", "non-squamous", "squamous", "perioperative/locally-advanced")
PHASES = ("PHASE2", "PHASE3")
DRAFT_ID_RE = re.compile(r"^d-[0-9a-f]{12}$")
ORDER = ["hemoglobin", "anc", "platelets", "renal", "bilirubin", "ast_alt", "ecog"]
K = 4

BLIND_SPOT = ("Rationale in non-public sources (preclinical toxicology, internal development data, regulator "
              "correspondence) cannot be seen by ProtocolOS.")
NOTES = [
    "Drafted criteria are suggestions with a traceable rationale; the team decides.",
    "A value is proposed only from regimen-matched precedents whose thresholds the verifier matched to their "
    "protocols; otherwise: Insufficient evidence.",
    "A toxicity link supports having a threshold, not a specific value. A more permissive precedent shows a "
    "threshold was used, not that it was safe.",
    "ProtocolOS structures lab, ECOG and washout criteria only. " + BLIND_SPOT,
]
DISPLAY_CLASSIFICATION = {
    review.CLASS_REVIEW: "Review recommended",
    review.CLASS_RETAIN: "Rationale supports keeping",
    review.CLASS_INSUFFICIENT: "Insufficient evidence",
}
CATEGORY_LABELS = {"safety": "Safety", "enrichment": "Efficacy enrichment", "precedent": "Regulatory precedent"}


def _el3_as_of() -> tuple[str | None, str]:
    p = DATA / "reviews" / "NCT03409614_auto.json"
    try:
        t = json.loads(p.read_text())["target"]["study"]
        return t.get("start_date"), (t.get("conditions") or ["Non-small Cell Lung Cancer"])[0]
    except Exception:
        return "2018-03-06", "Non-small Cell Lung Cancer"


_EL3_START, _EL3_COND = _el3_as_of()

PRESETS = {
    "nsclc-pd1-chemo": {
        "title": "First-line non-squamous NSCLC: PD-1 inhibitor plus platinum-pemetrexed",
        "idea": {"condition": "non-small cell lung cancer", "drugs": ["pembrolizumab", "carboplatin", "pemetrexed"],
                 "setting": ["first-line", "metastatic", "non-squamous"], "phase": "PHASE3", "as_of": None},
        "exclude": [],
    },
    "el3-design-time": {
        "title": "EMPOWER-Lung 3 at design time: cemiplimab plus platinum doublet (its own protocol excluded)",
        "idea": {"condition": _EL3_COND,
                 "drugs": ["cemiplimab", "carboplatin", "cisplatin", "paclitaxel", "pemetrexed"],
                 "setting": ["first-line", "metastatic"], "phase": "PHASE3", "as_of": _EL3_START},
        "exclude": ["NCT03409614"],
    },
}


class RetrievalFailed(Exception):
    pass


# ------------------------------------------------------------------ idea normalization

def normalize_idea(idea: dict) -> dict:
    drugs_in = [str(d).strip() for d in (idea.get("drugs") or []) if str(d).strip()]
    recognized: list[str] = []
    unrecognized: list[str] = []
    for d in drugs_in:
        hits = list(druglib.find_drugs(d)) or ([d.lower()] if d.lower() in druglib.BY_NAME else [])
        if hits:
            for h in hits:
                if h not in recognized:
                    recognized.append(h)
        else:
            unrecognized.append(d)
    setting = [s for s in SETTING_TAGS if s in set(idea.get("setting") or [])]
    phase = idea.get("phase") or "PHASE3"
    return {
        "condition": re.sub(r"\s+", " ", str(idea.get("condition", "")).strip()),
        "drugs": drugs_in,
        "setting": setting,
        "phase": phase,
        "as_of": idea.get("as_of") or None,
        "recognized_drugs": sorted(recognized),
        "unrecognized_drugs": unrecognized,
        "classes": sorted(druglib.classes(recognized)),
    }


def draft_id_for(idea: dict, exclude=()) -> str:
    n = normalize_idea(idea)
    key = {k: n[k] for k in ("condition", "drugs", "setting", "phase", "as_of")}
    key["drugs"] = sorted(d.lower() for d in key["drugs"])
    if exclude:
        key["exclude"] = sorted(str(x).upper() for x in exclude)
    return "d-" + hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:12]


def _as_of_cutoff(as_of: str | None) -> str | None:
    if not as_of:
        return None
    return as_of if len(as_of) == 10 else as_of + "-31"


def _regimen(names) -> dict:
    drugs = {}
    for n in names:
        d = druglib.BY_NAME[n]
        drugs[n] = {"sources": ["idea"], "class": d.drug_class, "myelosuppressive": d.myelosuppressive,
                    "renal": d.renal, "hepatic": d.hepatic, "immunotherapy": d.immunotherapy}
    return drugs


# ------------------------------------------------------------------ retrieval

def discover_for_idea(idea: dict, exclude=()) -> tuple[list[str], dict]:
    """Rank registry candidates for an idea (same search parameters as comparators.discover).

    Raises RetrievalFailed when ClinicalTrials.gov cannot be searched (never reported as "no precedents").
    """
    n = idea if "recognized_drugs" in idea else normalize_idea(idea)
    t_drugs = set(n["recognized_drugs"])
    t_classes = druglib.classes(t_drugs)
    names = sorted({d.name for d in druglib.DRUGS if d.drug_class in t_classes and d.immunotherapy}) or sorted(t_drugs)
    date_hi = _as_of_cutoff(n["as_of"]) or "2099-12-31"
    params = {
        "query.cond": n["condition"],
        "query.intr": " OR ".join(names),
        "filter.advanced": f"AREA[Phase]{n['phase']} AND AREA[LargeDocHasProtocol]true AND AREA[StartDate]RANGE[2010-01-01,{date_hi}]",
        "fields": "NCTId,BriefTitle,OfficialTitle,StartDate,InterventionName,InterventionOtherName,ArmGroupLabel,ArmGroupDescription,Phase,EligibilityCriteria,OverallStatus,LeadSponsorName",
    }
    try:
        studies = comparators._cached_search(params, 200)
    except Exception as e:
        raise RetrievalFailed(f"{type(e).__name__}: {e}") from e
    t_setting = set(n["setting"])
    t_hist = comparators._lung_histology(n["condition"].lower())
    excl = {str(x).upper() for x in exclude}
    cands = []
    dropped = Counter()
    for s in studies:
        nct = s["protocolSection"]["identificationModule"]["nctId"]
        if nct in excl:
            dropped["excluded"] += 1
            continue
        c_setting = comparators.setting_tags(s)
        if ("perioperative/locally-advanced" in c_setting) != ("perioperative/locally-advanced" in t_setting):
            dropped["setting"] += 1
            continue
        c_hist = comparators._lung_histology(comparators._conditions(s))
        if t_hist and c_hist and t_hist != c_hist:
            dropped["histology"] += 1
            continue
        c_classes = druglib.classes(comparators._registry_drugs(s))
        if not c_classes:
            dropped["no_recognized_drugs"] += 1
            continue
        jac = len(t_classes & c_classes) / len(t_classes | c_classes)
        cands.append((jac, nct))
    cands.sort(key=lambda x: (-x[0], x[1]))
    info = {"search_results": len(studies), "candidates": len(cands), "dropped": dict(dropped),
            "jaccard": {nct: round(j, 3) for j, nct in cands[: K * 5]}}
    return [nct for _, nct in cands[: K * 5]], info


def _analyze(nct: str) -> dict | None:
    from .extract import analyze_trial
    from .sources import fetch_study

    a = analyze_trial(nct)
    a.pop("_doc", None)
    if not [c for c in a["criteria"] if c["category"] == "lab"]:
        return None
    a["tags"] = set(comparators.setting_tags(fetch_study(nct)))
    return a


def _load_precedents(ids: list[str], budget_s: float, t0: float) -> tuple[list[dict], int, int]:
    workers = max(1, min(4, int(settings.env("DRAFT_WORKERS", "4") or 4)))
    out: list[dict] = []
    checked = skipped = 0
    for i in range(0, len(ids), workers):
        if len(out) >= K or time.monotonic() - t0 > budget_s:
            break
        batch = list(dict.fromkeys(ids[i: i + workers]))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(_analyze, n) for n in batch]
            results = []
            for f in futs:
                try:
                    results.append(f.result())
                except Exception:
                    results.append(None)
        for a in results:  # candidate order
            checked += 1
            if a is None:
                skipped += 1
                continue
            if len(out) < K:
                out.append(a)
    return out, checked, skipped


# ------------------------------------------------------------------ helpers

def _stricter_key(analyte: str, value: float) -> float:
    """Sort key: smaller is stricter."""
    if analyte in comparators.HIGHER_IS_STRICTER or analyte.startswith("washout"):
        return -value
    return value


def _fmtv(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


def _name(p: dict) -> str:
    return p["study"].get("acronym") or p["study"]["nct_id"]


def _crit_of(p: dict, cid: str) -> dict | None:
    return next((c for c in p["criteria"] if c["id"] == cid), None)


def _protocol_url(study: dict) -> str | None:
    docs = study.get("protocol_docs") or []
    return docs[0]["url"] if docs else None


def _relevant_passages(analyte: str, category: str) -> list:
    expected = verifier.GUIDANCE_FOR_CATEGORY.get(category)
    out = []
    for p in guidance.passages_for(analyte):
        if p.stance == "purpose" or p.guidance != expected:
            continue
        if p.key in ("wo_time_based_justified", "wo_parameters_not_time") and analyte not in review.TIME_BASED_PRIOR_THERAPY:
            continue
        out.append(p)
    return out


def _rewrite(s: str) -> str:
    s = s.replace("no value-specific rationale was found in the protocol", "the draft has no protocol rationale yet")
    s = re.sub(r"No protocol text found that explains why (.+?) was chosen \(searched outside the eligibility section\)\.",
               r"The draft has no protocol rationale yet for \1.", s)
    s = s.replace("Start from the protocol's own safety rationale and treatment arms, and document why",
                  "Start from the regimen's safety considerations, and document in the draft protocol why")
    s = s.replace("was chosen. Comparable trials used", "is chosen. Comparable trials used")
    s = s.replace("not evidence that a lower value is safe for this regimen", "not evidence about the safety of a lower value for this regimen")
    s = s.replace("This is a clinical review question, not a finding that the threshold is wrong.",
                  "This is a clinical review question for the draft.")
    s = s.replace("Keep the existing rationale documented.", "Document the rationale in the draft protocol.")
    return s


def verify_draft_criterion(dcrit: dict, claims: list[dict], precedents: list[dict], regimen: dict,
                           setting: list[str], as_of: str | None) -> dict:
    """Run the unchanged verifier on a synthetic context (target = the draft)."""
    ctx = {
        "target": {"study": {"nct_id": "DRAFT", "start_date": None}, "criteria": [dcrit],
                   "regimen": {"drugs": regimen, "arms": [], "unrecognized": []}, "tags": set(setting)},
        "comparators": precedents,
        "as_of": _as_of_cutoff(as_of),
    }
    rec = {"criterion_id": dcrit["id"], "action": "justify_in_protocol", "proposed_value": dcrit["value_norm"],
           "proposed_unit": dcrit["unit_norm"], "claims": claims, "text": dcrit["source"]["text"]}
    res = verifier.verify(rec, ctx, resolvers={"fda_quote": guidance.verify_quote})
    for c in res["checks"]:
        if c["check"] == "criterion_exists":
            c["detail"] = c["detail"].replace("(p.None)", "(draft)")
    return res


def _link(**kw) -> dict:
    """SourceLink without null keys (contracts.ts declares page and url optional, not nullable)."""
    return {k: v for k, v in kw.items() if v is not None}


def _fallback_categories(item: dict) -> list[dict]:
    cats: list[dict] = []
    purposes = item.get("purposes", [])
    safety = [p for p in purposes if p["purpose"] == "Safety" and p["status"] == "inferred"]
    if safety:
        cats.append({"key": "safety", "label": CATEGORY_LABELS["safety"], "status": "inferred",
                     "basis": safety[0]["basis"], "sources": [{"kind": "curated", "label": "Curated pharmacology table"}]})
    enr = [p for p in purposes if p["purpose"].startswith("Statistical design")
           or (p["purpose"] == "Predictive enrichment" and p["status"] == "possible (inferred)")]
    if enr:
        src = [_link(kind="fda", label=p["fda_context"]["citation"], url=p["fda_context"].get("link"))
               for p in enr if p.get("fda_context")]
        cats.append({"key": "enrichment", "label": CATEGORY_LABELS["enrichment"], "status": "inferred",
                     "basis": enr[0]["basis"], "sources": src})
    ev = item.get("evidence", [])
    comp = [e for e in ev if e["kind"] == "comparator" and e["stance"] in ("supports", "context")]
    fda = [e for e in ev if e["kind"] == "fda" and e["strength"] == "specific"]
    if comp or fda:
        src = [_link(kind="comparator", label=e["nct_id"], nct_id=e["nct_id"], page=e.get("page"), url=e.get("url"))
               for e in comp] + [_link(kind="fda", label=e["citation"], url=e.get("link")) for e in fda]
        basis = (f"{len(comp)} comparable precedent(s) used the same or a stricter threshold" if comp else
                 "FDA guidance makes a specific recommendation for this criterion type")
        cats.append({"key": "precedent", "label": CATEGORY_LABELS["precedent"], "status": "inferred",
                     "basis": basis + "; precedent is not proof that the value is right.", "sources": src})
    return cats


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from _strings(v)
    elif isinstance(o, (list, tuple)):
        for v in o:
            yield from _strings(v)


# ------------------------------------------------------------------ main entry

def _empty(norm: dict, did: str, status: str, t0: float, warnings: list[str], checked=0, skipped=0) -> dict:
    return {
        "schema_version": 1, "draft_id": did, "status": status,
        "idea": {k: norm[k] for k in ("condition", "drugs", "setting", "phase", "as_of", "recognized_drugs",
                                      "unrecognized_drugs", "classes")},
        "precedents": [], "criteria": [],
        "summary": {"drafted": 0, "insufficient": 0, "precedents": 0, "candidates_checked": checked,
                    "skipped": skipped, "elapsed_s": round(time.monotonic() - t0, 2), "cached": False},
        "notes": list(NOTES), "warnings": warnings, "exports": {"trialpathfinder_rules": None},
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def draft_criteria(idea: dict, fixed_precedents: list[dict] | None = None, exclude: tuple[str, ...] = ()) -> dict:
    t0 = time.monotonic()
    norm = normalize_idea(idea)
    did = draft_id_for(idea, exclude)
    warnings: list[str] = []
    if norm["unrecognized_drugs"]:
        warnings.append("Not in the curated drug table (not used for matching or toxicity links): "
                        + ", ".join(norm["unrecognized_drugs"]) + ".")
    if not norm["recognized_drugs"]:
        return _empty(norm, did, "unrecognized_regimen", t0, warnings)
    t_drugs = set(norm["recognized_drugs"])
    t_classes = druglib.classes(t_drugs)
    checked = skipped = 0
    jaccard: dict[str, float] = {}
    if fixed_precedents is None:
        budget = float(settings.env("DRAFT_BUDGET_S", "150") or 150)
        try:
            ids, info = discover_for_idea(norm, exclude)
        except RetrievalFailed as e:
            warnings.append(f"ClinicalTrials.gov not reachable: {e}")
            return _empty(norm, did, "retrieval_failed", t0, warnings)
        jaccard = info["jaccard"]
        precedents, checked, skipped = _load_precedents(ids, budget, t0)
        if time.monotonic() - t0 > budget and len(precedents) < K:
            warnings.append(f"Time budget of {budget:.0f} s reached after {checked} candidates; fewer precedents analyzed.")
    else:
        precedents = copy.deepcopy(fixed_precedents)
        excl = {str(x).upper() for x in exclude}
        precedents = [p for p in precedents if p["study"]["nct_id"] not in excl]
    for p in precedents:  # plan-v2 section 4 "Tags type": compare() needs sets
        p["tags"] = set(p.get("tags") or [])
    if not precedents:
        return _empty(norm, did, "no_precedents", t0, warnings, checked, skipped)

    regimen = _regimen(sorted(t_drugs))
    unrecognized = norm["unrecognized_drugs"]
    target = {"study": {"nct_id": "DRAFT", "start_date": None, "title": "Draft", "acronym": None},
              "criteria": [], "regimen": {"drugs": regimen, "arms": [], "unrecognized": unrecognized},
              "tags": set(norm["setting"])}

    ids_found: list[str] = []
    for p in precedents:
        for c in p["criteria"]:
            if c["id"] not in ids_found and c.get("value_norm") is not None:
                ids_found.append(c["id"])
    ids_found.sort(key=lambda i: (ORDER.index(i) if i in ORDER else len(ORDER), i))

    staged = []
    for cid in ids_found:
        rows = [(p, _crit_of(p, cid)) for p in precedents]
        rows = [(p, c) for p, c in rows if c is not None and c.get("value_norm") is not None]
        sample = rows[0][1]
        analyte, category = sample["analyte"], sample["category"]
        rel = druglib.LAB_RELEVANCE.get(analyte)
        pvals = []
        for p, c in rows:
            cov = comparators.coverage(analyte, t_drugs, set(p["regimen"]["drugs"]))
            eligible = cov["status"] == "full" or (cov["status"] == "n/a" and rel is None)
            pvals.append((p, c, cov, eligible))
        dist: dict[tuple, list[str]] = {}
        for p, c, _, _ in pvals:
            dist.setdefault((c["operator"], c["value_norm"], c["unit_norm"]), []).append(p["study"]["nct_id"])
        distribution = [{"operator": o, "value": v, "unit": u, "count": len(n), "nct_ids": n}
                        for (o, v, u), n in sorted(dist.items(), key=lambda kv: (-len(kv[1]), _stricter_key(analyte, kv[0][1])))]
        elig = [(p, c) for p, c, _, e in pvals if e]
        default = None
        tie = False
        reason = None
        if elig:
            counts = Counter((c["value_norm"], c["unit_norm"]) for _, c in elig)
            best = max(counts.values())
            top = [vu for vu, n in counts.items() if n == best]
            tie = len(top) > 1
            top.sort(key=lambda vu: _stricter_key(analyte, vu[0]))
            mode_v, mode_u = top[0]
            src_p, src_c = next((p, c) for p, c in elig if (c["value_norm"], c["unit_norm"]) == (mode_v, mode_u))
            default = (src_p, src_c, mode_v, mode_u)
        elif rel and not druglib.drugs_with(t_drugs, rel[0]):
            reason = (f"The idea's regimen has no agent flagged for {rel[1]} in the curated table, so no regimen-matched "
                      "precedent can supply a value.")
        else:
            reason = "No precedent's regimen covers the idea's agents for this criterion, so none is eligible to supply a value."
        staged.append({"cid": cid, "analyte": analyte, "category": category, "rel": rel, "pvals": pvals,
                       "distribution": distribution, "elig": elig, "default": default, "tie": tie, "reason": reason})

    # draft criteria (for compare/critique) use the default when present, else the most common value
    for s in staged:
        if s["default"]:
            src_p, src_c, v, u = s["default"]
            base = src_c
        else:
            d0 = s["distribution"][0]
            base = next(c for _, c, _, _ in s["pvals"] if (c["operator"], c["value_norm"], c["unit_norm"]) == (d0["operator"], d0["value"], d0["unit"]))
            v, u = base["value_norm"], base["unit_norm"]
        text = f"{base['label']} {base['operator']}{_fmtv(v)} {u}"
        s["dcrit"] = {"id": s["cid"], "analyte": s["analyte"], "category": s["category"], "label": base["label"],
                      "section": base["section"], "operator": base["operator"], "value": v, "unit": u,
                      "value_norm": v, "unit_norm": u, "conditions": copy.deepcopy(base.get("conditions") or []),
                      "exceptions": [], "source": {"doc": "draft", "url": None, "page": None, "line": None, "text": text},
                      "item_text": text, "method": "draft (copied from precedent)"}
        target["criteria"].append(s["dcrit"])
    table = comparators.compare(target, precedents)
    review_ctx = {"target": target, "comparators": precedents, "comparison": table}

    criteria_out = []
    for s in staged:
        dcrit, analyte, rel = s["dcrit"], s["analyte"], s["rel"]
        why: list[str] = []
        verification = None
        status = "insufficient_evidence"
        insufficient_reason = s["reason"]
        proposed = None
        passages = _relevant_passages(analyte, s["category"])
        agents = druglib.drugs_with(t_drugs, rel[0]) if rel else []
        if s["default"]:
            src_p, src_c, v, u = s["default"]
            cited = [(p, c) for p, c in s["elig"] if (c["value_norm"], c["unit_norm"]) == (v, u)]
            op_ok = all(c["operator"] == src_c["operator"] and c["unit_norm"] == src_c["unit_norm"] for _, c in cited)
            claims = [{"type": "comparator_threshold", "nct_id": p["study"]["nct_id"], "value": v, "unit": u} for p, _ in cited]
            claims += [{"type": "fda_quote", "guidance": p.guidance, "quote": p.quote} for p in passages]
            claims += [{"type": "drug_property", "drug": a, "property": rel[0], "value": True} for a in agents]
            verification = verify_draft_criterion(dcrit, claims, precedents, regimen, norm["setting"], norm["as_of"])
            n_cv = sum(1 for c in verification["checks"] if c["check"] == "comparator_value" and c["result"] == "pass")
            if not op_ok:
                ops = sorted({c["operator"] for _, c in cited})
                insufficient_reason = (f"Precedents with {_fmtv(v)} {u} state it with different operators ({', '.join(ops)}); "
                                       "the draft-side operator check failed.")
            elif verification["status"] == "REJECTED":
                insufficient_reason = "The verifier rejected the proposed value: " + "; ".join(
                    c["detail"] for c in verification["checks"] if c["result"] == "fail")
            elif n_cv < 1:
                insufficient_reason = "No precedent threshold was verified against its protocol."
            else:
                status = "drafted"
                insufficient_reason = None
                proposed = {"operator": src_c["operator"], "value": v, "unit": u, "text": dcrit["source"]["text"],
                            "source_nct_id": src_p["study"]["nct_id"]}
                names = ", ".join(_name(p) for p, _ in cited)
                why.append(f"Value: {len(cited)} of {len(s['elig'])} regimen-matched precedents used "
                           f"{src_c['operator']}{_fmtv(v)} {u} ({names}); copied from {_name(src_p)}.")
                if s["tie"]:
                    why.append("Ties go to the stricter value.")
        if not rel:
            why.append("No regimen-specific toxicity link; precedents matched on condition, setting and drug class.")
        elif agents:
            why.append(f"Safety link: the regimen includes {', '.join(agents)} ({rel[1]}); this supports having a threshold, not this value.")
        carry = len(s["pvals"]) >= 2 and len(s["distribution"]) == 1
        if carry:
            why.append("All precedents agree; agreement may reflect template carry-forward.")
        fda_ok = set()
        if verification:
            fda_ok = {i for i, c in enumerate([c for c in verification["checks"] if c["check"] == "fda_quote"]) if c["result"] == "pass"}
        fda_out = []
        fda_why: list = []
        for i, p in enumerate(passages):
            d = p.to_dict()
            fda_out.append({"key": p.key, "quote": p.quote, "citation": d["citation"], "link": d["link"],
                            "stance": p.stance, "specific": p.key in review.SPECIFIC_FDA})
            if status == "drafted" and i in fda_ok:
                fda_why.append((p.key not in review.SPECIFIC_FDA, f"FDA: {d['citation']}."))

        why.extend(t for _, t in sorted(fda_why, key=lambda x: x[0])[:2])
        # self-critique with the unchanged review engine (doc=None, no eligibility pages)
        item = review.review_criterion(dcrit, target, table[dcrit["id"]], None, set())
        if status == "drafted":
            critique = {"classification": item["classification"], "explanation": _rewrite(item["explanation"]),
                        "scores": item["scores"], "missing_evidence": [_rewrite(m) for m in item["missing_evidence"]],
                        "suggested_action": {"action": item["suggested_action"]["action"],
                                             "text": _rewrite(item["suggested_action"]["text"])}}
        else:
            critique = {"classification": review.CLASS_INSUFFICIENT,
                        "explanation": f"{review.CLASS_INSUFFICIENT}: no value was proposed; {insufficient_reason}",
                        "scores": {"support": 0, "challenge": 0}, "missing_evidence": [insufficient_reason],
                        "suggested_action": {"action": "justify_in_protocol",
                                             "text": "Gather regimen-matched precedent or document a rationale before adding this criterion."}}
        expl = critique["explanation"]
        prefix = critique["classification"] + ": "
        if expl.startswith(prefix):
            expl = expl[len(prefix):]
        why.append(f"Self-critique: {DISPLAY_CLASSIFICATION[critique['classification']]}: {expl.rstrip('.')}.")

        if _categories is not None:
            try:
                cats = _categories(item, review_ctx)
            except Exception:
                cats = _fallback_categories(item)
        else:
            cats = _fallback_categories(item)
        if status != "drafted":  # the precedent basis describes a value that was never proposed
            cats = [c for c in cats if c["key"] != "precedent"]

        prec_vals = []
        default_op = s["default"][1]["operator"] if s["default"] else None
        default_u = s["default"][3] if s["default"] else None
        for p, c, cov, e in s["pvals"]:
            prec_vals.append({"nct_id": p["study"]["nct_id"], "acronym": p["study"].get("acronym"), "operator": c["operator"],
                              "value": c["value_norm"], "unit": c["unit_norm"], "page": c["source"].get("page"),
                              "quote": c["source"].get("text", ""), "url": c["source"].get("url"), "coverage": cov["status"],
                              "eligible_for_default": bool(e and c["operator"] == default_op and c["unit_norm"] == default_u)})
        criteria_out.append({
            "id": dcrit["id"], "analyte": analyte, "category": s["category"], "label": dcrit["label"],
            "section": dcrit["section"], "status": status, "proposed": proposed, "distribution": s["distribution"],
            "rationale": {"categories": cats, "precedents": prec_vals, "fda": fda_out,
                          "toxicity_link": ({"agents": agents, "property": rel[1],
                                             "text": f"The regimen includes {', '.join(agents)} ({rel[1]}); this supports having a threshold, not a specific value."}
                                            if rel and agents else None),
                          "carry_forward": carry},
            "verification": verification, "critique": critique, "why_generated": why,
            "insufficient_reason": insufficient_reason,
        })

    prec_out = []
    for p in precedents:
        c_classes = druglib.classes(p["regimen"]["drugs"])
        nct = p["study"]["nct_id"]
        prec_out.append({
            "nct_id": nct, "acronym": p["study"].get("acronym"), "title": p["study"].get("title") or "",
            "sponsor": p["study"].get("sponsor"), "start_date": p["study"].get("start_date"),
            "regimen": sorted(p["regimen"]["drugs"]), "shared_classes": sorted(t_classes & c_classes),
            "class_jaccard": jaccard.get(nct, round(len(t_classes & c_classes) / len(t_classes | c_classes), 3) if c_classes else 0.0),
            "tags": sorted(p["tags"]), "protocol_url": _protocol_url(p["study"]),
        })
    out = _empty(norm, did, "ok", t0, warnings, checked, skipped)
    out["precedents"] = prec_out
    out["criteria"] = criteria_out
    out["summary"].update({"drafted": sum(1 for c in criteria_out if c["status"] == "drafted"),
                           "insufficient": sum(1 for c in criteria_out if c["status"] == "insufficient_evidence"),
                           "precedents": len(prec_out), "elapsed_s": round(time.monotonic() - t0, 2)})
    out["exports"]["trialpathfinder_rules"] = to_trialpathfinder(criteria_out)
    bad = [s for s in _strings({"c": criteria_out, "n": out["notes"]}) if verifier.OVERCLAIM.search(s)]
    if bad:
        out["warnings"].append(f"Overclaim filter flagged {len(bad)} string(s); review before use.")
    return out


def to_trialpathfinder(criteria: list[dict]) -> str:
    """Plain-text rule list in the spirit of TrialPathfinder's criteria lines. Never parsed or executed."""
    lines = ["# ProtocolOS draft criteria (plain text; suggestions, the team decides)"]
    for c in criteria:
        if c["status"] != "drafted":
            lines.append(f"# {c['section']}: {c['label']}: Insufficient evidence (no value proposed)")
            continue
        p = c["proposed"]
        lines.append(f"{c['section']}: {c['id']} {p['operator']} {_fmtv(p['value'])} {p['unit']}  # from {p['source_nct_id']}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------ cache, lock, public cap

_COLD_LOCK = threading.Lock()
_COLD_COUNT = 0


class ColdCapReached(Exception):
    pass


def cached(draft_id: str) -> dict | None:
    if not DRAFT_ID_RE.match(draft_id):
        return None
    p = DRAFTS_DIR / f"{draft_id}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    d["summary"]["cached"] = True
    return d


def _write(d: dict) -> None:
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    p = DRAFTS_DIR / f"{d['draft_id']}.json"
    tmp = p.with_suffix(f".tmp{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(json.dumps(d, default=lambda o: sorted(o) if isinstance(o, set) else str(o)))
    os.replace(tmp, p)


def _cap() -> int | None:
    v = settings.env("MAX_COLD_DRAFTS")
    if v is not None:
        return int(v)
    return 10 if settings.flag("PUBLIC") else None


def get_or_draft(idea: dict, exclude=(), preset: bool = False) -> dict:
    """Cached draft, or a new one under the cold lock. Raises ColdCapReached (public cap, presets exempt)."""
    global _COLD_COUNT
    did = draft_id_for(idea, exclude)
    hit = cached(did)
    if hit:
        return hit
    cap = _cap()
    if not preset and settings.flag("PUBLIC") and cap is not None and _COLD_COUNT >= cap:
        raise ColdCapReached()
    with _COLD_LOCK:
        hit = cached(did)
        if hit:
            return hit
        if not preset and settings.flag("PUBLIC") and cap is not None and _COLD_COUNT >= cap:
            raise ColdCapReached()
        d = draft_criteria(idea, exclude=tuple(exclude))
        if d["status"] == "retrieval_failed":  # never cached and never counted: an outage must not use up the cap
            return d
        _write(d)
        if not preset and d["status"] != "unrecognized_regimen":  # a slot is counted only when a search ran
            _COLD_COUNT += 1
        return d


def preset_for(idea: dict) -> str | None:
    n = normalize_idea(idea)
    for pid, p in PRESETS.items():
        if draft_id_for(p["idea"]) == draft_id_for(n):
            return pid
    return None
