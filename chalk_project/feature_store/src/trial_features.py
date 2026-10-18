"""Chalk feature definitions for TrialForge (deploy with `chalk apply` from chalk_project/feature_store).

Trial-level features are resolved live from the ClinicalTrials.gov API v2 inside Chalk; the
review-level features (classification counts, flagged criteria) are computed by TrialForge and
served through Chalk so the dashboard and evaluations read one consistent feature view.

Status: deployed and queried successfully (see CHALK.md); a deployment needs `chalk login` and an environment that
allows outbound HTTPS to clinicaltrials.gov.
"""
from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime
from typing import Optional

from chalk import online
from chalk.features import Features, feature, features


@features
class Trial:
    nct_id: str = feature(primary=True)
    title: Optional[str]
    sponsor: Optional[str]
    overall_status: Optional[str]
    phase: Optional[str]
    start_date: Optional[str]
    enrollment_actual: Optional[int]
    has_protocol_pdf: Optional[bool]
    protocol_pdf_url: Optional[str]
    registry_eligibility_chars: Optional[int]
    registry_ecog_max: Optional[int]
    registry_mentions_anc: Optional[bool]
    fetched_at: Optional[datetime]


@online
def resolve_trial(nct_id: Trial.nct_id) -> Features[
    Trial.title, Trial.sponsor, Trial.overall_status, Trial.phase, Trial.start_date, Trial.enrollment_actual,
    Trial.has_protocol_pdf, Trial.protocol_pdf_url, Trial.registry_eligibility_chars, Trial.registry_ecog_max,
    Trial.registry_mentions_anc, Trial.fetched_at,
]:
    """Live registry pull. One call per trial; no caching inside Chalk in this prototype."""
    with urllib.request.urlopen(f"https://clinicaltrials.gov/api/v2/studies/{nct_id}", timeout=30) as r:
        s = json.load(r)
    ps = s["protocolSection"]
    elig = ps.get("eligibilityModule", {}).get("eligibilityCriteria", "") or ""
    docs = s.get("documentSection", {}).get("largeDocumentModule", {}).get("largeDocs", [])
    prot = next((d for d in docs if d.get("hasProtocol")), None)
    ecog = None
    m = re.search(r"ECOG[^\n]{0,80}?(?:≤\s*([0-4])|0\s*(?:or|-|–|to)\s*([0-4]))", elig)
    if m:
        ecog = int(m.group(1) or m.group(2))
    return Trial(
        title=ps["identificationModule"].get("briefTitle"),
        sponsor=ps.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}).get("name"),
        overall_status=ps["statusModule"].get("overallStatus"),
        phase=",".join(ps.get("designModule", {}).get("phases", [])),
        start_date=ps["statusModule"].get("startDateStruct", {}).get("date"),
        enrollment_actual=ps.get("designModule", {}).get("enrollmentInfo", {}).get("count"),
        has_protocol_pdf=prot is not None,
        protocol_pdf_url=(f"https://cdn.clinicaltrials.gov/large-docs/{nct_id[-2:]}/{nct_id}/{prot['filename']}" if prot else None),
        registry_eligibility_chars=len(elig),
        registry_ecog_max=ecog,
        registry_mentions_anc=bool(re.search(r"neutrophil|\bANC\b", elig, re.I)),
        fetched_at=datetime.utcnow(),
    )
