"""Provenance graph + score attribution invariants (cached EL3 review in data/reviews; no network)."""
import copy
import importlib.util
import json
import re
import sys
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from trialforge import api
from trialforge.graph import build_graph, contributions, validate_graph
from trialforge.packet import load_decisions
from trialforge.sources import DATA
from trialforge.verifier import OVERCLAIM

NCT = "NCT03409614"
ENERGY, LOOSER = "NCT03351361", {"NCT03215706", "NCT02477826", "NCT02220894"}


@pytest.fixture(scope="module")
def el3():
    return api.get_review(NCT)


@pytest.fixture(scope="module")
def hb(el3):
    return build_graph(el3, {}, "hemoglobin")


def by_type(g, t):
    return [n for n in g["nodes"] if n["type"] == t]


def out_edges(g, nid):
    return [e for e in g["edges"] if e["from"] == nid]


def rule_sums(g, cid):
    s = {"support": 0, "challenge": 0}
    for e in g["edges"]:
        if e["type"] == "RULE_SCORES" and e["to"] == f"assess:{NCT}:{cid}":
            s[e["axis"]] += e["points"]
    return s


def test_validation_empty_for_every_criterion_and_full_graph(el3):
    cids = [rv["criterion"]["id"] for rv in el3["reviews"]]
    assert len(cids) == 11
    for cid in cids + [None]:
        g = build_graph(el3, {}, cid)
        assert g["validation"] == [] and validate_graph(g) == [], cid
        assert g["criterion_id"] == cid and g["nct_id"] == NCT


def test_ids_stable_across_builds(el3):
    a, b = build_graph(el3), build_graph(el3)
    assert [n["id"] for n in a["nodes"]] == [n["id"] for n in b["nodes"]]
    assert [e["id"] for e in a["edges"]] == [e["id"] for e in b["edges"]]
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    # the per-criterion graph uses the same ids as the full graph
    full = {n["id"] for n in a["nodes"]}
    assert {n["id"] for n in build_graph(el3, {}, "hemoglobin")["nodes"]} <= full


def test_hemoglobin_shape(hb):
    nodes = {n["id"]: n for n in hb["nodes"]}
    cmp_out = [e for e in hb["edges"] if nodes[e["from"]]["type"] == "ComparatorThreshold"]
    challenges = [e for e in cmp_out if e["stance"] == "challenges"]
    assert len(challenges) == 3
    assert {nodes[e["from"]]["data"]["nct_id"] for e in challenges} == LOOSER
    assert all(e["type"] == "EVIDENCE_IN_RULE" and e["group"] == "looser_comparators" and e["points"] == 0 for e in challenges)
    context = [e for e in cmp_out if e["stance"] == "context"]
    assert len(context) == 1 and context[0]["from"] == f"cmpthr:{ENERGY}:hemoglobin" and context[0]["type"] == "EVIDENCE_FOR"

    (cur,) = by_type(hb, "CuratedFact")
    assert cur["data"]["existence_only"] is True and cur["epistemic"] == "curated_pharmacology"
    (reg,) = out_edges(hb, cur["id"])
    assert reg["scope"] == "existence_of_threshold" and reg["group"] == "regimen_support"
    assert all(e["scope"] is None for e in hb["edges"] if e["type"] in ("EVIDENCE_FOR", "EVIDENCE_IN_RULE") and e["from"] != cur["id"])

    rules = {n["data"]["group"]: n for n in by_type(hb, "ScoreRule")}
    assert set(rules) == {"regimen_support", "looser_comparators"}
    assert (rules["regimen_support"]["data"]["points"], rules["regimen_support"]["data"]["axis"]) == (1, "support")
    assert (rules["looser_comparators"]["data"]["points"], rules["looser_comparators"]["data"]["axis"]) == (2, "challenge")
    assert {m.split(":")[1] for m in rules["looser_comparators"]["data"]["members"]} == LOOSER

    (p51,) = by_type(hb, "Passage")
    assert p51["source"]["page"] == 51
    assert [(e["type"], e["stance"]) for e in out_edges(hb, p51["id"])] == [("EVIDENCE_FOR", "context")]

    fda = by_type(hb, "GuidancePassage")
    assert len(fda) == 14
    assert all(e["type"] == "EVIDENCE_FOR" and e["points"] == 0 for n in fda for e in out_edges(hb, n["id"]))
    assert len(by_type(hb, "MissingEvidence")) == 2
    (assess,) = by_type(hb, "Assessment")
    assert assess["label"] == "Assessment of Hemoglobin ≥10 g/dL"


def test_every_guidance_passage_is_retrospective(el3):
    fda = by_type(build_graph(el3), "GuidancePassage")
    assert fda and all(n["data"]["retrospective"] is True for n in fda)


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


def test_no_node_text_overclaims(el3):
    """Labels are generated here and must never match. The only data match allowed is the verbatim
    review.py suggested_action text "...not evidence that a lower value is safe..." (a negation that the
    regex cannot tell apart; CR note filed in the spec)."""
    g = build_graph(el3, load_decisions(NCT))
    rec_texts = {rv["suggested_action"]["text"] for rv in el3["reviews"]}
    for n in g["nodes"]:
        assert not OVERCLAIM.search(n["label"] or ""), n["id"]
        for s in _strings(n["data"]):
            m = OVERCLAIM.search(s)
            if m:
                negated = re.search(r"not evidence that [^.]*$", s[: m.start()])
                assert n["type"] == "Recommendation" and s in rec_texts and negated, (n["id"], m.group(0))


def test_p51_passage_is_one_node_cited_by_two_criteria(el3):
    g = build_graph(el3)
    p51 = [n for n in by_type(g, "Passage") if n["source"]["page"] == 51]
    assert len(p51) == 1
    assert sorted(e["to"] for e in out_edges(g, p51[0]["id"])) == [f"assess:{NCT}:anc", f"assess:{NCT}:hemoglobin"]


def test_contained_same_page_passages_merge_and_keep_edges(el3):
    r = copy.deepcopy(el3)
    item = next(rv for rv in r["reviews"] if rv["criterion"]["id"] == "hemoglobin")
    url = r["target"]["study"]["protocol_docs"][0]["url"]
    long_q = "Hemoglobin of at least 10 g/dL is required at entry because of the risk of anemia with pemetrexed."
    short_q = "required at entry because of the  risk of anemia"  # contained after whitespace normalization
    item["evidence"] += [
        {"kind": "protocol", "stance": "context", "strength": "weak", "page": 200, "quote": short_q, "url": url, "summary": "x"},
        {"kind": "protocol", "stance": "supports", "strength": "moderate", "page": 200, "quote": long_q, "url": url, "summary": "y"},
    ]
    item["scores"]["support"] += 2  # the value-specific passage fires protocol_value_specific
    g = build_graph(r, {}, "hemoglobin")
    merged = [n for n in by_type(g, "Passage") if n["source"]["page"] == 200]
    assert len(merged) == 1 and merged[0]["source"]["quote"] == long_q and merged[0]["data"]["value_specific"] is True
    kinds = sorted((e["type"], e["stance"]) for e in out_edges(g, merged[0]["id"]))
    assert kinds == [("EVIDENCE_FOR", "context"), ("EVIDENCE_IN_RULE", "supports")]
    assert g["validation"] == [] and g["warnings"] == []


def test_reviewer_decision_node(el3):
    d = {"hemoglobin": {"decision": "defer", "label": "Defer / need more evidence", "reason": "r", "reviewer": "t", "recorded_at": "x"}}
    g = build_graph(el3, d, "hemoglobin")
    (dec,) = by_type(g, "ReviewerDecision")
    assert dec["id"] == f"decision:{NCT}:hemoglobin" and dec["epistemic"] == "human"
    assert [e["type"] for e in g["edges"] if e["to"] == dec["id"]] == ["CLASSIFICATION_DECIDED_BY"]
    assert g["validation"] == []


# --- attribution (AC2) ---------------------------------------------------------------------------

@pytest.mark.parametrize("as_of", ["auto", "none"])
def test_attribution_reconciles_with_stored_scores(as_of):
    p = DATA / "reviews" / f"{NCT}_{as_of}.json"
    if not p.exists():
        pytest.skip(f"{p.name} not cached (run the review with as_of={as_of} first)")
    r = json.loads(p.read_text())
    g = build_graph(r)
    assert g["warnings"] == []
    for rv in r["reviews"]:
        cid = rv["criterion"]["id"]
        assert rule_sums(g, cid) == rv["scores"], cid
        c = contributions(rv, r["comparison"][cid])
        for axis in ("support", "challenge"):
            assert sum(x["points"] for x in c if x["axis"] == axis) == rv["scores"][axis], (cid, axis)


def test_hemoglobin_attribution(el3):
    rv = next(x for x in el3["reviews"] if x["criterion"]["id"] == "hemoglobin")
    c = {x["group"]: x for x in contributions(rv, el3["comparison"]["hemoglobin"])}
    fired = {g: (x["axis"], x["points"]) for g, x in c.items() if x["fires"]}
    assert fired == {"regimen_support": ("support", 1), "looser_comparators": ("challenge", 2)}
    assert "specific_fda" not in c  # 14 general FDA passages add 0
    assert c["same_comparators"]["points"] == 0 and not c["same_comparators"]["fires"]


def test_coverage_comes_from_comparison_rows_not_strength(el3):
    rv = next(x for x in el3["reviews"] if x["criterion"]["id"] == "hemoglobin")
    rows = copy.deepcopy(el3["comparison"]["hemoglobin"])
    for row in rows:
        row["coverage"]["status"] = "partial"  # evidence strength stays "moderate"
    assert {e["strength"] for e in rv["evidence"] if e["kind"] == "comparator" and e["stance"] == "challenges"} == {"moderate"}
    looser = next(x for x in contributions(rv, rows) if x["group"] == "looser_comparators")
    assert looser["points"] == 1
    # real case: washout_surgery comparators have coverage n/a and strength "moderate" -> 1, not 2
    ws = next(x for x in el3["reviews"] if x["criterion"]["id"] == "washout_surgery")
    assert next(x for x in contributions(ws, el3["comparison"]["washout_surgery"]) if x["group"] == "looser_comparators")["points"] == 1


def test_attribution_mismatch_warns(el3):
    r = copy.deepcopy(el3)
    next(rv for rv in r["reviews"] if rv["criterion"]["id"] == "hemoglobin")["scores"]["challenge"] = 3
    assert build_graph(r, {}, "hemoglobin")["warnings"] == ["attribution_mismatch:hemoglobin"]


# --- read-only (AC3) -----------------------------------------------------------------------------

def test_build_graph_is_read_only(monkeypatch):
    def no_network(*a, **k):
        raise AssertionError("network access during graph build")

    monkeypatch.setattr("trialforge.sources._get", no_network)
    monkeypatch.setattr(api, "_mem", {})
    r = api.get_review(NCT)
    before = copy.deepcopy(r)
    g = build_graph(r, load_decisions(NCT))
    assert g["validation"] == [] and len(by_type(g, "Criterion")) == 11
    assert r == before


def test_unknown_criterion_raises(el3):
    with pytest.raises(KeyError):
        build_graph(el3, {}, "nope")


# --- routes (AC4) --------------------------------------------------------------------------------

@pytest.fixture()
def client():
    from trialforge.routes_graph import install

    app = FastAPI()
    install(app)
    return TestClient(app)


def test_graph_route(client):
    r = client.get(f"/api/graph/{NCT}", params={"criterion_id": "hemoglobin"})
    assert r.status_code == 200 and r.json()["validation"] == [] and r.json()["criterion_id"] == "hemoglobin"
    assert client.get(f"/api/graph/{NCT}", params={"criterion_id": "nope"}).status_code == 404
    assert client.get("/api/graph/NCT123").status_code == 400


def test_investigate_route_registered(client):
    paths = {(getattr(r, "path", None), m) for r in client.app.routes for m in getattr(r, "methods", ())}
    assert ("/api/investigate", "POST") in paths
    body = {"nct": NCT, "criterion_id": "hemoglobin", "question": "not_a_question"}
    r = client.post("/api/investigate", json=body)
    if importlib.util.find_spec("trialforge.investigate") is None:
        assert r.status_code == 501 and r.json()["detail"] == "investigator not installed"
    else:
        assert r.status_code == 400  # contract: unknown question -> 400


def test_install_is_idempotent_and_calls_demo_guard_when_public(monkeypatch):
    import trialforge
    from trialforge.routes_graph import install

    calls = []
    fake = types.ModuleType("trialforge.demo_guard")
    fake.install = lambda app: calls.append(app)
    monkeypatch.setitem(sys.modules, "trialforge.demo_guard", fake)
    monkeypatch.setattr(trialforge, "demo_guard", fake, raising=False)
    monkeypatch.setenv("TRIALLENS_PUBLIC", "1")
    app = FastAPI()
    install(app)
    install(app)
    assert sum(getattr(r, "path", None) == "/api/graph/{nct}" for r in app.routes) == 1
    assert calls == [app]
