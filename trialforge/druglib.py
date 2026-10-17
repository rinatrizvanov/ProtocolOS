"""Curated, class-level pharmacology table used to reason about eligibility criteria.

This is deliberately small and coarse. Each property reflects a class-level warning
that appears in US prescribing information (e.g. a Myelosuppression warning for
platinum agents). Entries were curated for this prototype and are NOT individually
re-verified against current labels; the UI labels them as "curated knowledge".
They are used only to ask "does any arm contain an agent for which this laboratory
criterion has an obvious safety rationale?" — never to decide a threshold value.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Drug:
    name: str
    drug_class: str
    myelosuppressive: bool = False
    renal: bool = False  # renally cleared and/or nephrotoxic -> renal function criteria relevant
    hepatic: bool = False  # hepatic metabolism and/or hepatotoxicity -> liver criteria relevant
    immunotherapy: bool = False  # immune checkpoint inhibitor -> steroid/autoimmune criteria relevant
    aliases: tuple[str, ...] = field(default_factory=tuple)


DRUGS = [
    Drug("pembrolizumab", "PD-1 inhibitor", hepatic=True, immunotherapy=True, aliases=("mk-3475", "keytruda")),
    Drug("nivolumab", "PD-1 inhibitor", hepatic=True, immunotherapy=True, aliases=("ono-4538", "bms-936558", "opdivo")),
    Drug("cemiplimab", "PD-1 inhibitor", hepatic=True, immunotherapy=True, aliases=("regn2810", "regn 2810", "libtayo")),
    Drug("atezolizumab", "PD-L1 inhibitor", hepatic=True, immunotherapy=True, aliases=("mpdl3280a", "tecentriq")),
    Drug("durvalumab", "PD-L1 inhibitor", hepatic=True, immunotherapy=True, aliases=("medi4736", "imfinzi")),
    Drug("avelumab", "PD-L1 inhibitor", hepatic=True, immunotherapy=True, aliases=("msb0010718c", "bavencio")),
    Drug("ipilimumab", "CTLA-4 inhibitor", hepatic=True, immunotherapy=True, aliases=("yervoy", "bms-734016")),
    Drug("tremelimumab", "CTLA-4 inhibitor", hepatic=True, immunotherapy=True),
    Drug("carboplatin", "platinum", myelosuppressive=True, renal=True),
    Drug("cisplatin", "platinum", myelosuppressive=True, renal=True),
    Drug("pemetrexed", "antifolate", myelosuppressive=True, renal=True, aliases=("alimta",)),
    Drug("nab-paclitaxel", "taxane", myelosuppressive=True, hepatic=True, aliases=("abraxane", "nab paclitaxel")),
    Drug("paclitaxel", "taxane", myelosuppressive=True, hepatic=True, aliases=("taxol",)),
    Drug("docetaxel", "taxane", myelosuppressive=True, hepatic=True, aliases=("taxotere",)),
    Drug("gemcitabine", "nucleoside analog", myelosuppressive=True, aliases=("gemzar",)),
    Drug("etoposide", "topoisomerase II inhibitor", myelosuppressive=True),
    Drug("vinorelbine", "vinca alkaloid", myelosuppressive=True),
    Drug("bevacizumab", "anti-VEGF antibody", renal=True, aliases=("avastin",)),
    Drug("oxaliplatin", "platinum", myelosuppressive=True, renal=True, aliases=("eloxatin",)),
    Drug("fluorouracil", "fluoropyrimidine", myelosuppressive=True, aliases=("5-fu", "5-fluorouracil")),
    Drug("capecitabine", "fluoropyrimidine", myelosuppressive=True, renal=True, aliases=("xeloda",)),
    Drug("irinotecan", "topoisomerase I inhibitor", myelosuppressive=True, hepatic=True),
    Drug("doxorubicin", "anthracycline", myelosuppressive=True, hepatic=True),
    Drug("epirubicin", "anthracycline", myelosuppressive=True, hepatic=True),
    Drug("cyclophosphamide", "alkylating agent", myelosuppressive=True),
    Drug("eribulin", "microtubule inhibitor", myelosuppressive=True),
    Drug("sorafenib", "multikinase inhibitor", hepatic=True, aliases=("nexavar",)),
    Drug("lenvatinib", "multikinase inhibitor", hepatic=True, renal=True, aliases=("lenvima",)),
    Drug("cabozantinib", "multikinase inhibitor", hepatic=True),
    Drug("osimertinib", "EGFR inhibitor", aliases=("azd9291", "tagrisso")),
    Drug("trastuzumab", "anti-HER2 antibody"),
]

_PATTERNS = []
for d in DRUGS:
    for term in (d.name, *d.aliases):
        # nab-paclitaxel must win over paclitaxel; handled by ordering + negative lookbehind
        pat = re.escape(term).replace(r"\-", r"[-\s]?").replace(r"\ ", r"[-\s]?")
        if d.name == "paclitaxel" and term == "paclitaxel":
            pat = r"(?<!nab-)(?<!nab )(?<!nab)paclitaxel"
        _PATTERNS.append((re.compile(rf"\b{pat}\b", re.I), d))

BY_NAME = {d.name: d for d in DRUGS}

LAB_RELEVANCE = {
    # analyte -> (drug property, human description of why the property matters)
    "hemoglobin": ("myelosuppressive", "myelosuppression (anemia)"),
    "anc": ("myelosuppressive", "myelosuppression (neutropenia)"),
    "platelets": ("myelosuppressive", "myelosuppression (thrombocytopenia)"),
    "bilirubin": ("hepatic", "hepatic metabolism / hepatotoxicity"),
    "ast_alt": ("hepatic", "hepatic metabolism / hepatotoxicity"),
    "renal": ("renal", "renal clearance / nephrotoxicity"),
    "washout_corticosteroid": ("immunotherapy", "immunosuppression may blunt checkpoint-inhibitor activity"),
}


def find_drugs(text: str) -> dict[str, list[str]]:
    """Return {canonical drug name: [matched surface strings]} found in text."""
    hits: dict[str, list[str]] = {}
    for pat, d in _PATTERNS:
        for m in pat.finditer(text):
            hits.setdefault(d.name, []).append(m.group(0))
    return hits


def drugs_with(names, prop: str) -> list[str]:
    return sorted(n for n in names if n in BY_NAME and getattr(BY_NAME[n], prop))


def classes(names) -> set[str]:
    return {BY_NAME[n].drug_class for n in names if n in BY_NAME}
