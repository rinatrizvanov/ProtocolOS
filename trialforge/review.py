"""Evidence assembly and review classification for each extracted criterion.

Classification is a transparent, deterministic rule over evidence items so every flag can be
explained and tested. Evidence items carry a stance (supports retaining / challenges / context)
and a strength, and the explanation lists what evidence is missing.

Key guardrails:
- A regimen with relevant toxicity supports having *a* threshold, never a specific value.
- A more permissive comparator shows a looser threshold was used, not that it was safe.
- Agreement among comparators may reflect template carry-forward (FDA lab guidance §II).
"""
from __future__ import annotations

import re

from . import druglib
from .comparators import compare, load_comparators
from .extract import analyze_trial
from .guidance import passages_for

CLASS_REVIEW = "Review recommended"
CLASS_RETAIN = "Evidence supports retaining"
CLASS_INSUFFICIENT = "Insufficient evidence"

TOPIC_TERMS = {
    "hemoglobin": r"anemia|anaemia|hemoglobin|haemoglobin",
    "anc": r"neutropeni|neutrophil",
    "platelets": r"thrombocytopeni|platelet",
    "bilirubin": r"hepatotox|hepatic impairment|bilirubin|liver function",
    "ast_alt": r"hepatotox|hepatitis|transaminase|hepatic impairment",
    "renal": r"renal impairment|nephrotox|creatinine clearance|renal function",
    "ecog": r"performance status",
    "washout_corticosteroid": r"corticosteroid|steroid",
    "washout_investigational": r"half-li[fv]e|washout",
}

# Evidence hierarchy shown to reviewers. Nothing in the deterministic engine is "model inference";
# that tier is used only for LLM critic output.
TIERS = {
    "protocol": "Direct protocol evidence",
    "comparator": "Peer-trial precedent",
    "fda": "Regulatory guidance",
    "regimen": "Curated pharmacology (rule-based inference)",
    "model": "Model inference",
}

# Likely scientific purpose of each criterion type. These are INFERRED by ProtocolOS from the criterion
# type and the regimen; the FDA passage key (when present) shows FDA describing this kind of exclusion,
# not this protocol's intent.
PURPOSE_RULES = {
    "hemoglobin": [("Safety", "myelosuppressive", "Protects patients from treatment-related anemia when arms include myelosuppressive agents."),
                   ("Statistical design (tolerability / heterogeneity)", None, "Excluding patients unlikely to tolerate treatment reduces discontinuations and non-drug variability.", "enr_unlikely_tolerate")],
    "anc": [("Safety", "myelosuppressive", "Protects patients from neutropenia and infection when arms include myelosuppressive agents."),
            ("Statistical design (tolerability / heterogeneity)", None, "Excluding patients unlikely to tolerate treatment reduces discontinuations.", "enr_unlikely_tolerate")],
    "platelets": [("Safety", "myelosuppressive", "Protects patients from thrombocytopenia and bleeding with myelosuppressive agents."),
                  ("Statistical design (tolerability / heterogeneity)", None, "Excluding patients unlikely to tolerate treatment.", "enr_unlikely_tolerate")],
    "bilirubin": [("Safety", "hepatic", "Hepatic function for agents with hepatic metabolism or hepatotoxicity."),
                  ("Statistical design (interpretability)", None, "Baseline liver abnormalities can confound attribution of hepatic adverse events.")],
    "ast_alt": [("Safety", "hepatic", "Hepatic function for agents with hepatic metabolism or hepatotoxicity (including immune-mediated hepatitis)."),
                ("Statistical design (interpretability)", None, "Baseline transaminase elevations can confound attribution of hepatic adverse events.")],
    "renal": [("Safety", "renal", "Renal function for renally cleared or nephrotoxic agents (e.g. platinum, pemetrexed).")],
    "ecog": [("Safety", None, "Patients with poorer performance status may tolerate treatment less well."),
             ("Statistical design (heterogeneity / completion)", None, "Restricting to PS 0–1 reduces variability and early non-drug-related discontinuation.", "enr_comorbid_completion")],
    "washout_corticosteroid": [("Statistical design (interpretability / predictive)", "immunotherapy", "Systemic immunosuppression may blunt checkpoint-inhibitor activity, making efficacy harder to detect.", "enr_interacting_drugs"),
                               ("Safety", None, "Conditions requiring high-dose steroids (e.g. active autoimmune disease) may carry immune-related risk.")],
    "washout_investigational": [("Safety", None, "Avoids overlapping toxicity from another investigational agent."),
                                ("Statistical design (interpretability)", None, "Avoids attributing effects of a prior investigational agent to the study drug.", "enr_interacting_drugs")],
    "washout_immunomodulator": [("Safety", None, "Avoids overlapping immune-related toxicity."),
                                ("Statistical design (interpretability)", None, "Avoids carry-over of prior immunomodulator effects.", "enr_interacting_drugs")],
    "washout_radiotherapy": [("Safety", None, "Avoids overlapping toxicity such as pneumonitis.")],
    "washout_surgery": [("Safety", None, "Allows recovery and wound healing before systemic therapy.")],
    "washout_vaccine": [("Safety", "immunotherapy", "Live vaccines with immunomodulating therapy may pose infection or immune risk.")],
}


def infer_purposes(crit: dict, drugs: set[str]) -> list[dict]:
    from .guidance import load_passages

    passages = {p.key: p for p in load_passages()[0]}
    out = []
    for rule in PURPOSE_RULES.get(crit["analyte"], []):
        purpose, needs_prop, basis = rule[0], rule[1], rule[2]
        pkey = rule[3] if len(rule) > 3 else None
        if needs_prop:
            relevant = druglib.drugs_with(drugs, needs_prop)
            if not relevant:
                continue
            basis = f"{basis} Relevant agents: {', '.join(relevant)}."
        item = {"purpose": purpose, "status": "inferred", "basis": basis}
        if pkey and pkey in passages:
            d = passages[pkey].to_dict()
            item["fda_context"] = {"quote": d["quote"], "citation": d["citation"], "link": d["link"],
                                   "note": "FDA describes this kind of exclusion; this does not establish the protocol's intent."}
        out.append(item)
    if not out:
        out.append({"purpose": "Unknown", "status": "inferred", "basis": "No purpose rule for this criterion type."})
    out.append({"purpose": "Predictive enrichment", "status": "not indicated",
                "basis": "Predictive enrichment usually uses biomarker or disease characteristics; this criterion type is not typically used that way."}
               if crit["analyte"] != "washout_corticosteroid" else
               {"purpose": "Predictive enrichment", "status": "possible (inferred)", "basis": "See interpretability entry above."})
    return out


SPECIFIC_FDA = {"lab_duffy_broaden", "ps_include_ps2", "ps_later_phase", "wo_time_based_justified", "wo_parameters_not_time"}
TIME_BASED_PRIOR_THERAPY = {"washout_investigational", "washout_immunomodulator", "washout_radiotherapy"}


def _fmt(c: dict) -> str:
    v = c["value_norm"]
    v = int(v) if v is not None and float(v).is_integer() else v
    return f"{c['operator']}{v} {c['unit_norm']}"


def protocol_rationale(doc, crit: dict, elig_pages: set[int]) -> list[dict]:
    """Sentences outside the eligibility section that mention the criterion's topic."""
    pat = TOPIC_TERMS.get(crit["analyte"])
    if not doc or not pat:
        return []
    val = crit["value_norm"]
    val_s = (str(int(val)) if float(val).is_integer() else str(val)) if val is not None else None
    hits = []
    for pno, page in enumerate(doc.pages, start=1):
        if pno in elig_pages:
            continue
        flat = re.sub(r"\s+", " ", page)
        for m in re.finditer(pat, flat, re.I):
            s0 = max(flat.rfind(". ", 0, m.start()) + 2, m.start() - 260)
            e0 = flat.find(". ", m.end())
            e0 = len(flat) if e0 == -1 else min(e0 + 1, m.end() + 260)
            sent = flat[s0:e0].strip()
            # skip tables of contents, schedules and dose-limiting-toxicity definitions (not eligibility rationale)
            if len(sent) < 40 or re.search(r"\.{5,}|Schedule of|Table \d+\s*$|\bDLTs?\b|dose[- ]limiting", sent, re.I):
                continue
            # value-specific = the threshold value appears within the same clause as the topic term AND
            # the clause is about entry/eligibility AND gives a reason. Deliberately strict: a false
            # "rationale found" would wrongly support retaining a criterion.
            value_specific = False
            reasoning = bool(re.search(r"because|due to|risk|rationale|in order to|to ensure|higher|increase|toxicit|safety", sent, re.I))
            if val_s:
                for vm in re.finditer(rf"(?<![\d.]){re.escape(val_s)}(?:\.0)?\s*(g/dL|×|x\s|mL|days?|weeks?)", sent):
                    window = sent[max(0, vm.start() - 90): vm.end() + 90]
                    if (re.search(pat, window, re.I) and reasoning
                            and re.search(r"eligib|inclusion|exclusion|entry|enrol|randomi|prior to (?:the )?(?:first|study)|threshold|required", window, re.I)):
                        value_specific = True
            if reasoning or value_specific:
                hits.append({"page": pno, "text": sent, "value_specific": value_specific})
        if len(hits) >= 6:
            break
    # value-specific first, then earliest
    hits.sort(key=lambda h: (not h["value_specific"], h["page"]))
    return hits[:3]


def review_criterion(crit: dict, target: dict, comp_rows: list[dict], doc, elig_pages: set[int]) -> dict:
    analyte = crit["analyte"]
    drugs = set(target["regimen"]["drugs"])
    ev: list[dict] = []
    missing: list[str] = []
    support = challenge = 0
    regimen_support = 0  # a toxicity rationale supports having a threshold, not its value
    value_txt = _fmt(crit)
    with_prop: list[str] = []

    # The trial's own arms and protocol text are examined before peer thresholds are interpreted.
    # 1. regimen safety rationale (existence of a threshold, not its value)
    rel = druglib.LAB_RELEVANCE.get(analyte)
    if rel:
        prop, why = rel
        with_prop = druglib.drugs_with(drugs, prop)
        if with_prop:
            ev.append({
                "kind": "regimen", "stance": "supports", "strength": "existence only",
                "summary": f"Arms include {', '.join(with_prop)} ({why}, curated pharmacology table). This supports having a threshold; it does not show that {value_txt} is the right value.",
            })
            support += 1
            regimen_support = 1
        elif target["regimen"].get("unrecognized"):
            # absence of evidence is not evidence of absence: unknown agents may carry this toxicity
            missing.append(
                f"Arms include agents outside the curated pharmacology table ({', '.join(target['regimen']['unrecognized'])}); "
                f"whether they carry {why} was not assessed."
            )
        elif drugs:
            ev.append({
                "kind": "regimen", "stance": "challenges", "strength": "moderate",
                "summary": f"No agent in any arm is flagged for {why} in the curated pharmacology table ({', '.join(sorted(drugs))}).",
            })
            challenge += 2
        else:
            missing.append("Treatment regimen could not be determined from registry or protocol text.")

    # 2. protocol-stated rationale
    hits = protocol_rationale(doc, crit, elig_pages)
    value_specific = any(h["value_specific"] for h in hits)
    for h in hits:
        ev.append({
            "kind": "protocol", "stance": "supports" if h["value_specific"] else "context",
            "strength": "moderate" if h["value_specific"] else "weak", "page": h["page"], "quote": h["text"],
            "summary": ("Protocol text references this threshold value." if h["value_specific"] else
                        "Protocol discusses this topic; the passage does not state why this specific threshold was chosen."),
            "url": doc.url if doc else None,
        })
    if value_specific:
        support += 2
    else:
        missing.append(f"No protocol text found that explains why {value_txt} was chosen (searched outside the eligibility section).")

    # 3. comparators
    looser = [r for r in comp_rows if r["direction"] == "comparator looser"]
    same = [r for r in comp_rows if r["direction"] == "same"]
    stricter = [r for r in comp_rows if r["direction"] == "comparator stricter"]
    comparable = looser + same + stricter
    for r in comp_rows:
        if r["criterion"] is None or r["direction"] in ("not found",):
            continue
        cov = r["coverage"]
        if r["direction"] == "comparator looser":
            strength = "moderate" if cov["status"] in ("full", "n/a") else "weak"
            stance = "challenges"
            note = (f"{r['acronym'] or r['nct_id']} used {_fmt(r['criterion'])} (vs {value_txt}). "
                    "A more permissive threshold in a comparable trial shows it was used, not that it was safe or that the stricter value is unnecessary.")
        elif r["direction"] == "comparator stricter":
            strength, stance = "weak", "supports"
            note = f"{r['acronym'] or r['nct_id']} used a stricter {_fmt(r['criterion'])}."
        elif r["direction"] == "same":
            strength, stance = "weak", "context"
            op_note = " (same value, different operator)" if r["criterion"]["operator"] != crit["operator"] else ""
            note = f"{r['acronym'] or r['nct_id']} used the same threshold{op_note}. Agreement may reflect template carry-forward (FDA lab guidance §II) rather than independent justification."
        else:
            strength, stance = "none", "context"
            note = f"{r['acronym'] or r['nct_id']} uses a different measure ({r['criterion']['label']} {_fmt(r['criterion'])}); not directly comparable."
        if cov["status"] == "partial":
            note += f" Regimen coverage is partial: comparator lacks {', '.join(cov['missing_classes'])}."
        ev.append({"kind": "comparator", "stance": stance, "strength": strength, "nct_id": r["nct_id"], "summary": note,
                   "page": r["criterion"]["source"]["page"], "quote": r["criterion"]["source"]["text"], "url": r["criterion"]["source"]["url"]})
    if looser:
        # regimen-matched comparators (lab criteria with full toxicity-class coverage) weigh more than
        # comparators for criteria with no regimen link, where similarity is only by indication/class
        best = max(2 if r["coverage"]["status"] == "full" else 1 for r in looser)
        challenge += best
    if len(same) >= 2 and not looser:
        support += 1
    if stricter:
        support += 1
    if not comparable:
        missing.append("No comparable trial with an extractable value for this criterion was found.")

    # 4. FDA guidance. Guidance issued after the trial started is applied retrospectively: it is a
    # present-day review standard, not something the trial's designers could have followed.
    start = target["study"].get("start_date") or ""
    has_hepatic = bool(druglib.drugs_with(drugs, "hepatic"))
    for p in passages_for(analyte):
        if p.stance == "purpose":
            continue  # used for purpose tags, not as evidence for/against this threshold
        d = p.to_dict()
        stance = p.stance
        if p.key == "lab_hepatic_broad" and has_hepatic:
            stance = "context"  # conditional recommendation does not apply when hepatic agents are present
        if p.key in ("wo_time_based_justified", "wo_parameters_not_time") and analyte not in TIME_BASED_PRIOR_THERAPY:
            continue
        specific = p.key in SPECIFIC_FDA
        retro = bool(start) and start[:7] < d["issued"]
        ev.append({"kind": "fda", "stance": stance, "strength": "specific" if specific else "general", "key": p.key,
                   "quote": p.quote, "citation": d["citation"], "link": d["link"], "summary": d["citation"],
                   "issued": d["issued"], "retrospective": retro,
                   "timing_note": (f"Issued {d['issued']}, after this trial started ({start}); applied retrospectively, "
                                   "not a standard available when the trial was designed.") if retro else None})
    specific_fda = [e for e in ev if e["kind"] == "fda" and e["strength"] == "specific" and e["stance"] == "challenges"]
    if specific_fda:
        pk_alt = any(c.get("when") == "PK-based alternative" for c in crit.get("conditions", []))
        challenge += 1 if pk_alt else 2

    if analyte == "ecog":
        missing.append("Earlier-phase safety data for ECOG PS2 patients with this agent were not retrieved (FDA PS guidance §IV.A conditions inclusion on such data).")
    if analyte in ("hemoglobin", "anc", "platelets"):
        missing.append("No randomized or outcome evidence comparing toxicity or efficacy across threshold values was retrieved.")

    # classification. "Supports retaining" needs evidence about the threshold itself (comparators that
    # agree or are stricter, or a value-specific protocol rationale); a regimen toxicity link alone only
    # justifies having *a* threshold, so on its own it yields "Insufficient evidence".
    if challenge >= 2 and not value_specific:
        cls = CLASS_REVIEW
    elif challenge == 0 and support - regimen_support >= 1:
        cls = CLASS_RETAIN
    else:
        cls = CLASS_INSUFFICIENT
        if challenge == 0 and regimen_support and support == regimen_support:
            missing.append("Only a regimen-level toxicity rationale was found; it supports having a threshold, not this value.")
    safety_note = None
    if regimen_support and not value_specific:
        pages = sorted({h["page"] for h in hits})
        where = f"; the protocol mentions related safety considerations (p. {', '.join(map(str, pages))})" if pages else ""
        safety_note = (f"a plausible safety rationale exists (arms include {', '.join(with_prop)}{where}), "
                       f"but the precise threshold ({value_txt}) is not established by the available evidence")
    retro = any(e.get("retrospective") for e in specific_fda)
    rationale = _explain(cls, crit, looser, same, stricter, specific_fda, value_specific, support, challenge, safety_note, retro)
    for e in ev:
        e["tier"] = TIERS.get(e["kind"], e["kind"])
    return {
        "criterion": crit,
        "purposes": infer_purposes(crit, drugs),
        "classification": cls,
        "scores": {"support": support, "challenge": challenge},
        "explanation": rationale,
        "evidence": ev,
        "missing_evidence": missing,
        "suggested_action": suggest(cls, crit, looser, specific_fda),
    }


def _explain(cls, crit, looser, same, stricter, specific_fda, value_specific, support, challenge,
             safety_note=None, fda_retrospective=False) -> str:
    # The trial's own rationale comes first; peer thresholds are precedent, not proof.
    parts = [safety_note] if safety_note else []
    if value_specific:
        parts.append("the protocol contains a value-specific rationale")
    elif not safety_note:
        parts.append("no value-specific rationale was found in the protocol")
    if looser:
        parts.append(f"{len(looser)} comparable trial(s) used a more permissive threshold (precedent, not evidence of safety)")
    if same:
        parts.append(f"{len(same)} used the same threshold")
    if stricter:
        parts.append(f"{len(stricter)} used a stricter one")
    if specific_fda:
        parts.append("FDA's July 2026 guidance makes a specific recommendation for this criterion"
                     + (" (issued after this trial started; applied retrospectively)" if fda_retrospective else ""))
    return f"{cls}: " + "; ".join(parts) + f". (support score {support}, challenge score {challenge})"


def suggest(cls: str, crit: dict, looser: list, specific_fda: list) -> dict:
    """Clinically cautious, structured suggestion. Never 'remove'; never asserts safety."""
    a = crit["analyte"]
    if cls == CLASS_RETAIN:
        return {"action": "retain", "text": "No change suggested. Keep the existing rationale documented."}
    if a == "anc" and any(e["key"] == "lab_duffy_broaden" for e in specific_fda):
        return {"action": "add_provision",
                "text": "Consider whether a Duffy-null-specific ANC provision is appropriate for this regimen (FDA lab guidance §III.B); requires clinical and pharmacology review of the myelosuppressive agents in the regimen."}
    if a == "ecog":
        return {"action": "justify_in_protocol",
                "text": "State the rationale for excluding ECOG PS2 in the protocol, or consider a pre-specified exploratory PS2 cohort (FDA PS guidance §IV.A–B), contingent on earlier-phase safety data."}
    if looser and cls == CLASS_REVIEW:
        vals = sorted({r["criterion"]["value_norm"] for r in looser})
        return {"action": "justify_in_protocol",
                "text": f"Start from the protocol's own safety rationale and treatment arms, and document why {_fmt(crit)} was chosen. Comparable trials used {', '.join(str(v) for v in vals)} {crit['unit_norm']}; that is precedent, not evidence that a lower value is safe for this regimen. This is a clinical review question, not a finding that the threshold is wrong."}
    if crit["category"] == "washout":
        return {"action": "justify_in_protocol",
                "text": "State the PK/PD or clinical rationale for this time-based interval, or consider clinical/laboratory recovery parameters (FDA washout guidance §III.A)."}
    return {"action": "justify_in_protocol", "text": "Evidence is insufficient to recommend a change; document the rationale for this criterion."}


def run_review(nct_id: str, k: int = 4, as_of: str | None = "auto", fixed_comparators: list[str] | None = None, doc_override=None) -> dict:
    target = analyze_trial(nct_id, doc_override)
    doc = target.pop("_doc", None)
    cutoff = target["study"]["start_date"] if as_of == "auto" else as_of
    comps = load_comparators(target, k=k, as_of=cutoff, fixed=fixed_comparators)
    table = compare(target, comps)
    elig_pages = set(target["study"].get("eligibility_pages", []))
    reviews = [review_criterion(c, target, table[c["id"]], doc, elig_pages) for c in target["criteria"]]
    for c in comps:
        c["tags"] = sorted(c.get("tags", []))
    return {
        "target": target,
        "as_of": cutoff,
        "comparators": [{"study": c["study"], "regimen": c["regimen"], "similarity": c["similarity"], "tags": c["tags"], "criteria": c["criteria"]} for c in comps],
        "comparison": table,
        "reviews": reviews,
    }


if __name__ == "__main__":
    import sys

    r = run_review(sys.argv[1] if len(sys.argv) > 1 else "NCT03409614")
    print("as of", r["as_of"], "| comparators:", [c["study"]["nct_id"] for c in r["comparators"]])
    for rv in r["reviews"]:
        c = rv["criterion"]
        print(f"\n[{rv['classification']}] {c['label']} {_fmt(c)}  -> {rv['suggested_action']['action']}")
        print("   ", rv["explanation"])
        for m in rv["missing_evidence"]:
            print("    missing:", m)
