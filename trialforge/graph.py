"""Evidence provenance graph built from a stored review (no retrieval, no new claims).

Every evidence item of `run_review()` becomes a typed, sourced node; stances become edges; and the
score totals in `review["reviews"][i]["scores"]` are attributed to rule groups that mirror the four
numbered scoring sections of `review.review_criterion`. Points sit only on `RULE_SCORES` edges
(ScoreRule -> Assessment). If the attributed sums differ from the stored scores the graph carries
`attribution_mismatch:{cid}` in `warnings` and the UI hides attribution for that criterion.

Node types, edge types and id formats are a contract shared with the investigator, the dashboard graph
tab and the web app; change them together.
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict

from .guidance import normalize
from .packet import _fmt

NODE_TYPES = {
    "Criterion": "source_fact", "Assessment": "rule_inferred", "Classification": "rule_inferred",
    "Recommendation": "rule_inferred", "CuratedFact": "curated_pharmacology", "Passage": "source_fact",
    "ComparatorThreshold": "source_fact", "GuidancePassage": "source_fact", "ScoreRule": "rule_inferred",
    "MissingEvidence": "rule_inferred", "ReviewerDecision": "human",
}
EVIDENCE_TYPES = {"CuratedFact", "Passage", "ComparatorThreshold", "GuidancePassage"}
# edge type -> (allowed from types, allowed to types)
EDGE_TYPES = {
    "CRITERION_HAS_ASSESSMENT": ({"Criterion"}, {"Assessment"}),
    "ASSESSMENT_CLASSIFIED_AS": ({"Assessment"}, {"Classification"}),
    "ASSESSMENT_RECOMMENDS": ({"Assessment"}, {"Recommendation"}),
    "CLASSIFICATION_DECIDED_BY": ({"Classification"}, {"ReviewerDecision"}),
    "EVIDENCE_IN_RULE": (EVIDENCE_TYPES, {"ScoreRule"}),
    "RULE_SCORES": ({"ScoreRule"}, {"Assessment"}),
    "EVIDENCE_FOR": (EVIDENCE_TYPES, {"Assessment"}),
    "ASSESSMENT_LACKS": ({"Assessment"}, {"MissingEvidence"}),
}
STANCES = {"supports", "challenges", "context", None}
AXES = {"support", "challenge", None}
EXISTENCE = "existence_of_threshold"

# Missing-evidence texts emitted by review.py -> the rule that would fire if the evidence existed.
_MISSING_RULE = (
    ("No protocol text found that explains why", "protocol_value_specific"),
    ("Arms include agents outside the curated pharmacology table", "regimen_support"),
    ("Treatment regimen could not be determined", "regimen_support"),
)


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def _short(s: str | None, n: int = 90) -> str:
    s = normalize(s or "")
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _pick(rows: list[dict], direction: str) -> list[dict]:
    return [r for r in rows if r.get("direction") == direction]


def contributions(review_item: dict, comparison_rows: list[dict]) -> list[dict]:
    """Rule-level score attribution for one criterion, mirroring the scoring in review.review_criterion.

    Returns one dict per rule group that has members: `{group, axis, points, fires, label, members}`.
    `points` is what the group adds (0 when it does not fire). Members reference evidence items by
    `evidence_index` (index into `review_item["evidence"]`); comparator members also carry `nct_id`
    and `coverage`, read from `comparison_rows[i]["coverage"]["status"]` (not from evidence strength).
    """
    ev = review_item.get("evidence", [])
    crit = review_item["criterion"]
    out: list[dict] = []

    def add(group, axis, points, fires, label, members):
        if members:
            out.append({"group": group, "axis": axis, "points": points if fires else 0, "fires": fires,
                        "label": label if fires else None, "members": members})

    idx = lambda pred: [{"evidence_index": i} for i, e in enumerate(ev) if pred(e)]  # noqa: E731

    # 1. regimen (review_criterion section 1): supports +1 (existence of a threshold only); challenges +2
    add("regimen_support", "support", 1, True, "+1 support (existence of a threshold, not its value)",
        idx(lambda e: e.get("kind") == "regimen" and e.get("stance") == "supports"))
    add("regimen_challenge", "challenge", 2, True, "+2 challenge",
        idx(lambda e: e.get("kind") == "regimen" and e.get("stance") == "challenges"))
    # 2. protocol (review_criterion section 2): one +2 support for any value-specific passage
    add("protocol_value_specific", "support", 2, True, "+2 support (value-specific protocol text)",
        idx(lambda e: e.get("kind") == "protocol" and e.get("stance") == "supports"))

    # 3. comparators (review_criterion section 3): groups are computed over comparison rows, as review.py does
    ev_by_nct = {e.get("nct_id"): i for i, e in enumerate(ev) if e.get("kind") == "comparator"}

    def members(rows):
        return [{"evidence_index": ev_by_nct.get(r["nct_id"]), "nct_id": r["nct_id"],
                 "coverage": (r.get("coverage") or {}).get("status")} for r in rows]

    looser = _pick(comparison_rows, "comparator looser")
    same = _pick(comparison_rows, "same")
    stricter = _pick(comparison_rows, "comparator stricter")
    if looser:
        best = max(2 if m["coverage"] == "full" else 1 for m in members(looser))
        add("looser_comparators", "challenge", best, True, f"+{best} challenge (group max)", members(looser))
    add("same_comparators", "support", 1, len(same) >= 2 and not looser,
        "+1 support (2 or more used the same threshold, none more permissive)", members(same))
    add("stricter_comparators", "support", 1, True, "+1 support (a comparator used a stricter value)", members(stricter))

    # 4. FDA (review_criterion section 4): specific + challenges -> +2, or +1 with a PK-based alternative
    pk_alt = any(c.get("when") == "PK-based alternative" for c in crit.get("conditions", []))
    pts = 1 if pk_alt else 2
    add("specific_fda", "challenge", pts, True,
        f"+{pts} challenge" + (" (PK-based alternative present)" if pk_alt else ""),
        idx(lambda e: e.get("kind") == "fda" and e.get("strength") == "specific" and e.get("stance") == "challenges"))
    return out


def _passage_canon(review: dict) -> dict:
    """(url, page, normalized quote) -> kept quote. Same page + one text contained in the other ->
    one passage, keeping the longest quote. Computed over the whole review so ids do not depend on
    the criterion filter."""
    groups: dict[tuple, set] = defaultdict(set)
    for rv in review.get("reviews", []):
        for e in rv.get("evidence", []):
            if e.get("kind") == "protocol" and e.get("quote"):
                groups[(e.get("url"), e.get("page"))].add(e["quote"])
    canon = {}
    for (url, page), quotes in groups.items():
        kept: list[tuple[str, str]] = []
        for q in sorted(quotes, key=lambda q: (-len(normalize(q)), q)):
            n = normalize(q)
            host = next((k for k in kept if n in k[0]), None)
            if host is None:
                host = (n, q)
                kept.append(host)
            canon[(url, page, n)] = host[1]
    return canon


def build_graph(review: dict, decisions: dict | None = None, criterion_id: str | None = None) -> dict:
    """Typed provenance graph for one review (all criteria, or `criterion_id` only). Read-only."""
    decisions = decisions or {}
    st = review["target"]["study"]
    nct = st["nct_id"]
    items = review["reviews"]
    if criterion_id is not None:
        items = [rv for rv in items if rv["criterion"]["id"] == criterion_id]
        if not items:
            raise KeyError(f"criterion not found: {criterion_id}")
    similarity = {c["study"]["nct_id"]: c.get("similarity") for c in review.get("comparators", [])}
    canon = _passage_canon(review)
    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    warnings: list[str] = []

    def node(nid, ntype, label, data, source=None):
        if nid in nodes:
            return nid
        nodes[nid] = {"id": nid, "type": ntype, "label": label, "epistemic": NODE_TYPES[ntype],
                      "data": data, "source": source}
        return nid

    def edge(src, dst, etype, stance=None, points=0, axis=None, group=None, scope=None, label=None):
        eid = "e:" + _sha1(f"{src}|{dst}|{etype}|{stance}|{group}")[:12]
        edges.setdefault(eid, {"id": eid, "from": src, "to": dst, "type": etype, "stance": stance, "points": points,
                               "axis": axis, "group": group, "scope": scope, "label": label})

    for rv in items:
        crit = rv["criterion"]
        cid = crit["id"]
        csrc = crit.get("source") or {}
        value_txt = _fmt(crit)
        crit_id = node(f"crit:{nct}:{cid}", "Criterion", f"{crit['label']} {value_txt}",
                       {"criterion_id": cid, "label": crit["label"], "operator": crit["operator"],
                        "value_norm": crit["value_norm"], "unit_norm": crit["unit_norm"], "section": crit.get("section"),
                        "analyte": crit.get("analyte"), "category": crit.get("category"),
                        "conditions": crit.get("conditions", []), "line": csrc.get("line"),
                        **({"display": crit["display"]} if crit.get("display") else {})},
                       {"nct": nct, "page": csrc.get("page"), "quote": csrc.get("text"), "url": csrc.get("url")})
        assess = node(f"assess:{nct}:{cid}", "Assessment", f"Assessment of {crit['label']} {value_txt}",
                      {"scores": dict(rv["scores"]), "explanation": rv.get("explanation")})
        cls = node(f"class:{nct}:{cid}", "Classification", rv["classification"], {"classification": rv["classification"]})
        sa = rv.get("suggested_action") or {}
        rec = node(f"rec:{nct}:{cid}", "Recommendation", "Suggested action: " + str(sa.get("action", "")).replace("_", " "),
                   {"action": sa.get("action"), "text": sa.get("text")})
        edge(crit_id, assess, "CRITERION_HAS_ASSESSMENT")
        edge(assess, cls, "ASSESSMENT_CLASSIFIED_AS")
        edge(assess, rec, "ASSESSMENT_RECOMMENDS")
        if cid in decisions:
            d = decisions[cid]
            dec = node(f"decision:{nct}:{cid}", "ReviewerDecision", d.get("label") or d.get("decision"),
                       {k: d.get(k) for k in ("decision", "label", "reason", "reviewer", "recorded_at")})
            edge(cls, dec, "CLASSIFICATION_DECIDED_BY")

        # evidence nodes, one per evidence item (duplicates collapse onto one id)
        rows = review.get("comparison", {}).get(cid, [])
        row_by_nct = {r["nct_id"]: r for r in rows}
        ev_node: dict[int, str] = {}
        cmp_node: dict[str, str] = {}
        for i, e in enumerate(rv.get("evidence", [])):
            kind = e.get("kind")
            if kind == "regimen":
                summary = e.get("summary", "")
                ev_node[i] = node(f"curated:{_sha1(normalize(summary))[:12]}", "CuratedFact",
                                  "Curated pharmacology: " + _short(summary.split(". ")[0], 110),
                                  {"existence_only": e.get("stance") == "supports", "summary": summary,
                                   "strength": e.get("strength")})
            elif kind == "protocol":
                n = normalize(e.get("quote") or "")
                quote = canon.get((e.get("url"), e.get("page"), n), e.get("quote"))
                url, page = e.get("url"), e.get("page")
                nid = "passage:" + _sha1(f"{url}|{page}|{normalize(quote)}")[:12]
                if nid in nodes:
                    nodes[nid]["data"]["value_specific"] |= e.get("stance") == "supports"
                ev_node[i] = node(nid, "Passage", f"p.{e.get('page')}: {_short(quote)}",
                                  {"value_specific": e.get("stance") == "supports"},
                                  {"nct": nct, "page": e.get("page"), "quote": quote, "url": e.get("url")})
            elif kind == "comparator":
                r = row_by_nct.get(e.get("nct_id")) or {}
                rc = r.get("criterion") or {}
                cov = r.get("coverage") or {}
                who = r.get("acronym") or e.get("nct_id")
                ev_node[i] = cmp_node[e["nct_id"]] = node(
                    f"cmpthr:{e['nct_id']}:{cid}", "ComparatorThreshold",
                    f"{who}: {rc.get('label', '')} {_fmt(rc)}" if rc else str(who),
                    {"nct_id": e["nct_id"], "acronym": r.get("acronym"), "operator": rc.get("operator"),
                     "value_norm": rc.get("value_norm"), "unit_norm": rc.get("unit_norm"), "direction": r.get("direction"),
                     "coverage": {"status": cov.get("status"), "missing_classes": cov.get("missing_classes", [])},
                     "similarity": similarity.get(e["nct_id"]), "summary": e.get("summary"),
                     **({"display": rc["display"]} if rc.get("display") else {})},
                    {"nct": e["nct_id"], "page": e.get("page"), "quote": e.get("quote"), "url": e.get("url")})
            elif kind == "fda":
                ev_node[i] = node(f"fda:{e['key']}", "GuidancePassage", "FDA: " + _short(e.get("quote")),
                                  {"key": e["key"], "citation": e.get("citation"), "issued": e.get("issued"),
                                   "retrospective": e.get("retrospective"), "timing_note": e.get("timing_note"),
                                   "strength": e.get("strength")},
                                  {"nct": None, "page": None, "quote": e.get("quote"), "url": e.get("link")})

        # attribution: firing rules get a ScoreRule node; members of non-firing rules use EVIDENCE_FOR
        in_rule: set[int] = set()
        sums = {"support": 0, "challenge": 0}
        for c in contributions(rv, rows):
            if not c["fires"]:
                continue
            mids = []
            for m in c["members"]:
                mid = ev_node.get(m["evidence_index"]) if m["evidence_index"] is not None else None
                mid = mid or cmp_node.get(m.get("nct_id"))
                if mid:
                    mids.append(mid)
            regimen = c["group"].startswith("regimen_")
            rule = node(f"rule:{nct}:{cid}:{c['group']}", "ScoreRule", f"{c['group'].replace('_', ' ')}: {c['label']}",
                        {"group": c["group"], "axis": c["axis"], "points": c["points"], "members": list(dict.fromkeys(mids))})
            for m in c["members"]:
                if m["evidence_index"] is None:
                    continue
                in_rule.add(m["evidence_index"])
                e = rv["evidence"][m["evidence_index"]]
                edge(ev_node[m["evidence_index"]], rule, "EVIDENCE_IN_RULE", stance=e.get("stance"), axis=c["axis"],
                     group=c["group"], scope=EXISTENCE if regimen else None)
            edge(rule, assess, "RULE_SCORES", stance="supports" if c["axis"] == "support" else "challenges",
                 points=c["points"], axis=c["axis"], group=c["group"], scope=EXISTENCE if regimen else None, label=c["label"])
            sums[c["axis"]] += c["points"]
        for i, nid in ev_node.items():
            if i in in_rule:
                continue
            e = rv["evidence"][i]
            edge(nid, assess, "EVIDENCE_FOR", stance=e.get("stance"),
                 scope=EXISTENCE if e.get("kind") == "regimen" else None)
        if sums != {"support": rv["scores"]["support"], "challenge": rv["scores"]["challenge"]}:
            warnings.append(f"attribution_mismatch:{cid}")

        for text in rv.get("missing_evidence", []):
            affects = next((g for prefix, g in _MISSING_RULE if text.startswith(prefix)), None)
            mid = node(f"missing:{nct}:{cid}:{_sha1(normalize(text))[:8]}", "MissingEvidence", "Missing: " + _short(text),
                       {"text": text, "affects_rule": affects})
            edge(assess, mid, "ASSESSMENT_LACKS")

    g = {
        "nct_id": nct,
        "criterion_id": criterion_id,
        "built_from": {"computed_at": review.get("computed_at"), "as_of": review.get("as_of"),
                       "fingerprint": hashlib.sha256(json.dumps(review, sort_keys=True, default=list).encode()).hexdigest()},
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "warnings": warnings,
        "validation": [],
    }
    g["validation"] = validate_graph(g)
    return g


def validate_graph(g: dict) -> list[str]:
    """Structural checks; [] means valid. No dangling edges or orphans, typed endpoints, sourced
    evidence, points only on RULE_SCORES, regimen edges scoped to the existence of a threshold."""
    errs: list[str] = []
    nodes = {}
    for n in g.get("nodes", []):
        if n["id"] in nodes:
            errs.append(f"duplicate node id {n['id']}")
        nodes[n["id"]] = n
        if NODE_TYPES.get(n.get("type")) != n.get("epistemic"):
            errs.append(f"bad type/epistemic on {n['id']}: {n.get('type')}/{n.get('epistemic')}")
        if n.get("type") in EVIDENCE_TYPES - {"CuratedFact"}:
            src = n.get("source") or {}
            if not (src.get("page") or src.get("url")):
                errs.append(f"unsourced evidence node {n['id']}")
        if n.get("type") == "Assessment" and "justified" in (n.get("label") or "").lower():
            errs.append(f"assessment label asserts justification: {n['id']}")
    seen, linked = set(), set()
    keys = {"id", "from", "to", "type", "stance", "points", "axis", "group", "scope", "label"}
    for e in g.get("edges", []):
        if keys - e.keys():
            errs.append(f"edge {e.get('id')} missing keys {sorted(keys - e.keys())}")
            continue
        if e["id"] in seen:
            errs.append(f"duplicate edge id {e['id']}")
        seen.add(e["id"])
        a, b = nodes.get(e["from"]), nodes.get(e["to"])
        if a is None or b is None:
            errs.append(f"dangling edge {e['id']} ({e['from']} -> {e['to']})")
            continue
        linked.update((e["from"], e["to"]))
        allowed = EDGE_TYPES.get(e["type"])
        if allowed is None:
            errs.append(f"forbidden edge type {e['type']} on {e['id']}")
        elif a["type"] not in allowed[0] or b["type"] not in allowed[1]:
            errs.append(f"edge {e['id']} {e['type']} connects {a['type']} -> {b['type']}")
        if e["stance"] not in STANCES or e["axis"] not in AXES:
            errs.append(f"edge {e['id']} bad stance/axis {e['stance']}/{e['axis']}")
        if not isinstance(e["points"], int) or (e["points"] and e["type"] != "RULE_SCORES"):
            errs.append(f"edge {e['id']} carries points outside RULE_SCORES")
        if a["type"] == "CuratedFact" and e["scope"] != EXISTENCE:
            errs.append(f"regimen edge {e['id']} not scoped to existence of a threshold")
    for nid in nodes.keys() - linked:
        errs.append(f"orphan node {nid}")
    return errs
