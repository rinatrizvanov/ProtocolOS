"""Clinical review packet: the exportable output a protocol-review team can discuss and act on.

Built only from the review result and reviewer decisions; no new claims are introduced here.
"""
from __future__ import annotations

import html
import json
import time
from pathlib import Path

from .sources import DATA

DECISIONS = DATA / "decisions"
DECISION_OPTIONS = {
    "accept": "Accept suggested review action",
    "reject": "Reject (keep criterion as written)",
    "needs_medical_review": "Needs medical review",
    "defer": "Defer / need more evidence",
}
PRIORITY = {
    "Review recommended": ("High", "Evidence conflict or a criterion-specific FDA recommendation; discuss before finalizing."),
    "Insufficient evidence": ("Medium", "Evidence is incomplete either way; decide what further evidence is needed."),
    "Evidence supports retaining": ("Low", "Comparable trials and/or protocol rationale support the threshold; document the rationale."),
}
TIER_ORDER = ["Direct protocol evidence", "Peer-trial precedent", "Regulatory guidance", "Curated pharmacology (rule-based inference)", "Model inference"]


def load_decisions(nct: str) -> dict:
    p = DECISIONS / f"{nct}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def save_decision(nct: str, criterion_id: str, decision: str, reason: str, reviewer: str) -> dict:
    if decision not in DECISION_OPTIONS:
        raise ValueError(f"decision must be one of {sorted(DECISION_OPTIONS)}")
    DECISIONS.mkdir(parents=True, exist_ok=True)
    d = load_decisions(nct)
    d[criterion_id] = {"decision": decision, "label": DECISION_OPTIONS[decision], "reason": reason.strip(),
                       "reviewer": reviewer.strip() or "unnamed reviewer", "recorded_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    (DECISIONS / f"{nct}.json").write_text(json.dumps(d, indent=1))
    return d


def _fmt(c):
    v = c["value_norm"]
    v = int(v) if v is not None and float(v).is_integer() else v
    return f"{c['operator']}{v} {c['unit_norm']}"


def build_packet(review: dict, decisions: dict | None = None) -> dict:
    decisions = decisions or {}
    st = review["target"]["study"]
    order = {"Review recommended": 0, "Insufficient evidence": 1, "Evidence supports retaining": 2}
    items = []
    for rv in sorted(review["reviews"], key=lambda r: order.get(r["classification"], 3)):
        c = rv["criterion"]
        by_tier = {}
        for e in rv["evidence"]:
            if e["kind"] == "fda":
                continue
            by_tier.setdefault(e.get("tier", e["kind"]), []).append({
                "stance": e["stance"], "strength": e["strength"], "summary": e["summary"],
                "source": (f"{e.get('nct_id') or st['nct_id']} p.{e['page']}" if e.get("page") else None), "quote": e.get("quote"),
            })
        guidance = [{"stance": e["stance"], "quote": e["quote"], "citation": e["citation"], "link": e["link"], "specific": e["strength"] == "specific",
                     "retrospective": bool(e.get("retrospective"))} for e in rv["evidence"] if e["kind"] == "fda"]
        pr, why = PRIORITY.get(rv["classification"], ("—", ""))
        items.append({
            "criterion_id": c["id"],
            "requirement": {"label": c["label"], "threshold": _fmt(c), "section": c["section"], "verbatim": c["source"]["text"],
                            "source": f"{c['source']['doc']} p.{c['source']['page']}, line {c['source']['line']}" if c["source"]["page"] else "registry eligibility text",
                            "url": c["source"]["url"] + (f"#page={c['source']['page']}" if c["source"]["page"] else ""),
                            "conditions": c.get("conditions", []), "exceptions": c.get("exceptions", [])},
            "classification": rv["classification"],
            "priority": pr, "priority_reason": why,
            "explanation": rv["explanation"],
            "likely_purpose": rv.get("purposes", []),
            "evidence_by_tier": {t: by_tier[t] for t in TIER_ORDER if t in by_tier},
            "regulatory_guidance": guidance,
            "unresolved_questions": rv["missing_evidence"],
            "next_action": rv["suggested_action"],
            "decision": decisions.get(c["id"]),
        })
    comps = [{"nct_id": c["study"]["nct_id"], "acronym": c["study"].get("acronym"), "sponsor": c["study"]["sponsor"], "start": c["study"]["start_date"],
              "regimen": sorted(c["regimen"]["drugs"]), "shared_classes": c["similarity"]["shared_classes"],
              "target_only_classes": c["similarity"]["target_only_classes"], "comparator_only_classes": c["similarity"]["comparator_only_classes"],
              "setting": c.get("tags", [])} for c in review["comparators"]]
    return {
        "title": f"TrialLens eligibility review packet — {st['nct_id']}",
        "generated_at": time.strftime("%Y-%m-%d %H:%M"),
        "trial": {k: st.get(k) for k in ("nct_id", "acronym", "title", "sponsor", "phases", "status", "start_date", "registry_url", "criteria_source")},
        "protocol_document": (st.get("protocol_docs") or [None])[0],
        "regimen": {k: {"class": v["class"], "evidence": v["sources"]} for k, v in review["target"]["regimen"]["drugs"].items()},
        "unrecognized_agents": review["target"]["regimen"].get("unrecognized", []),
        "comparator_cutoff": review.get("as_of"),
        "comparators": comps,
        "items": items,
        "decision_summary": {opt: sum(1 for d in decisions.values() if d["decision"] == opt) for opt in DECISION_OPTIONS},
        "notes": [
            "TrialLens is a research prototype. Classifications are prompts for expert review, not safety or regulatory determinations.",
            "Likely-purpose tags are inferred by TrialLens from the criterion type and regimen unless a protocol source is cited.",
            "A more permissive comparator shows a threshold was used, not that it was safe; a toxicity link supports having a threshold, not a specific value.",
            "Protocol PDFs on ClinicalTrials.gov are usually the final amendment, not the design-time version. "
            "A difference from peer trials does not show that a threshold changed across amendments or why it was chosen.",
            "FDA guidance marked \"retrospective\" was issued after this trial started. It is applied as a present-day review "
            "standard, not as a standard the trial's designers could have followed.",
            "Differences from comparable trials are clinical review questions, not findings that a criterion is a mistake.",
        ],
    }


def to_markdown(p: dict) -> str:
    t = p["trial"]
    out = [f"# {p['title']}", "",
           f"**{t.get('acronym') or ''} {t['title']}**  ", f"Sponsor: {t['sponsor']} · Phase: {', '.join(t['phases'] or [])} · Status: {t['status']} · Start: {t['start_date']}  ",
           f"Registry: {t['registry_url']}  "]
    if p["protocol_document"]:
        out.append(f"Protocol: {p['protocol_document']['url']} ({p['protocol_document']['date']})  ")
    out += [f"Generated {p['generated_at']} · comparator cutoff {p['comparator_cutoff'] or 'none'}", "",
            "## Regimen (all arms)", ", ".join(f"{k} ({v['class']})" for k, v in p["regimen"].items())]
    if p["unrecognized_agents"]:
        out.append(f"Agents not in the curated table: {', '.join(p['unrecognized_agents'])}")
    out += ["", "## Comparable trials"]
    for c in p["comparators"]:
        diff = []
        if c["target_only_classes"]:
            diff.append(f"lacks {', '.join(c['target_only_classes'])}")
        if c["comparator_only_classes"]:
            diff.append(f"adds {', '.join(c['comparator_only_classes'])}")
        out.append(f"- {c['acronym'] or c['nct_id']} ({c['nct_id']}, {c['sponsor']}, start {c['start']}): shares {', '.join(c['shared_classes'])}" + (f"; {'; '.join(diff)}" if diff else ""))
    if not p["comparators"]:
        out.append("- none found before the cutoff")
    out += ["", "## Criteria"]
    for it in p["items"]:
        r = it["requirement"]
        out += ["", f"### {r['label']} {r['threshold']} — {it['classification']} (priority: {it['priority']})",
                f"> {r['verbatim']}", f"Source: {r['source']} — {r['url']}", "", f"**Why flagged:** {it['explanation']}", "",
                "**Likely scientific purpose (inferred unless sourced):**"]
        for pu in it["likely_purpose"]:
            line = f"- {pu['purpose']} [{pu['status']}]: {pu['basis']}"
            if pu.get("fda_context"):
                line += f" (FDA context: \"{pu['fda_context']['quote']}\" — {pu['fda_context']['citation']})"
            out.append(line)
        for tier, evs in it["evidence_by_tier"].items():
            out.append(f"\n**{tier}:**")
            for e in evs:
                out.append(f"- [{e['stance']}, {e['strength']}] {e['summary']}" + (f" ({e['source']})" if e["source"] else ""))
        if it["regulatory_guidance"]:
            out.append("\n**Regulatory guidance:**")
            for g in it["regulatory_guidance"]:
                out.append(f"- [{g['stance']}{', retrospective' if g.get('retrospective') else ''}] \"{g['quote']}\" — {g['citation']}")
        out.append("\n**Unresolved questions / missing evidence:**")
        out += [f"- {q}" for q in it["unresolved_questions"]] or ["- none recorded"]
        out.append(f"\n**Suggested next action ({it['next_action']['action'].replace('_', ' ')}):** {it['next_action']['text']}")
        d = it["decision"]
        out.append(f"\n**Reviewer decision:** " + (f"{d['label']} — {d['reason'] or 'no reason given'} ({d['reviewer']}, {d['recorded_at']})" if d else "☐ Accept ☐ Reject ☐ Needs medical review ☐ Defer — reason: ________"))
    out += ["", "## Notes"] + [f"- {n}" for n in p["notes"]]
    return "\n".join(out) + "\n"


def to_html(p: dict) -> str:
    md = to_markdown(p)
    # minimal, dependency-free rendering suitable for printing to PDF
    body = []
    for line in md.splitlines():
        e = html.escape(line)
        if line.startswith("### "):
            body.append(f"<h3>{e[4:]}</h3>")
        elif line.startswith("## "):
            body.append(f"<h2>{e[3:]}</h2>")
        elif line.startswith("# "):
            body.append(f"<h1>{e[2:]}</h1>")
        elif line.startswith("> "):
            body.append(f"<blockquote>{e[5:]}</blockquote>")
        elif line.startswith("- "):
            body.append(f"<li>{e[2:]}</li>")
        elif line.strip():
            body.append(f"<p>{e}</p>")
    import re

    text = "\n".join(body)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(p['title'])}</title>
<style>body{{font:13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;max-width:900px;margin:30px auto;color:#17202b}}
h1{{font-size:20px}}h2{{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:26px}}h3{{font-size:14px;margin-top:22px;background:#f5f6f8;padding:6px 8px}}
blockquote{{font-family:Menlo,monospace;font-size:12px;border-left:3px solid #1f4e79;margin:6px 0;padding:4px 10px;background:#fafbfc}}li{{margin:3px 0}}p{{margin:4px 0}}
@media print{{h3{{page-break-after:avoid}}}}</style></head><body>{text}</body></html>"""
