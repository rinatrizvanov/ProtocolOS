"""Semantic index of phase 3 interventional oncology trials with a protocol posted on ClinicalTrials.gov.

Used to find a trial from a plain-language description and to suggest comparator candidates. Each trial's title,
conditions, interventions and brief summary are embedded with a small local model (fastembed with
BAAI/bge-small-en-v1.5, ONNX on CPU; no model API and no key), L2-normalized and stored with the trial metadata
under data/index/. A query is one dot product over the matrix: at about 1,400 trials that answers in milliseconds,
so the index lives in the engine process instead of a separate database service.

    python -m trialforge.trial_index build      # fetch the corpus and embed it (minutes)
    python -m trialforge.trial_index search "first-line squamous NSCLC pembrolizumab carboplatin"

Without the index files or fastembed, available() is False and callers report the search as unavailable.
Similarity is a retrieval signal only: it never decides a comparator or a value.
"""
from __future__ import annotations

import json
import threading
import time

from .settings import env
from .sources import DATA, search_studies

INDEX_DIR = DATA / "index"
MODEL = "BAAI/bge-small-en-v1.5"
CORPUS_QUERY = {
    "query.cond": "cancer",
    "filter.advanced": "AREA[Phase]PHASE3 AND AREA[LargeDocHasProtocol]true AND AREA[StudyType]INTERVENTIONAL",
    "fields": "NCTId,BriefTitle,OfficialTitle,Acronym,Condition,InterventionName,Phase,StartDate,OverallStatus,"
              "LeadSponsorName,BriefSummary",
}
SUMMARY_CHARS = 700

_lock = threading.Lock()
_state: dict = {}


def record(study: dict) -> dict:
    """The metadata kept for one registry record, plus the text that is embedded."""
    ps = study["protocolSection"]
    ident = ps["identificationModule"]
    interventions = [i.get("name", "") for i in ps.get("armsInterventionsModule", {}).get("interventions", [])]
    rec = {
        "nct_id": ident["nctId"],
        "title": ident.get("briefTitle", ""),
        "acronym": ident.get("acronym"),
        "conditions": ps.get("conditionsModule", {}).get("conditions", []),
        "interventions": interventions,
        "phases": ps.get("designModule", {}).get("phases", []),
        "start_date": ps.get("statusModule", {}).get("startDateStruct", {}).get("date"),
        "status": ps.get("statusModule", {}).get("overallStatus"),
        "sponsor": ps.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}).get("name"),
    }
    summary = ps.get("descriptionModule", {}).get("briefSummary", "")[:SUMMARY_CHARS]
    rec["text"] = (f"{rec['title']}. {ident.get('officialTitle') or ''} Conditions: {', '.join(rec['conditions'])}. "
                   f"Interventions: {', '.join(interventions)}. {summary}")
    return rec


def _embedder():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=MODEL, cache_dir=env("EMBED_CACHE"))


def build(out=INDEX_DIR, max_results: int = 5000) -> dict:
    """Fetch the corpus from ClinicalTrials.gov, embed it and write records.json and vectors.npy."""
    import numpy as np

    t0 = time.time()
    records = [record(s) for s in search_studies(CORPUS_QUERY, max_results)]
    vectors = np.array(list(_embedder().passage_embed([r["text"] for r in records])), dtype=np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    meta = {"model": MODEL, "built_at": time.strftime("%Y-%m-%d"), "count": len(records), "query": CORPUS_QUERY,
            "seconds": round(time.time() - t0, 1)}
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "vectors.npy", vectors.astype(np.float16))
    (out / "records.json").write_text(json.dumps({"meta": meta, "records": [{k: v for k, v in r.items() if k != "text"} for r in records]}))
    with _lock:
        _state.clear()
    return meta


def _load() -> dict | None:
    """The index and the model, loaded once per process; None when either is missing."""
    with _lock:
        if "index" not in _state:
            try:
                import numpy as np

                data = json.loads((INDEX_DIR / "records.json").read_text())
                _state["index"] = {"meta": data["meta"], "records": data["records"],
                                   "vectors": np.load(INDEX_DIR / "vectors.npy").astype(np.float32),
                                   "row": {r["nct_id"]: i for i, r in enumerate(data["records"])},
                                   "model": _embedder()}
            except (OSError, ImportError, ValueError, KeyError) as e:
                _state["index"] = None
                _state["error"] = f"{type(e).__name__}: {e}"[:200]
        return _state["index"]


def available() -> bool:
    return _load() is not None


def contains(nct_id: str) -> bool:
    idx = _load()
    return idx is not None and nct_id in idx["row"]


def status() -> dict:
    idx = _load()
    return {"available": True, **idx["meta"]} if idx else {"available": False, "detail": _state.get("error")}


def _rank(idx: dict, vector, k: int, exclude: set, until: str | None) -> list[dict]:
    scores = idx["vectors"] @ vector
    out = []
    for i in scores.argsort()[::-1]:
        rec = idx["records"][i]
        # the same start-date window as the keyword search in comparators.discover (2010 on, inclusive cutoff)
        start = rec["start_date"] or ""
        if rec["nct_id"] in exclude or (until and not ("2010-01-01" <= start <= until)):
            continue
        out.append({**rec, "score": round(float(scores[i]), 4)})
        if len(out) >= k:
            break
    return out


def search(query: str, k: int = 10, until: str | None = None) -> list[dict]:
    """Trials nearest to a plain-language description; `until` keeps trials started from 2010 up to that date."""
    idx = _load()
    if idx is None:
        return []
    vector = next(iter(idx["model"].query_embed([query])))
    return _rank(idx, vector / (vector @ vector) ** 0.5, k, set(), until)


def similar(nct_id: str, text: str, k: int = 10, until: str | None = None) -> list[dict]:
    """Trials nearest to one trial: its stored vector when it is in the index, else its registry text embedded."""
    idx = _load()
    if idx is None:
        return []
    row = idx["row"].get(nct_id)
    if row is not None:
        vector = idx["vectors"][row]
    else:
        vector = next(iter(idx["model"].passage_embed([text])))
        vector = vector / (vector @ vector) ** 0.5
    return _rank(idx, vector, k, {nct_id}, until)


if __name__ == "__main__":
    import sys

    if sys.argv[1:2] == ["build"]:
        print(json.dumps(build(), indent=1))
    elif sys.argv[1:2] == ["search"]:
        for r in search(" ".join(sys.argv[2:])):
            print(f"{r['score']:.3f} {r['nct_id']} {r['start_date']} {r['acronym'] or ''} {r['title'][:90]}")
    else:
        print(__doc__)
