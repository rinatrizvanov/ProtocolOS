"""Bounded, verifier-gated investigation of one review flag.

The user picks a criterion and one of four fixed questions; no free text reaches a model. The
investigator loads the stored review, builds the provenance graph for that criterion, runs at most
four whitelisted tool calls inside a 60 s budget, and writes a templated answer whose statements
each cite graph node ids. Every statement then goes through check_answer(): cited ids exist, the
cited edge stance matches the statement's polarity, quotes are verbatim in their source, every
number appears in a cited node, no overclaiming / necessity / causal / instruction language, every
NCT id is in the graph, and structured claims pass verifier.verify(). Counterevidence (the
opposite-stance evidence) is always gathered and must be cited.

Guardrails: documents are data (passage text is never interpreted; templates fill only from
structured fields), the classification is never changed, nothing is written to data/reviews/.
Each investigation appends one JSON line to AUDIT_DIR/YYYY-MM-DD.jsonl (UTC date).

Model mode is not built yet: mode="model" returns the deterministic answer with
model.status "not configured".
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime, timezone

from fastapi import HTTPException

from .sources import DATA
from .verifier import GUIDANCE_FOR_CATEGORY, NECESSITY, OVERCLAIM, RELEVANT_PROPERTY, verify

QUESTIONS = ("why_flagged", "contradicting", "support_retaining", "what_would_change")
MODES = ("deterministic", "model")
MAX_TOOL_CALLS = 4
MAX_MODEL_CALLS = 2
MAX_SECONDS = 60.0
AUDIT_DIR = DATA / "investigations"

# <<CHECK_START>>  pure section: chalk_project/build_investigator_eval.py inlines it into the Chalk bundle
STRUCTURAL = {"Criterion", "Assessment", "Classification", "Recommendation", "MissingEvidence", "ReviewerDecision"}
QUOTED_TYPES = {"Criterion", "Passage", "ComparatorThreshold"}
AXIS_STANCE = {"support": "supports", "challenge": "challenges"}
OPPOSITE = {"supports": "challenges", "challenges": "supports"}
POLARITIES = ("supports", "challenges", "context", "neutral")
REGISTRY_URL = "https://clinicaltrials.gov/study/"
# same strings as trialforge/review.py (kept literal so this section has no imports)
CLASS_REVIEW = "Review recommended"
CLASS_RETAIN = "Evidence supports retaining"
CLASS_INSUFFICIENT = "Insufficient evidence"

CAUSAL = re.compile(r"\b(?:caused|led to|because of|influenced|resulted in)\b", re.I)
INSTRUCTION = re.compile(
    r"\b(?:ignore|disregard)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions?\b|\bsystem prompt\b",
    re.I,
)
RETAIN_WORD = re.compile(r"\bretain", re.I)
NCT_TEXT = re.compile(r"\bNCT\d{8}\b")
NUMBER = re.compile(r"\d+(?:\.\d+)?")
QUOTED = re.compile(r"[\"“]([^\"“”]{12,})[\"”]")


def _norm(s: str) -> str:
    """Same normalization as trialforge.guidance.normalize (quote styles, dashes, soft hyphen, whitespace)."""
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-").replace("—", "-")
    s = s.replace("­", "")
    return re.sub(r"\s+", " ", s).strip()


def primary_polarity(question: str, classification: str | None) -> str | None:
    """The side of the evidence an answer is about; counterevidence is the opposite side."""
    if question == "why_flagged":
        return "challenges"
    if question == "support_retaining":
        return "supports"
    if question == "contradicting":
        return "challenges" if classification == CLASS_RETAIN else "supports"
    if question == "what_would_change":
        return {CLASS_REVIEW: "challenges", CLASS_RETAIN: "supports"}.get(classification)
    return None


def node_stances(graph: dict, assess_id: str) -> dict[str, set]:
    """Stance of every evidence node toward the assessment: a direct EVIDENCE_FOR edge, or membership
    of a firing ScoreRule (EVIDENCE_IN_RULE -> rule -RULE_SCORES-> assessment). Rules get their own stance;
    a member keeps its own edge stance and also takes the stance of the rule it scores through (a "same"
    comparator is context on its own but counts as support inside a firing same_comparators rule)."""
    st: dict[str, set] = {}
    rules: dict[str, str] = {}
    for e in graph.get("edges", []):
        if e.get("type") == "RULE_SCORES" and e.get("to") == assess_id:
            s = e.get("stance") or AXIS_STANCE.get(e.get("axis"))
            st.setdefault(e["from"], set()).add(s)
            rules[e["from"]] = s
    for e in graph.get("edges", []):
        t = e.get("type")
        if t == "EVIDENCE_FOR" and e.get("to") == assess_id:
            st.setdefault(e["from"], set()).add(e.get("stance"))
        elif t == "EVIDENCE_IN_RULE" and e.get("to") in rules:
            st.setdefault(e["from"], set()).update({e.get("stance"), rules[e["to"]]})
    return st


NODE_REF = re.compile(r"\b[a-z]+:[0-9a-f]{8,12}\b")  # hashed node ids (curated:/passage:/missing:) carry no facts


def _numbers(s: str) -> set:
    return {float(x) for x in NUMBER.findall(NCT_TEXT.sub(" ", s or ""))}


def _node_numbers(n: dict) -> set:
    data = {k: v for k, v in (n.get("data") or {}).items() if k != "members"}
    return _numbers(NODE_REF.sub(" ", json.dumps([n.get("label"), data, n.get("source")], ensure_ascii=False, default=str)))


def _graph_ncts(graph: dict) -> set:
    found = set()
    if graph.get("nct_id"):
        found.add(graph["nct_id"])
    for n in graph.get("nodes", []):
        found.update(NCT_TEXT.findall(n.get("id", "")))
        d, src = n.get("data") or {}, n.get("source") or {}
        for v in (d.get("nct_id"), src.get("nct")):
            if v:
                found.add(v)
    return found


def _review_item(review: dict, cid: str) -> dict | None:
    return next((x for x in review.get("reviews", []) if x["criterion"]["id"] == cid), None)


def language_checks(text: str, classification: str | None, sid=None, label: str = "") -> list[dict]:
    """Overclaiming, necessity, causal-between-trials and instruction language; 'retain' only when the
    classification is 'Evidence supports retaining'. Apply to our own words (verbatim quotes removed)."""
    out = []
    for name, rx in (("overclaim", OVERCLAIM), ("necessity", NECESSITY), ("causal", CAUSAL), ("instruction", INSTRUCTION)):
        m = rx.search(text or "")
        if m:
            out.append({"check": f"{label}{name}", "statement_id": sid, "result": "fail", "detail": f"\"{m.group(0)}\" is not allowed in an answer"})
    if classification != CLASS_RETAIN and RETAIN_WORD.search(text or ""):
        out.append({"check": f"{label}retain_implied", "statement_id": sid, "result": "fail",
                    "detail": f"mentions retaining while the classification is '{classification}'"})
    return out


def claims_from_nodes(cited: list[dict], crit: dict, review: dict, stances: dict, guidance_key) -> list[dict]:
    """Structured claims the cited nodes imply, for verifier.verify(): comparator thresholds, FDA quotes
    (only the guidance verify() accepts for this criterion category) and curated drug properties."""
    claims = []
    regimen = review.get("target", {}).get("regimen", {}).get("drugs", {})
    for n in cited:
        d, src = n.get("data") or {}, n.get("source") or {}
        if n["type"] == "ComparatorThreshold" and d.get("direction") != "different measure":
            claims.append({"type": "comparator_threshold", "nct_id": d.get("nct_id") or src.get("nct"),
                           "value": d.get("value_norm"), "unit": d.get("unit_norm")})
        elif n["type"] == "GuidancePassage" and src.get("quote"):
            gk = guidance_key(n)
            if gk and gk == GUIDANCE_FOR_CATEGORY.get(crit.get("category")):
                claims.append({"type": "fda_quote", "guidance": gk, "quote": src["quote"]})
        elif n["type"] == "CuratedFact":
            prop = RELEVANT_PROPERTY.get(crit.get("analyte"))
            summary = str(d.get("summary", "")).lower()
            positive = "supports" in stances.get(n["id"], set())
            for drug in sorted(regimen):
                if prop and drug in summary:
                    claims.append({"type": "drug_property", "drug": drug, "property": prop, "value": positive})
    return claims


def _memo(resolvers: dict) -> dict:
    cache: dict = {}

    def wrap(name):
        fn = resolvers[name]

        def call(*args):
            key = (name,) + tuple(json.dumps(a, sort_keys=True, default=str) if isinstance(a, dict) else a for a in args)
            if key not in cache:
                try:
                    cache[key] = fn(*args)
                except Exception as e:  # a resolver error is "could not check", never a pass
                    cache[key] = {"ok": None, "reason": str(e)[:200]} if name == "fda_quote" else None
            return cache[key]

        return call

    return {k: wrap(k) for k in resolvers}


def _quote_ok(n: dict, quote: str, res: dict):
    """True / False / None (could not check) for a quote attributed to node n."""
    src = n.get("source") or {}
    if n["type"] == "GuidancePassage":
        return res["fda_quote"](res["guidance_key"](n), quote).get("ok")
    if n["type"] in QUOTED_TYPES and src.get("nct"):
        if src.get("page") is None and str(src.get("url") or "").startswith(REGISTRY_URL):
            # quoted from the ClinicalTrials.gov eligibility text, not the protocol PDF
            return res["registry_quote"](src["nct"], quote) if "registry_quote" in res else None
        return res["protocol_quote"](src["nct"], quote)
    return None


def check_answer(answer: dict, graph: dict, review: dict, resolvers: dict | None = None) -> list[dict]:
    """Deterministic checks for an investigation answer. `answer` is the full investigate() response or
    its `answer` dict (then `counterevidence`, `question`, `criterion_id` may sit beside `statements`).
    resolvers: {"protocol_quote": fn(nct, quote) -> bool|None, "fda_quote": fn(guidance_key, quote) -> {"ok"},
    "guidance_key": fn(node) -> str|None, optional "registry_quote": fn(nct, quote) -> bool|None};
    default = the document-backed ones (no network for cached NCTs).
    Returns [{check, statement_id, result: pass|warn|fail, detail, node?}]."""
    if resolvers is None:
        resolvers = default_check_resolvers()
    res = _memo(resolvers)
    vres = {"protocol_quote": res["protocol_quote"], "fda_quote": res["fda_quote"],
            "nct_exists": lambda _n: None, "nct_threshold": lambda *_a: None}  # never fetch unknown NCTs
    ans = answer.get("answer", answer)
    statements = ans.get("statements") or []
    counter = answer.get("counterevidence", ans.get("counterevidence")) or []
    question = answer.get("question") or ans.get("question")
    cid = answer.get("criterion_id") or ans.get("criterion_id") or graph.get("criterion_id")
    nct = graph.get("nct_id") or review["target"]["study"]["nct_id"]
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    stances = node_stances(graph, f"assess:{nct}:{cid}")
    item = _review_item(review, cid) or {}
    classification = item.get("classification")
    crit = next((c for c in review.get("target", {}).get("criteria", []) if c["id"] == cid), {})
    ncts = _graph_ncts(graph)
    checks: list[dict] = []

    def add(check, sid, result, detail, node=None):
        c = {"check": check, "statement_id": sid, "result": result, "detail": detail}
        if node:
            c["node"] = node
        checks.append(c)

    def language(sid, text, label):
        checks.extend(language_checks(text, classification, sid, label))

    cited_anywhere: set = set()
    for s in statements:
        sid = s.get("id")
        text = s.get("text") or ""
        pol = s.get("polarity")
        ids = list(s.get("evidence_ids") or [])
        cited_anywhere.update(ids)
        unknown = [i for i in ids if i not in nodes]
        cited = [nodes[i] for i in ids if i in nodes]
        if not ids:
            add("evidence_exists", sid, "fail", "statement cites no graph node")
        elif unknown:
            add("evidence_exists", sid, "fail", f"not in the graph: {', '.join(unknown)}")
        else:
            add("evidence_exists", sid, "pass", f"{len(ids)} cited node(s) exist")

        # stance of the cited evidence must match the statement's polarity
        evid = [n for n in cited if n["type"] not in STRUCTURAL]
        if pol not in POLARITIES:
            add("polarity", sid, "fail", f"unknown polarity '{pol}'")
        elif pol == "neutral":
            if evid:
                add("polarity", sid, "fail", f"a neutral statement may cite only structural nodes, not {', '.join(n['id'] for n in evid)}")
            else:
                add("polarity", sid, "pass", "neutral statement cites structural nodes only")
        else:
            wrong = [n["id"] for n in evid if pol not in stances.get(n["id"], set())]
            if not evid:
                add("polarity", sid, "fail", f"a '{pol}' statement must cite evidence with that stance")
            elif wrong:
                add("polarity", sid, "fail", f"stance is not '{pol}' for {', '.join(wrong)}")
            else:
                add("polarity", sid, "pass", f"every cited evidence edge has stance '{pol}'")

        # quotes stored on cited source nodes are verbatim in their documents
        for n in cited:
            q = (n.get("source") or {}).get("quote")
            if not q or n["type"] not in QUOTED_TYPES | {"GuidancePassage"}:
                continue
            ok = _quote_ok(n, q, res)
            if ok is True:
                add("quote_verified", sid, "pass", f"{n['id']}: quote found verbatim in its source", node=n["id"])
            elif ok is False:
                add("quote_verified", sid, "fail", f"{n['id']}: quote not found verbatim in its source", node=n["id"])
            else:
                add("quote_verified", sid, "warn", f"{n['id']}: quote could not be checked", node=n["id"])

        # quoted text inside the statement must be verbatim in a cited source
        for q in QUOTED.findall(text):
            sources = [n for n in cited if (n.get("source") or {}).get("quote")]
            hit = any(_norm(q) in _norm(n["source"]["quote"]) for n in sources) or any(_quote_ok(n, q, res) is True for n in sources)
            add("text_quote", sid, "pass" if hit else "fail",
                f"\"{q[:60]}\" " + ("found verbatim in a cited source" if hit else "not found verbatim in any cited source"))

        # numbers, language, NCT ids
        allowed = set().union(*[_node_numbers(n) for n in cited]) if cited else set()
        stray = sorted(_numbers(text) - allowed)
        if stray:
            add("numbers", sid, "fail", f"not in any cited node: {', '.join(f'{x:g}' for x in stray)}")
        else:
            add("numbers", sid, "pass", "every number appears in a cited node")
        prose = QUOTED.sub(" ", text)  # verbatim quotes are checked above; language rules apply to our own words
        language(sid, prose, "")
        stray_nct = sorted(set(NCT_TEXT.findall(text)) - ncts)
        if stray_nct:
            add("nct_in_graph", sid, "fail", f"not in the graph: {', '.join(stray_nct)}")

        # structured claims through the deterministic verifier
        claims = s.get("claims") if s.get("claims") is not None else claims_from_nodes(cited, crit, review, stances, res["guidance_key"])
        if claims and crit:
            out = verify({"criterion_id": cid, "action": "justify_in_protocol", "claims": claims, "text": prose}, review, vres)
            fails = [c for c in out["checks"] if c["result"] == "fail"]
            warns = [c for c in out["checks"] if c["result"] == "warn"]
            if fails:
                add("verifier", sid, "fail", "; ".join(f"{c['check']}: {c['detail']}" for c in fails)[:600])
            elif warns:
                add("verifier", sid, "warn", "; ".join(f"{c['check']}: {c['detail']}" for c in warns)[:600])
            else:
                add("verifier", sid, "pass", f"{len(claims)} structured claim(s) verified")

    # answer level: counterevidence is listed and cited
    primary = primary_polarity(question, classification)
    if counter:
        bad = [i for i in counter if i not in nodes]
        if bad:
            add("counterevidence_exists", None, "fail", f"not in the graph: {', '.join(bad)}")
    if primary in OPPOSITE:
        opp = sorted(i for i, st in stances.items() if OPPOSITE[primary] in st)
        unlisted = [i for i in opp if i not in counter]
        unmentioned = [i for i in counter if i not in cited_anywhere]
        if unlisted:
            add("counterevidence_listed", None, "fail", f"opposite-stance evidence missing from counterevidence: {', '.join(unlisted)}")
        elif unmentioned:
            add("counterevidence_mentioned", None, "fail", f"counterevidence no statement cites: {', '.join(unmentioned)}")
        else:
            add("counterevidence", None, "pass", f"{len(opp)} opposite-stance node(s) listed and cited")
    language(None, QUOTED.sub(" ", ans.get("summary") or ""), "summary_")
    return checks


def label_statements(answer: dict, checks: list[dict], graph: dict) -> None:
    """Set status / failed_checks per statement: unsupported (any failed check), supported (cites a
    verified source_fact whose stance is the statement's polarity), else uncertain."""
    ans = answer.get("answer", answer)
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    stances = node_stances(graph, f"assess:{graph.get('nct_id')}:{answer.get('criterion_id') or graph.get('criterion_id')}")
    for s in ans.get("statements") or []:
        mine = [c for c in checks if c["statement_id"] == s.get("id")]
        s["failed_checks"] = [c["check"] for c in mine if c["result"] == "fail"]
        verified = {c.get("node") for c in mine if c["check"] == "quote_verified" and c["result"] == "pass"}
        pol = s.get("polarity")
        strong = any(
            i in verified and nodes[i].get("epistemic") == "source_fact" and nodes[i]["type"] not in STRUCTURAL
            and pol in OPPOSITE and pol in stances.get(i, set())
            for i in s.get("evidence_ids") or [] if i in nodes
        )
        s["status"] = "unsupported" if s["failed_checks"] else ("supported" if strong else "uncertain")
# <<CHECK_END>>


def default_check_resolvers() -> dict:
    """Document-backed resolvers: protocol quotes via verifier.default_resolvers()["protocol_quote"] (which
    takes the NCT, so comparator quotes are checked against the comparator's own protocol), FDA quotes via
    guidance.verify_quote, and the guidance document of a GuidancePassage node."""
    from .guidance import PASSAGES, normalize, verify_quote
    from .sources import FDA_GUIDANCES, REGISTRY_DIR
    from .verifier import default_resolvers

    by_key = {p[0]: p[1] for p in PASSAGES}

    def guidance_key(node):
        d, src = node.get("data") or {}, node.get("source") or {}
        if d.get("guidance") in FDA_GUIDANCES:
            return d["guidance"]
        if d.get("key") in by_key:
            return by_key[d["key"]]
        url = src.get("url") or ""
        return next((k for k, g in FDA_GUIDANCES.items() if url.startswith(g["url"])), None)

    def registry_quote(nct, quote):
        """Quote in the cached ClinicalTrials.gov eligibility text; None when the record is not cached
        (never fetched here)."""
        path = REGISTRY_DIR / f"{nct}.json"
        if not path.exists():
            return None
        study = json.loads(path.read_text())
        text = study.get("protocolSection", {}).get("eligibilityModule", {}).get("eligibilityCriteria", "")
        return normalize(quote) in normalize(text)

    return {"protocol_quote": default_resolvers()["protocol_quote"], "fda_quote": verify_quote, "guidance_key": guidance_key,
            "registry_quote": registry_quote}


def review_fingerprint(review: dict) -> str:
    return hashlib.sha256(json.dumps(review, sort_keys=True, default=list).encode()).hexdigest()


# ----------------------------------------------------------------------------- tools (whitelist)

def _tool_get_review(nct: str, as_of: str = "auto") -> dict:
    from .api import get_review

    return get_review(nct, as_of)


def _tool_build_graph(review: dict, criterion_id: str) -> dict:
    from .graph import build_graph  # WS-A; imported lazily so this module loads without it
    from .packet import load_decisions

    return build_graph(review, load_decisions(review["target"]["study"]["nct_id"]), criterion_id)


def _tool_protocol_page(nct: str, page: int) -> str | None:
    from .sources import fetch_protocol

    doc = fetch_protocol(nct)
    if not doc or not (1 <= int(page) <= len(doc.pages)):
        return None
    return doc.pages[int(page) - 1]


def _tool_chalk_registry_profile(nct: str) -> dict:
    from .chalk_bridge import registry_profile

    return registry_profile(nct)


TOOLS = {
    "get_review": _tool_get_review,
    "build_graph": _tool_build_graph,
    "protocol_page": _tool_protocol_page,
    "chalk_registry_profile": _tool_chalk_registry_profile,
}
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="investigate")


def _summary_of(name: str, result) -> str:
    if name == "get_review":
        return f"review {result['target']['study']['nct_id']} as of {result.get('as_of')}: {len(result.get('reviews', []))} criteria"
    if name == "build_graph":
        return f"{len(result.get('nodes', []))} nodes, {len(result.get('edges', []))} edges, {len(result.get('validation') or [])} validation issue(s)"
    if name == "protocol_page":
        return "page not available" if result is None else f"{len(result)} characters of cached page text"
    if name == "chalk_registry_profile":
        r = result or {}
        return f"status {r.get('status')}" + (f", query {r['query_id']}" if r.get("query_id") else "")
    return type(result).__name__


class _Runner:
    """Executes whitelisted tool calls under the call and time budget; records every attempt."""

    def __init__(self):
        self.t0 = time.monotonic()
        self.calls: list[dict] = []
        self.used = 0
        self.dropped = 0
        self.checks: list[dict] = []

    def remaining(self) -> float:
        return MAX_SECONDS - (time.monotonic() - self.t0)

    def _admit(self) -> bool:
        if self.used >= MAX_TOOL_CALLS or self.remaining() <= 0:
            self.dropped += 1
            return False
        self.used += 1
        return True

    def refuse(self, name: str, shown_args: dict, check: str, reason: str) -> None:
        """A planned call outside the whitelist or its scope: counted against the budget, never executed."""
        if not self._admit():
            return
        self.calls.append({"tool": name, "args": shown_args, "ms": 0, "result_summary": f"refused: {reason}"})
        self.checks.append({"check": check, "statement_id": None, "result": "fail", "detail": f"{name} refused: {reason}; not executed"})

    def call(self, name: str, shown_args: dict, required: bool = False, **kwargs):
        if name not in TOOLS:
            return self.refuse(name, shown_args, "tool_whitelist", "not a whitelisted tool")
        if not self._admit():
            return None
        t = time.monotonic()
        fut = _POOL.submit(TOOLS[name], **kwargs)
        ms = lambda: round((time.monotonic() - t) * 1000)  # noqa: E731
        try:
            result = fut.result(timeout=max(self.remaining(), 0.001))
        except FutureTimeout:
            self.calls.append({"tool": name, "args": shown_args, "ms": ms(), "result_summary": "timed out (60 s budget)"})
            if required:
                raise HTTPException(504, f"investigation time budget exceeded during {name}")
            return None
        except HTTPException:
            raise
        except Exception as e:
            self.calls.append({"tool": name, "args": shown_args, "ms": ms(), "result_summary": f"error: {type(e).__name__}"})
            if required:
                raise
            return None
        self.calls.append({"tool": name, "args": shown_args, "ms": ms(), "result_summary": _summary_of(name, result)})
        return result


def plan_steps(question: str, graph: dict, review: dict, criterion_id: str) -> list[tuple[str, dict]]:
    """Fixed per-question follow-up plan, run after get_review and build_graph."""
    nct = review["target"]["study"]["nct_id"]
    crit = next((n for n in graph["nodes"] if n["type"] == "Criterion"), None)
    page = ((crit or {}).get("source") or {}).get("page")
    steps: list[tuple[str, dict]] = []
    if question in ("why_flagged", "contradicting", "support_retaining") and page:
        steps.append(("protocol_page", {"nct": nct, "page": page}))
    if question == "why_flagged":
        steps.append(("chalk_registry_profile", {"nct": nct}))
    return steps


PLANNER = plan_steps  # tests replace this to show the budget holds


# ----------------------------------------------------------------------------- answer templates

def _fv(v) -> str:
    if v is None:
        return "?"
    v = float(v)
    return str(int(v)) if v.is_integer() else f"{v:g}"


def _join(xs: list[str]) -> str:
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def _crit_text(node: dict) -> str:
    d = node.get("data") or {}
    return f"{d.get('label')} {d.get('operator')}{_fv(d.get('value_norm'))} {d.get('unit_norm')}"


def _cmp_name(n: dict) -> str:
    d = n.get("data") or {}
    nct = d.get("nct_id") or (n.get("source") or {}).get("nct")
    return f"{d['acronym']} ({nct})" if d.get("acronym") else nct


def _cmp_value(n: dict) -> str:
    d = n.get("data") or {}
    return f"{d.get('operator')}{_fv(d.get('value_norm'))} {d.get('unit_norm')}"


def _timing(fda: list[dict]) -> str:
    issued = sorted({(n.get("data") or {}).get("issued") for n in fda if (n.get("data") or {}).get("issued")})
    if not issued:
        return ""
    retro = [bool((n.get("data") or {}).get("retrospective")) for n in fda]
    if all(retro):
        return f" Issued {_join(issued)}, after this trial started; applied retrospectively, not a standard available when the trial was designed."
    if not any(retro):
        return f" Issued {_join(issued)}, before this trial started."
    return f" Issued {_join(issued)}; passages issued after this trial started are applied retrospectively."


class _Ctx:
    def __init__(self, graph: dict, review: dict, cid: str):
        self.graph, self.review, self.cid = graph, review, cid
        self.nct = graph.get("nct_id") or review["target"]["study"]["nct_id"]
        self.nodes = {n["id"]: n for n in graph["nodes"]}
        self.assess = f"assess:{self.nct}:{cid}"
        self.crit_id = f"crit:{self.nct}:{cid}"
        self.class_id = f"class:{self.nct}:{cid}"
        self.stances = node_stances(graph, self.assess)
        self.item = _review_item(review, cid)
        self.classification = self.item["classification"]
        self.crit = self.nodes.get(self.crit_id) or {"data": {**self.item["criterion"], "criterion_id": cid}}
        self.rules = {e["from"] for e in graph["edges"] if e.get("type") == "RULE_SCORES" and e.get("to") == self.assess}
        self.members = {r: [e["from"] for e in graph["edges"] if e.get("type") == "EVIDENCE_IN_RULE" and e.get("to") == r] for r in self.rules}
        self.points = {e["from"]: e.get("points") for e in graph["edges"] if e.get("type") == "RULE_SCORES" and e.get("to") == self.assess}
        self.missing = [e["to"] for e in graph["edges"] if e.get("type") == "ASSESSMENT_LACKS" and e.get("from") == self.assess and e["to"] in self.nodes]

    def anchors(self) -> list[str]:
        return [self.crit_id] if self.crit_id in self.nodes else []


def _stmt(lead: str, rest: str, polarity: str, ids: list[str]) -> dict:
    return {"lead": lead, "text": (lead + (" " + rest if rest else "")).strip(), "polarity": polarity, "evidence_ids": list(dict.fromkeys(ids))}


def _classification_statement(c: _Ctx) -> dict:
    sc = c.item.get("scores") or {}
    lead = f"TrialLens classified {_crit_text(c.crit)} as '{c.classification}' (support score {sc.get('support')}, challenge score {sc.get('challenge')})."
    rest = {CLASS_REVIEW: "This is a question for the protocol team to review, not a finding that the threshold is wrong.",
            CLASS_INSUFFICIENT: "The retrieved evidence does not settle this threshold either way."}.get(c.classification, "")
    ids = [i for i in (c.assess, c.class_id) if i in c.nodes] + c.anchors()
    return _stmt(lead, rest, "neutral", ids)


def _rule_statement(c: _Ctx, rule_id: str, stance: str) -> dict:
    rule = c.nodes[rule_id]
    d = rule.get("data") or {}
    group = d.get("group")
    pts = d.get("points", c.points.get(rule_id))
    axis = d.get("axis") or {"supports": "support", "challenges": "challenge"}.get(stance)
    members = [c.nodes[m] for m in c.members.get(rule_id, []) if m in c.nodes]
    score = f"+{_fv(pts)} {axis}"
    crit = _crit_text(c.crit)
    ids = [rule_id] + [m["id"] for m in members] + c.anchors()
    if group in ("looser_comparators", "same_comparators", "stricter_comparators"):
        cmps = [m for m in members if m["type"] == "ComparatorThreshold"]
        values = sorted({_cmp_value(m) for m in cmps})
        names = _join([_cmp_name(m) for m in cmps]) if cmps else "Comparable trials"
        if group == "looser_comparators":
            cov = sorted({((m.get("data") or {}).get("coverage") or {}).get("status") for m in cmps} - {None})
            lead = f"{names} used {_join(values)}, more permissive than {crit} (looser-comparators rule: {score}, group maximum)."
            rest = (f"Regimen coverage: {_join(cov)}. " if cov else "") + \
                "A more permissive threshold in a comparable trial shows the value was used, not that it was safe for this regimen."
        elif group == "same_comparators":
            lead = f"{names} used the same value as {crit} (same-threshold rule: {score})."
            rest = "Agreement may reflect template carry-forward rather than independent justification."
        else:
            lead = f"{names} used a stricter threshold ({_join(values)}) than {crit} (stricter-comparators rule: {score})."
            rest = ""
        return _stmt(lead, rest, stance, ids)
    if group in ("regimen_support", "regimen_challenge"):
        facts = [m for m in members if m["type"] == "CuratedFact"]
        summary = " ".join(str((m.get("data") or {}).get("summary", "")).strip() for m in facts).strip()
        scope = "; it supports having a threshold, not its value" if group == "regimen_support" else ""
        lead = f"Regimen rule from the curated pharmacology table ({score}{scope})."
        return _stmt(lead, summary, stance, ids)
    if group == "protocol_value_specific":
        pages = sorted({(m.get("source") or {}).get("page") for m in members} - {None})
        where = f" (p. {_join([str(p) for p in pages])})" if pages else ""
        return _stmt(f"Protocol text references the threshold value{where} (value-specific rationale rule: {score}).", "", stance, ids)
    if group == "specific_fda":
        fda = [m for m in members if m["type"] == "GuidancePassage"]
        return _stmt(f"FDA guidance makes a specific recommendation for this criterion (specific-FDA rule: {score}).", _timing(fda).strip(), stance, ids)
    return _stmt(f"Scoring rule {group} applies ({score}).", "", stance, ids)


def _loose_statements(c: _Ctx, stance: str, nodes: list[dict]) -> list[dict]:
    """Evidence with this stance that is not in a firing rule (EVIDENCE_FOR, no points)."""
    out = []
    crit = _crit_text(c.crit)
    passages = [n for n in nodes if n["type"] == "Passage"]
    if passages:
        pages = sorted({(n.get("source") or {}).get("page") for n in passages} - {None})
        where = f"p. {_join([str(p) for p in pages])}" if pages else "elsewhere"
        if stance == "context":
            out.append(_stmt(f"The protocol discusses this topic on {where}.",
                             f"The passage does not state why {crit} was chosen; it is shown as context and does not add to either score.",
                             stance, [n["id"] for n in passages] + c.anchors()))
        else:
            out.append(_stmt(f"Protocol text on {where} bears on this criterion; it does not add to the score here.", "", stance,
                             [n["id"] for n in passages] + c.anchors()))
    cmps = [n for n in nodes if n["type"] == "ComparatorThreshold"]
    by_dir: dict[str, list[dict]] = {}
    for n in cmps:
        by_dir.setdefault((n.get("data") or {}).get("direction") or "", []).append(n)
    for direction, group in by_dir.items():
        names = _join([_cmp_name(n) for n in group])
        vals = _join(sorted({_cmp_value(n) for n in group}))
        ids = [n["id"] for n in group] + c.anchors()
        if direction == "same":
            out.append(_stmt(f"{names} used {vals}, the same value as {crit}.",
                             "Agreement may reflect template carry-forward rather than independent justification; it does not add to the score here.",
                             stance, ids))
        elif direction == "different measure":
            out.append(_stmt(f"{names} use a different measure for this criterion and are not directly comparable.", "", stance, ids))
        elif direction == "comparator looser":
            out.append(_stmt(f"{names} used {vals}, more permissive than {crit}.",
                             "A more permissive threshold shows the value was used, not that it was safe for this regimen.", stance, ids))
        elif direction == "comparator stricter":
            out.append(_stmt(f"{names} used a stricter threshold ({vals}) than {crit}.", "", stance, ids))
        else:
            out.append(_stmt(f"{names} report {vals} for this criterion.", "", stance, ids))
    fda = [n for n in nodes if n["type"] == "GuidancePassage"]
    for strength in sorted({(n.get("data") or {}).get("strength") or "general" for n in fda}):
        group = [n for n in fda if ((n.get("data") or {}).get("strength") or "general") == strength]
        kind = "General" if strength == "general" else "Specific"
        what = {"challenges": "ask that criteria of this kind be justified or kept no more restrictive than needed",
                "supports": "describe reasons for criteria of this kind",
                "context": "give background for criteria of this kind"}.get(stance, "bear on this criterion")
        out.append(_stmt(f"{kind} FDA guidance passages {what}; they do not add to the score.", _timing(group).strip(), stance,
                         [n["id"] for n in group]))
    facts = [n for n in nodes if n["type"] == "CuratedFact"]
    if facts:
        summary = " ".join(str((n.get("data") or {}).get("summary", "")).strip() for n in facts)
        out.append(_stmt("Curated pharmacology (not scored here).", summary, stance, [n["id"] for n in facts]))
    other = [n for n in nodes if n["type"] not in ("Passage", "ComparatorThreshold", "GuidancePassage", "CuratedFact")]
    if other:
        out.append(_stmt(f"Further {stance} evidence: {_join(sorted({n['type'] for n in other}))}.", "", stance, [n["id"] for n in other]))
    return out


def _side_statements(c: _Ctx, stance: str, include_fda: bool = True) -> list[dict]:
    out = [_rule_statement(c, r, stance) for r in sorted(c.rules) if stance in c.stances.get(r, set())]
    in_rules = {m for r in c.rules for m in c.members.get(r, [])}
    loose = [c.nodes[i] for i, st in c.stances.items()
             if stance in st and i in c.nodes and i not in c.rules and i not in in_rules and c.nodes[i]["type"] not in STRUCTURAL
             and (include_fda or c.nodes[i]["type"] != "GuidancePassage")]
    loose.sort(key=lambda n: n["id"])
    return out + _loose_statements(c, stance, loose)


RULE_EFFECT = {
    "protocol_value_specific": "the value-specific protocol rule, which adds to the support score; under the classification rule a criterion with a value-specific rationale is not classified 'Review recommended'",
    "looser_comparators": "the comparator rules",
    "same_comparators": "the comparator rules",
    "stricter_comparators": "the comparator rules",
    "regimen_support": "the regimen rule",
    "regimen_challenge": "the regimen rule",
    "specific_fda": "the specific-FDA rule",
}


def _missing_statements(c: _Ctx, per_item: bool) -> list[dict]:
    items = [c.nodes[i] for i in c.missing]
    if not items:
        return []
    if not per_item:
        texts = "; ".join(str((n.get("data") or {}).get("text", "")).rstrip(".") for n in items)
        return [_stmt(f"Missing evidence: {texts}.", "", "neutral", [n["id"] for n in items] + [c.assess])]
    out = []
    for n in items:
        d = n.get("data") or {}
        effect = RULE_EFFECT.get(d.get("affects_rule"), "no scoring rule; it would inform the clinical review rather than the score")
        out.append(_stmt(f"Missing: {str(d.get('text', '')).rstrip('.')}.", f"If found, it would bear on {effect}.", "neutral", [n["id"], c.assess]))
    return out


def _compose(question: str, c: _Ctx) -> tuple[list[dict], list[str], set]:
    """Statements, counterevidence node ids, and the ids of the statements that answer the question."""
    primary = primary_polarity(question, c.classification)
    opp = OPPOSITE.get(primary) if primary else None
    counter = sorted(i for i, st in c.stances.items() if opp and opp in st)
    crit = _crit_text(c.crit)
    stmts = [_classification_statement(c)]
    main: list[dict] = []
    if question == "what_would_change":
        main = _missing_statements(c, per_item=True)
        if not main:
            stmts.append(_stmt(f"The review lists no missing-evidence items for {crit}.",
                               "TrialLens cannot say what further information would change this classification.", "neutral", [c.assess]))
        stmts += main
    else:
        main = _side_statements(c, primary)
        if not main:
            label = {"supports": "support-side", "challenges": "challenge-side"}[primary]
            stmts.append(_stmt(f"No {label} evidence for {crit} is in the graph.",
                               "Insufficient evidence: without comparable precedent or protocol rationale on this side there is nothing to cite.",
                               "neutral", [c.assess]))
        stmts += main
        if question == "why_flagged":
            stmts += _side_statements(c, "context", include_fda=False)
    if opp:
        stmts += [dict(s, lead="Counterevidence: " + s["lead"], text="Counterevidence: " + s["text"]) for s in _side_statements(c, opp)]
    if question == "why_flagged":
        stmts += _missing_statements(c, per_item=False)
    for k, s in enumerate(stmts, start=1):
        s["id"] = f"s{k}"
    return stmts, counter, {s["id"] for s in main}


def _overall(statements: list[dict], main_ids: set, answer_fail: bool) -> str:
    main = [s for s in statements if s["id"] in main_ids and s["status"] != "unsupported"]
    if not main:
        return "insufficient_evidence"
    if any(s["status"] == "supported" for s in main) and not answer_fail:
        return "supported"
    return "uncertain"


def _write_audit(record: dict) -> str | None:
    try:
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with open(AUDIT_DIR / f"{day}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        return None
    except OSError as e:
        return f"{type(e).__name__}: {e}"


# ----------------------------------------------------------------------------- entry point

def investigate(nct: str, criterion_id: str, question: str, as_of: str = "auto", mode: str = "deterministic") -> dict:
    if question not in QUESTIONS:
        raise HTTPException(400, f"question must be one of {', '.join(QUESTIONS)}")
    if mode not in MODES:
        raise HTTPException(400, f"mode must be one of {', '.join(MODES)}")
    run = _Runner()
    review = run.call("get_review", {"nct": nct, "as_of": as_of}, required=True, nct=nct, as_of=as_of)
    if review is None:
        raise HTTPException(503, "investigation budget exhausted before the review was loaded")
    if _review_item(review, criterion_id) is None:
        raise HTTPException(404, f"criterion '{criterion_id}' is not in the review of {review['target']['study']['nct_id']}")
    fingerprint = review_fingerprint(review)
    graph = run.call("build_graph", {"criterion_id": criterion_id}, required=True, review=review, criterion_id=criterion_id)
    if graph is None:
        raise HTTPException(503, "investigation budget exhausted before the evidence graph was built")
    c = _Ctx(graph, review, criterion_id)
    if c.assess not in c.nodes:
        raise HTTPException(500, f"evidence graph has no assessment node {c.assess}")

    process: list[dict] = []
    gfp = (graph.get("built_from") or {}).get("fingerprint")
    process.append({"check": "fingerprint", "statement_id": None, "result": "pass" if gfp == fingerprint else "warn",
                    "detail": "graph built from this review" if gfp == fingerprint else "graph fingerprint differs from the review used"})
    cls_node = c.nodes.get(c.class_id)
    same_cls = cls_node is not None and (cls_node.get("label") == c.classification or (cls_node.get("data") or {}).get("classification") == c.classification)
    process.append({"check": "classification_unchanged", "statement_id": None, "result": "pass" if same_cls else "fail",
                    "detail": f"'{c.classification}' (from the stored review; never changed here)"})
    if graph.get("validation"):
        process.append({"check": "graph_validation", "statement_id": None, "result": "warn", "detail": "; ".join(map(str, graph["validation"]))[:300]})
    for w in graph.get("warnings") or []:
        if str(w).startswith("attribution_mismatch"):
            process.append({"check": "attribution", "statement_id": None, "result": "warn", "detail": f"{w}: rule points differ from stored scores"})

    ncts_in_graph = _graph_ncts(graph)
    crit_src = c.crit.get("source") or {}
    for tool, args in PLANNER(question, graph, review, criterion_id):
        args = dict(args or {})
        if tool == "get_review":
            run.call("get_review", {"nct": nct, "as_of": as_of}, nct=nct, as_of=as_of)
        elif tool == "build_graph":
            run.call("build_graph", {"criterion_id": criterion_id}, review=review, criterion_id=criterion_id)
        elif tool == "protocol_page":
            if args.get("nct") not in ncts_in_graph or not str(args.get("page", "")).isdigit():
                run.refuse(tool, args, "tool_scope", "only pages of NCTs already in the graph")
                continue
            text = run.call("protocol_page", args, nct=args["nct"], page=int(args["page"]))
            if text is not None and crit_src.get("quote") and int(args["page"]) == crit_src.get("page") and args["nct"] == c.nct:
                on_page = _norm(crit_src["quote"]) in _norm(text)
                process.append({"check": "criterion_on_page", "statement_id": None, "result": "pass" if on_page else "fail",
                                "detail": f"criterion text {'found' if on_page else 'not found'} on protocol p.{args['page']}"})
        elif tool == "chalk_registry_profile":
            if args.get("nct") not in ncts_in_graph:
                run.refuse(tool, args, "tool_scope", "only NCTs already in the graph")
                continue
            prof = run.call("chalk_registry_profile", {"nct": args["nct"]}, nct=args["nct"])
            if prof is not None:
                process.append({"check": "registry_profile", "statement_id": None, "result": "pass" if prof.get("status") == "ok" else "warn",
                                "detail": f"Chalk registry profile ({args['nct']}): {prof.get('status')}"})
        else:
            run.call(tool, args)  # not whitelisted: refused and counted
    if run.dropped:
        process.append({"check": "budget", "statement_id": None, "result": "warn",
                        "detail": f"plan asked for {run.dropped} more tool call(s); stopped at {MAX_TOOL_CALLS}"})

    statements, counter, main_ids = _compose(question, c)
    leads = {s["id"]: s.pop("lead") for s in statements}
    answer = {"summary": "", "overall": "insufficient_evidence", "statements": statements}
    resp_core = {"question": question, "criterion_id": criterion_id, "answer": answer, "counterevidence": counter}
    checks = check_answer(resp_core, graph, review)
    label_statements(resp_core, checks, graph)
    answer_fail = any(ch["result"] == "fail" and ch["statement_id"] is None for ch in checks)
    answer["overall"] = _overall(statements, main_ids, answer_fail)
    # unsupported statements stay in `statements` (shown struck through) and never enter the summary
    answer["summary"] = " ".join(leads[s["id"]] for s in statements
                                 if s["status"] != "unsupported" and s["polarity"] != "context" and s["text"].startswith(leads[s["id"]]))
    checks += language_checks(QUOTED.sub(" ", answer["summary"]), c.classification, None, "summary_")

    model = {"status": "not configured" if mode == "model" else "not_used", "provider": None}
    elapsed = round(time.monotonic() - run.t0, 3)
    audit_id = f"inv-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    budget = {"max_tool_calls": MAX_TOOL_CALLS, "used": run.used, "max_model_calls": MAX_MODEL_CALLS, "used_model": 0,
              "max_seconds": MAX_SECONDS, "dropped": run.dropped}
    all_checks = run.checks + process + checks
    out = {
        "nct_id": review["target"]["study"]["nct_id"], "criterion_id": criterion_id, "question": question,
        "mode": "deterministic", "classification": c.classification, "answer": answer, "counterevidence": counter,
        "tool_calls": run.calls, "tools_used": [t["tool"] for t in run.calls if not t["result_summary"].startswith("refused")],
        "checks": all_checks, "budget": budget, "elapsed_s": elapsed, "model": model, "audit_id": audit_id,
        "graph_delta": {"nodes": [], "edges": []},
    }
    err = _write_audit({
        "id": audit_id, "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "nct_id": out["nct_id"],
        "criterion_id": criterion_id, "question": question, "mode": out["mode"], "fingerprint": fingerprint,
        "tools": out["tools_used"], "tool_calls": run.calls, "budget": budget, "checks": all_checks,
        "result": {"classification": c.classification, "overall": answer["overall"], "counterevidence": counter,
                   "statements": [{k: s[k] for k in ("id", "polarity", "status", "evidence_ids", "failed_checks")} for s in statements]},
        "elapsed_s": elapsed,
    })
    if err:
        out["checks"].append({"check": "audit_log", "statement_id": None, "result": "warn", "detail": f"audit line not written: {err}"})
    return out
