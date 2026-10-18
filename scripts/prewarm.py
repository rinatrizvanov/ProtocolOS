"""Pre-warm the document, review and draft caches for the demo trials.

    python -m scripts.prewarm NCT03409614 NCT02578680 NCT03088540 NCT02819518
    python -m scripts.prewarm --if-missing ...   # container start: skip trials whose review is cached
    python -m scripts.prewarm --drafts ...       # also build the authoring-mode draft presets

1. Fetch each target's registry record and protocol PDF, the FDA guidances and the NHANES files in a
   thread pool of 4 (at most 4 concurrent requests to ClinicalTrials.gov; 403/429 retried with backoff).
2. Build reviews one at a time through `api.get_review` (same cache files the app reads); the first
   trial also gets `as_of="none"`.
3. If `trialforge.graph` exists, build each review's graph and print `validate_graph` results.
4. With `--drafts`, after the reviews: build each `trialforge.draft.PRESETS` entry through `get_or_draft`
   (cache first; presets are exempt from the public cold cap) and print seconds per preset. Skipped with a
   message when `trialforge.draft` is not installed.

Prints classification counts and wall time per trial. Always exits 0 (a build without network falls back
to the startup prewarm); failures are printed as FAILED lines.
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

from trialforge import sources

DEMO_NCTS = ["NCT03409614", "NCT02578680", "NCT03088540", "NCT02819518"]
WORKERS = 4
RETRIES = 3


def _retry(fn, *args):
    for attempt in range(RETRIES):
        try:
            return fn(*args)
        except httpx.HTTPStatusError as e:
            if e.response.status_code not in (403, 429) or attempt == RETRIES - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def _fetch_trial(nct: str) -> str:
    study = _retry(sources.fetch_study, nct)
    doc = _retry(sources.fetch_protocol, nct)
    title = study["protocolSection"]["identificationModule"]["briefTitle"][:60]
    return f"{nct} {title} | protocol pages: {len(doc.pages) if doc else 'none posted'}"


def _fetch_guidance(key: str) -> str:
    return f"fda:{key} {len(_retry(sources.fetch_guidance, key).pages)} pages"


def _fetch_nhanes() -> str:
    return "nhanes " + ", ".join(f"{k} {v.stat().st_size} B" for k, v in _retry(sources.fetch_nhanes).items())


def fetch_documents(ncts: list[str]) -> list[str]:
    jobs = [(_fetch_trial, (n,)) for n in ncts] + [(_fetch_guidance, (k,)) for k in sources.FDA_GUIDANCES] + [(_fetch_nhanes, ())]
    failed = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(fn, *args): f"{fn.__name__}{args}" for fn, args in jobs}
        for f in as_completed(futs):
            try:
                print("  fetched", f.result(), flush=True)
            except Exception as e:  # noqa: BLE001
                failed.append(futs[f])
                print(f"  FAILED fetch {futs[f]}: {type(e).__name__}: {e}", flush=True)
    return failed


def _graph_report(review: dict, nct: str) -> None:
    try:
        from trialforge import graph
    except ImportError:
        print("    graph: not installed (trialforge.graph absent)")
        return
    from trialforge.packet import load_decisions

    g = graph.build_graph(review, load_decisions(nct))
    v = graph.validate_graph(g)
    print(f"    graph: {len(g['nodes'])} nodes, {len(g['edges'])} edges, validation {v or '[]'}, warnings {g.get('warnings') or '[]'}")


def build_reviews(ncts: list[str], if_missing: bool) -> list[str]:
    from trialforge import api

    failed = []
    for i, nct in enumerate(ncts):
        for as_of in (["auto", "none"] if i == 0 else ["auto"]):
            cached = (api.REVIEW_CACHE / f"{nct}_{as_of}.json").exists()
            if if_missing and cached:
                print(f"  {nct} as_of={as_of}: cached, skipped")
                continue
            t0 = time.time()
            try:
                r = _retry(api.get_review, nct, as_of)
            except Exception as e:  # noqa: BLE001
                failed.append(f"{nct}/{as_of}")
                print(f"  FAILED review {nct} as_of={as_of}: {type(e).__name__}: {e}", flush=True)
                continue
            counts = Counter(x["classification"] for x in r["reviews"])
            comps = [c["study"].get("acronym") or c["study"]["nct_id"] for c in r["comparators"]]
            print(f"  {nct} as_of={as_of} ({'cache' if cached else 'computed'}) {time.time() - t0:.1f} s | cutoff {r.get('as_of')} | "
                  f"{len(r['reviews'])} criteria: {dict(counts)} | comparators: {comps}", flush=True)
            try:
                _graph_report(r, nct)
            except Exception as e:  # noqa: BLE001
                print(f"    graph: FAILED {type(e).__name__}: {e}")
    return failed


def build_drafts() -> list[str]:
    if importlib.util.find_spec("trialforge.draft") is None:
        print("prewarm: drafts skipped (trialforge.draft not installed)")
        return []
    try:
        from trialforge import draft  # imported after build_reviews: it reads the EL3 review cache at import
    except Exception as e:  # noqa: BLE001  prewarm always exits 0; the startup prewarm retries
        print(f"  FAILED draft import: {type(e).__name__}: {e}", flush=True)
        return ["draft/import"]

    print("prewarm: draft presets one at a time", flush=True)
    failed = []
    for pid, p in draft.PRESETS.items():
        t0 = time.time()
        try:
            d = _retry(draft.get_or_draft, p["idea"], tuple(p.get("exclude", ())), True)
        except Exception as e:  # noqa: BLE001
            failed.append(f"draft/{pid}")
            print(f"  FAILED draft {pid}: {type(e).__name__}: {e}", flush=True)
            continue
        if d["status"] == "retrieval_failed":  # get_or_draft does not cache it
            failed.append(f"draft/{pid}")
            print(f"  FAILED draft {pid}: status retrieval_failed, not cached {time.time() - t0:.1f} s", flush=True)
            continue
        print(f"  draft {pid} {d['draft_id']}: status {d['status']} | {len(d['criteria'])} criteria | "
              f"cached {'yes' if d['summary'].get('cached') else 'no'} | {time.time() - t0:.1f} s", flush=True)
    return failed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("ncts", nargs="*", default=DEMO_NCTS)
    ap.add_argument("--if-missing", action="store_true", help="skip trials whose review cache exists")
    ap.add_argument("--drafts", action="store_true", help="also build the authoring-mode draft presets")
    a = ap.parse_args(argv)
    ncts = [n.strip().upper() for n in a.ncts]
    t0 = time.time()
    todo = ncts
    if a.if_missing:
        from trialforge import api

        todo = [n for i, n in enumerate(ncts) if not all((api.REVIEW_CACHE / f"{n}_{s}.json").exists() for s in (["auto", "none"] if i == 0 else ["auto"]))]
        if not todo and not a.drafts:
            print(f"prewarm: all {len(ncts)} reviews cached; nothing to do")
            return 0
    failed = []
    if todo:
        print(f"prewarm: documents for {ncts} ({WORKERS} workers)", flush=True)
        failed += fetch_documents(ncts)
        print(f"prewarm: documents done in {time.time() - t0:.1f} s; reviews one at a time", flush=True)
        failed += build_reviews(ncts, a.if_missing)
    else:
        print(f"prewarm: all {len(ncts)} reviews cached")
    if a.drafts:
        failed += build_drafts()
    print(f"prewarm: total {time.time() - t0:.1f} s; failed: {failed or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
