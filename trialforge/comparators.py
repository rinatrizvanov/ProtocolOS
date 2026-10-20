"""Find clinically comparable trials and diff their eligibility thresholds.

Comparators are discovered from ClinicalTrials.gov (same condition, phase 3, overlapping
drug classes, protocol PDF available, started before the target in "as-of" mode), ranked
by drug-class overlap, then their protocols are run through the same extractor.

With PROTOCOLOS_SEMANTIC_COMPARATORS=1 the trials nearest to the target in the semantic index
(trial_index.py) are added as candidates. They pass the same rules plus stricter ones the keyword
query implies (_semantic_mismatch): a shared drug class, a shared cancer site, the same lung histology
and breast subtype, no later-line, maintenance or radiotherapy programme for a target that is not one.
Similarity itself never ranks them. Each candidate records how it was found (`found_by`).
"""
from __future__ import annotations

import hashlib
import json
import re

from . import druglib
from .extract import analyze_trial
from .settings import flag
from .sources import DATA, search_studies

SEARCH_CACHE = DATA / "search_cache"

# For ≥ criteria a higher value is stricter; for ≤ criteria a lower value is stricter.
HIGHER_IS_STRICTER = {"hemoglobin", "anc", "platelets", "renal"}
LOWER_IS_STRICTER = {"bilirubin", "ast_alt", "ecog"}
# washouts: a longer required interval is stricter
SIMILAR_TOLERANCE = 0.10  # values within 10% are reported as "similar", not stricter/looser
SEMANTIC_K = 30  # nearest trials taken from the semantic index as extra candidates
# Cancer sites for the semantic candidates' same-disease rule, matched in conditions and titles.
SITES = {
    "lung": r"lung|nsclc|sclc|bronch", "breast": r"breast",
    "gastroesophageal": r"gastric|stomach|gastro-?o?esophageal|o?esophag", "colorectal": r"colorectal|colon|rect(al|um)",
    "liver": r"hepatocellular|liver|\bhcc\b", "biliary": r"biliary|cholangio|gallbladder", "pancreas": r"pancrea",
    "kidney": r"renal cell|kidney|\brcc\b", "urothelial": r"urothelial|bladder", "prostate": r"prostat",
    "ovary": r"ovar|fallopian|primary peritoneal", "uterus": r"endometri|uterine", "cervix": r"cervical cancer|cervix",
    "head and neck": r"head and neck|hnscc|oropharyn|laryn|nasopharyn|oral cavity", "melanoma": r"melanoma",
    "lymphoma": r"lymphoma", "leukemia": r"leuka?emia", "myeloma": r"myeloma", "brain": r"glioma|glioblastoma",
    "sarcoma": r"sarcoma|\bgist\b", "mesothelioma": r"mesothelioma", "thyroid": r"thyroid",
}


def _cached_search(params: dict, max_results: int) -> list[dict]:
    SEARCH_CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(json.dumps([params, max_results], sort_keys=True).encode()).hexdigest()[:16]
    p = SEARCH_CACHE / f"{key}.json"
    if p.exists():
        return json.loads(p.read_text())
    res = search_studies(params, max_results)
    p.write_text(json.dumps(res))
    return res


def _registry_drugs(study: dict) -> set[str]:
    am = study["protocolSection"].get("armsInterventionsModule", {})
    text = " ".join(
        [i.get("name", "") + " " + " ".join(i.get("otherNames", []) or []) for i in am.get("interventions", [])]
        + [a.get("label", "") + " " + a.get("description", "") for a in am.get("armGroups", [])]
        + [study["protocolSection"]["identificationModule"].get("briefTitle", "")]
    )
    return set(druglib.find_drugs(text))


def setting_tags(study: dict) -> set[str]:
    ps = study["protocolSection"]
    text = " ".join(
        [ps["identificationModule"].get("briefTitle", ""), ps["identificationModule"].get("officialTitle", "") or "",
         ps.get("eligibilityModule", {}).get("eligibilityCriteria", "")[:3000]]
    ).lower()
    tags = set()
    if re.search(r"first[- ]line|1l\b|previously untreated|treatment[- ]na[iï]ve|not received prior systemic|no prior systemic", text):
        tags.add("first-line")
    if re.search(r"non[- ]?squamous|nonsquamous", text):
        tags.add("non-squamous")
    if re.search(r"(?<!non-)(?<!non)(?<!non )squamous", text):
        tags.add("squamous")
    if re.search(r"stage iv|metastatic", text):
        tags.add("metastatic")
    title = (ps["identificationModule"].get("briefTitle", "") + " " + (ps["identificationModule"].get("officialTitle", "") or "")).lower()
    if re.search(r"neoadjuvant|adjuvant|resectable|resected|perioperative|consolidation|chemoradiation|unresectable stage iii", title):
        tags.add("perioperative/locally-advanced")
    return tags


def _conditions(study: dict) -> str:
    ps = study["protocolSection"]
    return " ".join(ps.get("conditionsModule", {}).get("conditions", []) + [ps["identificationModule"].get("briefTitle", "")]).lower()


def _lung_histology(text: str) -> str | None:
    if re.search(r"non[- ]?small[- ]cell|nsclc", text):
        return "NSCLC"
    if re.search(r"small[- ]cell lung|\bsclc\b|small cell carcinoma", text):
        return "SCLC"
    return None


def sites(text: str) -> set[str]:
    return {site for site, rx in SITES.items() if re.search(rx, text)}


LATER_LINE = (r"second[- ]line|previously treated|pretreated|after (?:failure|progression)|has progressed|"
              r"progressed (?:on|with|after|following)|previous [a-z ]*therapy|refractory|relapsed|maintenance")
RADIOTHERAPY = r"radiation|radiotherapy|chemoradi"
BREAST_SUBTYPES = {"triple-negative": r"triple[- ]negative|\btnbc\b", "HER2-positive": r"her2[- ]?(?:positive|\+)",
                   "HR-positive": r"hormone receptor[- ]positive|\bhr\+|er[- ]positive"}


def _strict_lung_histology(text: str) -> str | None:
    return _lung_histology(text) or ("NSCLC" if re.search(r"squamous cell (?:lung|carcinoma of the lung)|lung (?:squamous|adenocarcinoma)", text) else None)


def _semantic_mismatch(t_title: str, t_conditions: str, s: dict) -> bool:
    """True when a semantic candidate is a different disease or setting than the target (title and conditions)."""
    c_title = (s["protocolSection"]["identificationModule"].get("briefTitle", "") + " "
               + (s["protocolSection"]["identificationModule"].get("officialTitle", "") or "")).lower()
    c_conditions = _conditions(s)
    if not sites(t_conditions) & sites(c_conditions):
        return True
    t_hist, c_hist = _strict_lung_histology(t_conditions), _strict_lung_histology(c_conditions)
    if t_hist and c_hist and t_hist != c_hist:
        return True
    t_sub = {k for k, rx in BREAST_SUBTYPES.items() if re.search(rx, t_title + " " + t_conditions)}
    c_sub = {k for k, rx in BREAST_SUBTYPES.items() if re.search(rx, c_title + " " + c_conditions)}
    if t_sub and c_sub and not t_sub & c_sub:
        return True
    return any(re.search(rx, c_title) and not re.search(rx, t_title) for rx in (LATER_LINE, RADIOTHERAPY))


def _semantic_candidates(nct: str, t_full: dict, date_hi: str) -> list[dict]:
    """Registry records of the trials nearest to the target in the semantic index, when the setting is on."""
    if not flag("SEMANTIC_COMPARATORS"):
        return []
    from . import trial_index
    from .sources import fetch_study

    hits = trial_index.similar(nct, trial_index.record(t_full)["text"], k=SEMANTIC_K, until=date_hi)
    return [fetch_study(h["nct_id"]) for h in hits]


def discover(target: dict, k: int = 4, as_of: str | None = None) -> list[dict]:
    """Rank candidate comparators by drug-class Jaccard similarity (registry-level)."""
    tstudy = target["study"]
    t_drugs = set(target["regimen"]["drugs"])
    t_classes = druglib.classes(t_drugs)
    names = sorted({d.name for d in druglib.DRUGS if d.drug_class in t_classes and d.immunotherapy}) or sorted(t_drugs)
    cond = (tstudy["conditions"] or [""])[0]
    date_hi = as_of or "2099-12-31"
    params = {
        "query.cond": cond,
        "query.intr": " OR ".join(names),
        "filter.advanced": f"AREA[Phase]PHASE3 AND AREA[LargeDocHasProtocol]true AND AREA[StartDate]RANGE[2010-01-01,{date_hi}]",
        "fields": "NCTId,BriefTitle,OfficialTitle,StartDate,InterventionName,InterventionOtherName,ArmGroupLabel,ArmGroupDescription,Phase,EligibilityCriteria,OverallStatus,LeadSponsorName",
    }
    from .sources import fetch_study

    t_full = fetch_study(tstudy["nct_id"])
    t_setting = setting_tags(t_full)
    target_conditions = _conditions(t_full)
    t_ident = t_full["protocolSection"]["identificationModule"]
    target_title = (t_ident.get("briefTitle", "") + " " + (t_ident.get("officialTitle", "") or "")).lower()
    cands, seen = [], set()
    found = [(s, "keyword") for s in _cached_search(params, 200)]
    found += [(s, "semantic") for s in _semantic_candidates(tstudy["nct_id"], t_full, date_hi)]
    for s, found_by in found:
        nct = s["protocolSection"]["identificationModule"]["nctId"]
        if nct == tstudy["nct_id"] or nct in seen:
            continue
        seen.add(nct)
        # a metastatic-setting target is not compared with perioperative / stage III programs
        c_setting = setting_tags(s)
        if ("perioperative/locally-advanced" in c_setting) != ("perioperative/locally-advanced" in t_setting):
            continue
        # "small cell lung" registry searches also match "non-small cell lung": different diseases
        if _lung_histology(target_conditions) and _lung_histology(_conditions(s)) and _lung_histology(target_conditions) != _lung_histology(_conditions(s)):
            continue
        c_classes = druglib.classes(_registry_drugs(s))
        if not c_classes:
            continue
        jac = len(t_classes & c_classes) / len(t_classes | c_classes)
        if found_by == "semantic" and (not jac or _semantic_mismatch(target_title, target_conditions, s)):
            continue
        cands.append((jac, nct, found_by))
    cands.sort(key=lambda x: (-x[0], x[1]))
    return [{"nct_id": n, "registry_similarity": round(j, 3), "found_by": f} for j, n, f in cands[: k * 3]]


def coverage(analyte: str, target_drugs: set[str], comp_drugs: set[str]) -> dict:
    rel = druglib.LAB_RELEVANCE.get(analyte)
    if not rel:
        return {"status": "n/a", "detail": "no regimen-specific toxicity link for this criterion"}
    prop, why = rel
    t = {druglib.BY_NAME[d].drug_class for d in druglib.drugs_with(target_drugs, prop)}
    c = {druglib.BY_NAME[d].drug_class for d in druglib.drugs_with(comp_drugs, prop)}
    if not t:
        return {"status": "n/a", "detail": f"target regimen has no agent flagged for {why}"}
    missing = sorted(t - c)
    status = "full" if not missing else ("partial" if t & c else "none")
    return {
        "status": status,
        "relevant_property": why,
        "target_classes": sorted(t),
        "comparator_classes": sorted(c),
        "missing_classes": missing,
        "extra_classes": sorted(c - t),
    }


def direction(analyte: str, target_val: float, comp_val: float) -> str:
    if target_val == comp_val or (max(target_val, comp_val) > 0 and abs(target_val - comp_val) / max(target_val, comp_val) <= SIMILAR_TOLERANCE and analyte.startswith("washout")):
        return "same"
    if analyte in HIGHER_IS_STRICTER or analyte.startswith("washout"):
        return "comparator looser" if comp_val < target_val else "comparator stricter"
    if analyte in LOWER_IS_STRICTER:
        return "comparator looser" if comp_val > target_val else "comparator stricter"
    return "different"


def renal_measure(c: dict) -> str:
    return "GFR" if re.search(r"GFR|glomerular", c["label"] + c["source"]["text"], re.I) else "CrCl"


def compare(target: dict, comparators: list[dict]) -> dict:
    """Per-analyte side-by-side table with direction and regimen coverage."""
    t_drugs = set(target["regimen"]["drugs"])
    t_tags = setting_tags_from(target)
    table: dict[str, list] = {}
    for crit in target["criteria"]:
        rows = []
        for comp in comparators:
            c_drugs = set(comp["regimen"]["drugs"])
            match = next((c for c in comp["criteria"] if c["id"] == crit["id"]), None)
            row = {
                "nct_id": comp["study"]["nct_id"],
                "acronym": comp["study"].get("acronym"),
                "title": comp["study"]["title"],
                "sponsor": comp["study"]["sponsor"],
                "start_date": comp["study"]["start_date"],
                "status": comp["study"]["status"],
                "enrollment": comp["study"]["enrollment"],
                "regimen": sorted(c_drugs),
                "coverage": coverage(crit["analyte"], t_drugs, c_drugs),
                "shared_setting": sorted(t_tags & comp.get("tags", set())),
                "criterion": match,
            }
            if match is None:
                row["direction"] = "not found"
            elif crit["analyte"] == "renal" and renal_measure(crit) != renal_measure(match):
                row["direction"] = "different measure"
            else:
                row["direction"] = direction(crit["analyte"], crit["value_norm"], match["value_norm"])
            rows.append(row)
        table[crit["id"]] = rows
    return table


def setting_tags_from(analysis: dict) -> set[str]:
    return analysis.get("tags", set())


def load_comparators(target: dict, k: int = 4, as_of: str | None = None, fixed: list[str] | None = None) -> list[dict]:
    """Analyze the top-k comparators that yield extractable criteria."""
    found = [] if fixed else discover(target, k, as_of)
    ids = fixed or [c["nct_id"] for c in found]
    sims = {c["nct_id"]: c for c in found}
    t_classes = druglib.classes(target["regimen"]["drugs"])
    out = []
    for nct in ids:
        try:
            a = analyze_trial(nct)
        except Exception:
            continue
        labs = [c for c in a["criteria"] if c["category"] == "lab"]
        if not labs:
            continue
        a.pop("_doc", None)
        from .sources import fetch_study

        a["tags"] = setting_tags(fetch_study(nct))
        c_classes = druglib.classes(a["regimen"]["drugs"])
        a["similarity"] = {
            "registry_jaccard": sims.get(nct, {}).get("registry_similarity"),
            "found_by": sims.get(nct, {}).get("found_by", "fixed"),
            "protocol_class_jaccard": round(len(t_classes & c_classes) / len(t_classes | c_classes), 3) if c_classes else 0.0,
            "shared_classes": sorted(t_classes & c_classes),
            "target_only_classes": sorted(t_classes - c_classes),
            "comparator_only_classes": sorted(c_classes - t_classes),
        }
        out.append(a)
        if len(out) >= k:
            break
    out.sort(key=lambda a: -a["similarity"]["protocol_class_jaccard"])
    return out
