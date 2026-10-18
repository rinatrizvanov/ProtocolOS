"""Chalk online query for the registry profile of a trial.

The Trial feature class and its resolver live in chalk_project/feature_store and are deployed to the
Chalk environment; the resolver pulls the ClinicalTrials.gov record inside Chalk. ProtocolOS uses the
result to show, for each reviewed trial, whether the registry text even contains lab thresholds
(it usually does not, which is why ProtocolOS reads the protocol PDF).

If Chalk is not configured or unreachable, the profile is reported as unavailable; nothing is faked.
"""
from __future__ import annotations

import time

FEATURES = [
    "trial.title", "trial.sponsor", "trial.start_date", "trial.has_protocol_pdf", "trial.protocol_pdf_url",
    "trial.registry_eligibility_chars", "trial.registry_ecog_max", "trial.registry_mentions_anc",
]


def registry_profile(nct_id: str) -> dict:
    t0 = time.time()
    try:
        from chalk.client import ChalkClient

        r = ChalkClient().query(input={"trial.nct_id": nct_id}, output=FEATURES, include_meta=True, query_name="triallens_registry_profile")
        if r.errors:
            return {"status": "error", "errors": [str(e)[:300] for e in r.errors]}
        values = {f.split(".", 1)[1]: r.get_feature_value(f) for f in FEATURES}
        meta = r.meta
        return {
            "status": "ok",
            "source": "Chalk online query (resolver: chalk_project/feature_store/src/trial_features.py)",
            "query_id": getattr(meta, "query_id", None) if meta else None,
            "environment": getattr(meta, "environment_id", None) if meta else None,
            "execution_seconds": round(time.time() - t0, 3),
            "values": values,
        }
    except Exception as e:  # not logged in, no deployment, network
        return {"status": "unavailable", "detail": f"{type(e).__name__}: {str(e)[:200]}"}


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(registry_profile(sys.argv[1] if len(sys.argv) > 1 else "NCT03409614"), indent=1, default=str))
