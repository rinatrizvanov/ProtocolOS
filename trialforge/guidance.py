"""FDA July 2026 eligibility guidance passages, verified against the official PDFs.

Passages are chosen by hand (which recommendation applies to which criterion is a
judgment call) but their text is never trusted: at load time every quote must be
found verbatim (whitespace/quote-style normalized) in the downloaded FDA PDF, and
its page, FDA margin line numbers and section heading are computed from the PDF.
A quote that fails this check is dropped and reported.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from functools import lru_cache

from .sources import FDA_GUIDANCES, fetch_guidance

LAB_ALL = ("hemoglobin", "anc", "platelets", "bilirubin", "ast_alt", "renal")
WASHOUTS = (
    "washout_corticosteroid",
    "washout_investigational",
    "washout_radiotherapy",
    "washout_surgery",
    "washout_vaccine",
    "washout_immunomodulator",
)

# (key, guidance, applies_to analytes, stance, quote)
# stance: "challenges" = recommends broadening or demands justification; "context" = framing.
PASSAGES = [
    ("lab_restrictive_slows", "lab", LAB_ALL, "context",
     "Unnecessarily restrictive eligibility criteria may slow subject accrual, limit patients’ access to clinical trials, and lead to trial results that do not fully represent treatment effects in the patient population that will ultimately use the drug."),
    ("lab_only_when_necessary", "lab", LAB_ALL, "challenges",
     "Laboratory values should be used as exclusionary criteria only when clearly necessary to mitigate potential safety concerns."),
    ("lab_specific_concerns", "lab", LAB_ALL, "challenges",
     "Restrictions based upon renal, hepatic, or bone marrow function should reflect specific, well-reasoned concerns regarding drug exposure that might result in toxicity, or organ susceptibility to toxicity, based upon available data"),
    ("lab_customized", "lab", LAB_ALL, "challenges",
     "Laboratory value-based eligibility criteria should be customized to the drug(s) under investigation."),
    ("lab_not_carried_forward", "lab", LAB_ALL, "challenges",
     "laboratory value-related restrictions from earlier clinical trials should not be carried forward automatically"),
    ("lab_template_variation", "lab", LAB_ALL, "context",
     "Analysis of industry-sponsored trials in oncology over time shows little variation in laboratory value-based eligibility criteria, suggesting that these criteria may have been carried forward from early-phase to late-phase trials"),
    ("lab_pd1_class", "lab", LAB_ALL, "context",
     "pharmacology and toxicity profiles are similar across agents, facilitating use of comparable laboratory-related eligibility criteria, as long as they are otherwise well-justified."),
    ("lab_as_restrictive_as_necessary", "lab", LAB_ALL, "challenges",
     "Laboratory-based eligibility criteria should be only as restrictive as necessary to mitigate the clinical risk(s) of concern."),
    ("lab_assess_impact", "lab", LAB_ALL, "challenges",
     "The impact on trial eligibility, enrollment, and generalizability should be assessed when selecting laboratory-based eligibility criteria."),
    ("lab_abnormal_common_in_cancer", "lab", LAB_ALL, "context",
     "the likelihood of test results outside reference ranges is far greater among individuals with cancer and may not be of clinical significance with respect to the treatment being studied."),
    ("lab_randomized_little_benefit", "lab", LAB_ALL, "challenges",
     "Excluding patients with abnormal baseline laboratory values in randomized trials without an evidence-based safety concern has little benefit to a drug development program"),
    ("lab_demographic", "lab", ("hemoglobin", "anc"), "challenges",
     "Demographic differences in laboratory test results, and their implication across populations, should be understood when eligibility criteria are written."),
    ("lab_duffy_background", "lab", ("anc",), "context",
     "the Duffy null phenotype has a high prevalence in African Americans and is associated with lower absolute neutrophil counts but not with greater risk of infection."),
    ("lab_duffy_broaden", "lab", ("anc",), "challenges",
     "sponsors may consider broadening the laboratory inclusion and exclusion criteria for absolute neutrophil count in patients with the Duffy null phenotype."),
    ("lab_hepatic_broad", "lab", ("bilirubin", "ast_alt"), "challenges",
     "hepatic entry criteria should be sufficiently broad to avoid unnecessary exclusions of patients"),
    ("lab_hepatic_mets", "lab", ("bilirubin", "ast_alt"), "context",
     "allowing greater degrees of hepatic dysfunction while ensuring appropriate safety measures to protect subjects, would facilitate drug development in a patient population with high unmet need."),
    ("lab_renal_target_pop", "lab", ("renal",), "context",
     "allowing patients with lower levels of baseline renal function would facilitate generation of data that is more representative of the broader patient population"),
    ("ps_include_ps2", "ps", ("ecog",), "challenges",
     "Patients with ECOG PS2 (or KPS 60-70) should be included unless there is a scientific and/or clinical rationale for exclusion justified by established safety considerations."),
    ("ps_later_phase", "ps", ("ecog",), "challenges",
     "Later phase trials (e.g., phase 2/3) should generally mirror the intended use population and ECOG PS2 (or KPS 60-70) patients should be included, unless safety concerns have manifested in earlier phase trials."),
    ("ps_rationale_in_protocol", "ps", ("ecog",), "challenges",
     "The rationale for exclusion should be justified and stated explicitly in the protocol."),
    ("ps_low_ps_cohorts", "ps", ("ecog",), "context",
     "consider alternative trial designs, such as pre-specified cohorts with low PS (ECOG ≥2) that are exempt from the primary analysis"),
    ("wo_disease_drug_specific", "washout", WASHOUTS, "challenges",
     "Exclusion criteria should be justified with a disease- and drug-specific scientific rationale as opposed to vague statements."),
    ("wo_parameters_not_time", "washout", WASHOUTS, "challenges",
     "Relevant clinical and laboratory parameters, based on the characteristics of preceding therapy, should be used in place of time-based washout periods to address safety considerations"),
    ("wo_time_based_justified", "washout", WASHOUTS, "challenges",
     "should be scientifically justified and relevant PK/PD of the prior therapy should be taken into consideration."),
    ("wo_pkpd_minimize", "washout", WASHOUTS, "context",
     "accumulated pharmacologic information for the investigational drug should be incorporated as soon as possible in subsequent clinical trials to minimize unnecessary washout periods and liberalize concomitant medication allowances."),
    ("wo_conmed_ddi", "washout", ("washout_corticosteroid",), "context",
     "Patients using concomitant medications should only be excluded from trial participation when clinically relevant known or predicted drug-drug interactions and potential overlapping toxicities will impact the safety of trial subjects."),
    # FDA Enrichment Strategies (2019): why restrictions exist, and their cost. Used for purpose tags.
    ("enr_decrease_variability", "enrichment", LAB_ALL + ("ecog",) + WASHOUTS, "purpose",
     "Approaches to increasing study power (the ability of a clinical trial to demonstrate a treatment effect if one is present) by decreasing heterogeneity (nondrug-related variability) are widely practiced."),
    ("enr_unlikely_tolerate", "enrichment", LAB_ALL + ("ecog",), "purpose",
     "Excluding patients unlikely to tolerate the drug."),
    ("enr_comorbid_completion", "enrichment", ("ecog",), "purpose",
     "Excluding patients with comorbid illness that would make completing the treatment period unlikely."),
    ("enr_interacting_drugs", "enrichment", ("washout_corticosteroid", "washout_investigational", "washout_immunomodulator"), "purpose",
     "Excluding patients taking drugs that are pharmacologically similar to, or that could interact with, the study drug."),
    ("enr_generalizability", "enrichment", LAB_ALL + ("ecog",) + WASHOUTS, "context",
     "The principal concerns with the use of enrichment strategies relate to the generalizability and applicability of the study results."),
    ("enr_balance_subgroups", "enrichment", LAB_ALL + ("ecog",) + WASHOUTS, "context",
     "Therefore, the implications of using these strategies should be carefully considered before they are used and should be balanced against the need for information in critical patient subgroups."),
]

FDA_LINE = re.compile(r"^\s{0,4}(\d{1,3})\s{1,}(?=\S)")
SECTION = re.compile(r"^(I|II|III|IV|V|VI)\.\s+([A-Z][A-Z ,/&-]+)$")
SUBSECTION = re.compile(r"^([A-F])\.\s+([A-Z].{3,90})$")


def normalize(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-").replace("—", "-")
    s = s.replace("­", "")
    return re.sub(r"\s+", " ", s).strip()


@dataclass
class Passage:
    key: str
    guidance: str
    guidance_title: str
    url: str
    applies_to: tuple
    stance: str
    quote: str
    pdf_page: int
    printed_page: str | None
    fda_lines: str
    section: str

    def to_dict(self):
        d = asdict(self)
        date = FDA_GUIDANCES[self.guidance]["date"]
        lines = f", lines {self.fda_lines}" if self.fda_lines else ""
        d["citation"] = f"FDA, {self.guidance_title} ({date}), {self.section}, p. {self.printed_page or self.pdf_page}{lines}"
        d["link"] = f"{self.url}#page={self.pdf_page}"
        return d


class GuidanceIndex:
    """Normalized full text of one guidance with a char -> (pdf_page, fda_line, section) map."""

    def __init__(self, key: str):
        self.key = key
        doc = fetch_guidance(key)
        self.doc = doc
        chars: list[str] = []
        where: list[tuple] = []
        section, sub = "Front matter", ""
        self.printed = {}
        # 2026 OCE guidances carry FDA margin line numbers; older guidances (e.g. Enrichment 2019) do not.
        numbered = sum(1 for p in doc.pages for raw in p.splitlines() if FDA_LINE.match(raw)) > 100
        self.has_line_numbers = numbered
        for pno, page in enumerate(doc.pages, start=1):
            lines = [l for l in page.splitlines() if l.strip()]
            if lines and lines[-1].strip().isdigit():
                self.printed[pno] = lines[-1].strip()
            for idx, raw in enumerate(page.splitlines(), start=1):
                if numbered:
                    m = FDA_LINE.match(raw)
                    if not m:
                        continue  # only numbered guidance body lines (skips headers, footnotes, TOC)
                    lno = int(m.group(1))
                    body = raw[m.end():].strip()
                else:
                    if re.search(r"\.{5,}", raw) or "Contains Nonbinding Recommendations" in raw or raw.strip().isdigit():
                        continue
                    lno = idx
                    body = raw.strip()
                if not body:
                    continue
                sm, ssm = SECTION.match(body), SUBSECTION.match(body)
                if sm:
                    section, sub = f"§{sm.group(1)} {sm.group(2).title()}", ""
                elif ssm:
                    sub = f"{ssm.group(1)}. {ssm.group(2).strip()}"
                label = section + (f" › {sub}" if sub else "")
                piece = normalize(body.lstrip("•").strip()) + " "
                chars.append(piece)
                where.extend([(pno, lno, label)] * len(piece))
        self.text = "".join(chars)
        self.where = where

    def locate(self, quote: str):
        q = normalize(quote)
        i = self.text.find(q)
        if i < 0:
            return None
        start, end = self.where[i], self.where[i + len(q) - 1]
        lines = f"{start[1]}" if start[1] == end[1] else f"{start[1]}–{end[1]}"
        return start[0], lines, start[2]


@lru_cache(maxsize=1)
def indexes() -> dict[str, GuidanceIndex]:
    return {k: GuidanceIndex(k) for k in FDA_GUIDANCES}


@lru_cache(maxsize=1)
def load_passages() -> tuple[list[Passage], list[str]]:
    idx = indexes()
    ok, failed = [], []
    for key, g, applies, stance, quote in PASSAGES:
        loc = idx[g].locate(quote)
        if not loc:
            failed.append(key)
            continue
        page, lines, section = loc
        if not idx[g].has_line_numbers:
            lines = ""  # PDF line positions are not FDA line numbers; cite page + section only
        ok.append(
            Passage(key, g, FDA_GUIDANCES[g]["title"], FDA_GUIDANCES[g]["url"], applies, stance, quote, page,
                    idx[g].printed.get(page), lines, section)
        )
    return ok, failed


def passages_for(analyte: str) -> list[Passage]:
    return [p for p in load_passages()[0] if analyte in p.applies_to]


def verify_quote(guidance_key: str, quote: str) -> dict:
    """Used by the verifier for quotes proposed by anyone (LLM, user, eval case)."""
    if guidance_key not in FDA_GUIDANCES:
        return {"ok": False, "reason": f"unknown guidance '{guidance_key}'"}
    loc = indexes()[guidance_key].locate(quote)
    if not loc:
        return {"ok": False, "reason": "quoted text not found verbatim in the FDA PDF"}
    page, lines, section = loc
    return {"ok": True, "pdf_page": page, "fda_lines": lines, "section": section}


if __name__ == "__main__":
    ps, failed = load_passages()
    for p in ps:
        print(f"OK  {p.key:30s} {p.guidance:8s} {p.section[:55]:55s} p.{p.printed_page} l.{p.fda_lines}")
    print("FAILED:", failed)
