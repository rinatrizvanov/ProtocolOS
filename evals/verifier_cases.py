"""Verifier test cases.

kind = "fault"     : a deliberately INJECTED error. Expected: REJECTED.
kind = "valid"     : a correct, clinically cautious recommendation. Expected: not REJECTED.
kind = "ambiguous" : defensible but weakly supported. Expected: PASSED_WITH_WARNINGS (flagged, not clean, not rejected).

These are synthetic test inputs written by the developer. They are not findings about any trial.
Real values referenced in valid cases were read from the protocol PDFs (see evals/gold/criteria.json).
"""

EL3 = "NCT03409614"
KN189 = "NCT02578680"

FDA_NECESSARY = "Laboratory values should be used as exclusionary criteria only when clearly necessary to mitigate potential safety concerns."
FDA_AS_RESTRICTIVE = "Laboratory-based eligibility criteria should be only as restrictive as necessary to mitigate the clinical risk(s) of concern."
FDA_DUFFY = "sponsors may consider broadening the laboratory inclusion and exclusion criteria for absolute neutrophil count in patients with the Duffy null phenotype."
FDA_CUSTOMIZED = "Laboratory value-based eligibility criteria should be customized to the drug(s) under investigation."
FDA_PS2 = "Patients with ECOG PS2 (or KPS 60-70) should be included unless there is a scientific and/or clinical rationale for exclusion justified by established safety considerations."
FDA_WASHOUT = "Exclusion criteria should be justified with a disease- and drug-specific scientific rationale as opposed to vague statements."
EL3_ANEMIA_SENTENCE = "drug-related grade 3 to 4 toxicities of anemia, fatigue, and neutropenia were significantly higher in pemetrexed-treated patients"


def fda(q, g="lab"):
    return {"type": "fda_quote", "guidance": g, "quote": q}


def comp(n, v, u):
    return {"type": "comparator_threshold", "nct_id": n, "value": v, "unit": u}


def drug(d, p, v):
    return {"type": "drug_property", "drug": d, "property": p, "value": v}


CASES = [
    # ---------------------------------------------------------------- injected faults
    dict(id="F01", kind="fault", fault_type="fabricated trial ID", nct=EL3, description="Cites a non-existent NCT ID as a comparator",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT09999999", 9.0, "g/dL")], text="A comparable trial used 9.0 g/dL.")),
    dict(id="F02", kind="fault", fault_type="malformed trial ID", nct=EL3, description="Malformed NCT identifier",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT123", 9.0, "g/dL")], text="See NCT123.")),
    dict(id="F03", kind="fault", fault_type="wrong comparator value", nct=EL3, description="CheckMate 9LA Hgb misreported as 8.0 (source: ≥9.0, p.42)",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=8.0, claims=[comp("NCT03215706", 8.0, "g/dL")], text="CheckMate 9LA allowed 8.0 g/dL.")),
    dict(id="F04", kind="fault", fault_type="wrong comparator value", nct=EL3, description="KEYNOTE-042 ANC misreported as 1.0 (source: ≥1,500/mcL)",
         rec=dict(criterion_id="anc", action="relax", proposed_value=1.0, claims=[comp("NCT02220894", 1.0, "×10⁹/L")], text="KEYNOTE-042 used ANC ≥1.0.")),
    dict(id="F05", kind="fault", fault_type="wrong comparator unit", nct=EL3, description="Comparator value stated in the wrong unit",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[comp("NCT03215706", 9.0, "g/L")], text="Comparable trial used 9 g/L.")),
    dict(id="F06", kind="fault", fault_type="misquoted FDA text", nct=EL3, description="FDA sentence with 'should' changed to 'must'",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[fda(FDA_NECESSARY.replace("should be used", "must be used"))], text="FDA guidance applies.")),
    dict(id="F07", kind="fault", fault_type="fabricated FDA quote", nct=EL3, description="Plausible but non-existent FDA sentence",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[fda("Hemoglobin thresholds above 9.0 g/dL should not be used in late-phase oncology trials.")], text="FDA says so.")),
    dict(id="F08", kind="fault", fault_type="wrong guidance topic", nct=EL3, description="Performance-status guidance cited for a hemoglobin criterion",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[fda(FDA_PS2, "ps")], text="FDA wants broader eligibility.")),
    dict(id="F09", kind="fault", fault_type="regimen contradiction", nct=EL3, description="Relax ANC because cemiplimab is not myelosuppressive, ignoring platinum/taxane/pemetrexed arms",
         rec=dict(criterion_id="anc", action="relax", proposed_value=1.0, claims=[drug("cemiplimab", "myelosuppressive", False), fda(FDA_CUSTOMIZED)], text="Cemiplimab is a PD-1 inhibitor, so the ANC floor can be lowered.")),
    dict(id="F10", kind="fault", fault_type="regimen contradiction", nct=EL3, description="Relax platelets because ipilimumab is not myelosuppressive",
         rec=dict(criterion_id="platelets", action="relax", proposed_value=75.0, claims=[drug("ipilimumab", "myelosuppressive", False), fda(FDA_CUSTOMIZED)], text="Checkpoint inhibitors do not cause thrombocytopenia.")),
    dict(id="F11", kind="fault", fault_type="regimen contradiction", nct=KN189, description="KEYNOTE-189: relax ANC citing pembrolizumab only (pemetrexed + platinum present)",
         rec=dict(criterion_id="anc", action="relax", proposed_value=1.0, claims=[drug("pembrolizumab", "myelosuppressive", False), fda(FDA_CUSTOMIZED)], text="Pembrolizumab is not myelosuppressive.")),
    dict(id="F12", kind="fault", fault_type="drug not in regimen", nct=EL3, description="Claims about pembrolizumab, which is not in EMPOWER-Lung 3",
         rec=dict(criterion_id="anc", action="justify_in_protocol", claims=[drug("pembrolizumab", "myelosuppressive", False)], text="Pembrolizumab data suggest the ANC floor is conservative.")),
    dict(id="F13", kind="fault", fault_type="false drug property", nct=EL3, description="Claims carboplatin is not myelosuppressive",
         rec=dict(criterion_id="platelets", action="relax", proposed_value=75.0, claims=[drug("carboplatin", "myelosuppressive", False)], text="Carboplatin does not affect platelets.")),
    dict(id="F14", kind="fault", fault_type="direction error", nct=EL3, description="'Relax' Hgb to 11.0 (stricter than current 10.0)",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=11.0, claims=[comp("NCT03215706", 9.0, "g/dL")], text="Relax to 11.")),
    dict(id="F15", kind="fault", fault_type="comparator does not support direction", nct=EL3, description="Relax Hgb citing eNERGY, which is not more permissive (>10.0)",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT03351361", 10.0, "g/dL")], text="eNERGY supports relaxing.")),
    dict(id="F16", kind="fault", fault_type="unit error", nct=EL3, description="ANC proposed as 1500 g/dL",
         rec=dict(criterion_id="anc", action="relax", proposed_value=1500, proposed_unit="g/dL", claims=[fda(FDA_DUFFY)], text="Use 1500.")),
    dict(id="F17", kind="fault", fault_type="implausible value", nct=EL3, description="Hgb relaxed to 3.0 g/dL",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=3.0, claims=[comp("NCT03215706", 9.0, "g/dL")], text="Lower to 3.0.")),
    dict(id="F18", kind="fault", fault_type="overclaim (safety)", nct=EL3, description="States relaxation is safe",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT03215706", 9.0, "g/dL")], text="9.0 g/dL is safe because CheckMate 9LA used it.")),
    dict(id="F19", kind="fault", fault_type="overclaim (enrollment)", nct=EL3, description="Claims a change will increase enrollment",
         rec=dict(criterion_id="ecog", action="relax", proposed_value=2.0, claims=[fda(FDA_PS2, "ps")], text="Allowing PS2 will increase enrollment by 20%.")),
    dict(id="F20", kind="fault", fault_type="unsupported removal", nct=EL3, description="Remove the ANC criterion entirely",
         rec=dict(criterion_id="anc", action="remove", claims=[fda(FDA_DUFFY)], text="Drop the ANC requirement.")),
    dict(id="F21", kind="fault", fault_type="no evidence", nct=EL3, description="Relaxation with no cited evidence",
         rec=dict(criterion_id="platelets", action="relax", proposed_value=75.0, claims=[], text="75 is enough.")),
    dict(id="F22", kind="fault", fault_type="non-existent criterion", nct=EL3, description="Refers to an LDH criterion the protocol does not have",
         rec=dict(criterion_id="ldh", action="relax", proposed_value=2.0, claims=[], text="Relax LDH.")),
    dict(id="F23", kind="fault", fault_type="misquoted protocol text", nct=EL3, description="Protocol sentence altered ('higher' -> 'not higher')",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[{"type": "protocol_quote", "quote": EL3_ANEMIA_SENTENCE.replace("were significantly higher", "were not higher")}, comp("NCT03215706", 9.0, "g/dL")], text="The protocol itself says anemia was not higher.")),
    dict(id="F24", kind="fault", fault_type="direction error", nct=EL3, description="'Tighten' ECOG to 2 (more permissive)",
         rec=dict(criterion_id="ecog", action="tighten", proposed_value=2.0, claims=[fda(FDA_PS2, "ps")], text="Tighten to PS2.")),
    # ---------------------------------------------------------------- valid / cautious
    dict(id="V01", kind="valid", nct=EL3, description="Ask to justify Hgb ≥10 citing CheckMate 9LA ≥9.0 and FDA §III.A",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[comp("NCT03215706", 9.0, "g/dL"), fda(FDA_AS_RESTRICTIVE)], text="Comparable trials used 9.0 g/dL; document why 10.0 g/dL is required.")),
    dict(id="V02", kind="valid", nct=EL3, description="Consider a Duffy-null ANC provision, citing FDA §III.B",
         rec=dict(criterion_id="anc", action="add_provision", claims=[fda(FDA_DUFFY)], text="Consider whether a Duffy-null-specific ANC provision is appropriate; needs clinical pharmacology review.")),
    dict(id="V03", kind="valid", nct=EL3, description="Justify ECOG ≤1 in protocol, citing FDA PS §IV.A",
         rec=dict(criterion_id="ecog", action="justify_in_protocol", claims=[fda(FDA_PS2, "ps")], text="State the rationale for excluding PS2 patients.")),
    dict(id="V04", kind="valid", nct=EL3, description="Retain platelets; comparator used the same value",
         rec=dict(criterion_id="platelets", action="retain", claims=[comp("NCT03215706", 100.0, "×10⁹/L")], text="Consistent with a regimen-matched comparator.")),
    dict(id="V05", kind="valid", nct=EL3, description="Justify investigational-agent washout citing FDA washout §III",
         rec=dict(criterion_id="washout_investigational", action="justify_in_protocol", claims=[fda(FDA_WASHOUT, "washout")], text="Document the PK rationale for the interval.")),
    dict(id="V06", kind="valid", nct=EL3, description="Justify Hgb citing the protocol's own anemia sentence (verbatim)",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[{"type": "protocol_quote", "quote": EL3_ANEMIA_SENTENCE}], text="The protocol notes higher anemia with pemetrexed; state whether this motivates 10.0 g/dL.")),
    dict(id="V07", kind="valid", nct=EL3, description="Retain AST/ALT; KEYNOTE-042 was stricter (≤2.5×ULN)",
         rec=dict(criterion_id="ast_alt", action="retain", claims=[comp("NCT02220894", 2.5, "×ULN")], text="Already more permissive than a comparable trial.")),
    dict(id="V08", kind="valid", nct=KN189, description="KEYNOTE-189: retain Hgb ≥9.0, consistent with KEYNOTE-407",
         rec=dict(criterion_id="hemoglobin", action="retain", claims=[comp("NCT02775435", 9.0, "g/dL")], text="Consistent with a comparable trial.")),
    dict(id="V09", kind="valid", nct=EL3, description="Correctly states cemiplimab is not myelosuppressive while asking for justification (no relaxation)",
         rec=dict(criterion_id="anc", action="justify_in_protocol", claims=[drug("cemiplimab", "myelosuppressive", False), drug("carboplatin", "myelosuppressive", True)], text="The ANC floor is driven by the chemotherapy backbone, not cemiplimab; document this.")),
    dict(id="V10", kind="valid", nct=EL3, description="Justify Hgb citing KEYNOTE-189 (not an auto-selected comparator; checked via registry + protocol)",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[comp("NCT02578680", 9.0, "g/dL")], text="KEYNOTE-189 used 9.0 g/dL.")),
    # ---------------------------------------------------------------- ambiguous (should be flagged, not passed cleanly, not rejected)
    dict(id="A01", kind="ambiguous", nct=EL3, description="Relax Hgb to 9.0 citing only CheckMate 722 (regimen lacks taxane)",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT02864251", 9.0, "g/dL")], text="Consider 9.0 g/dL, as in CheckMate 722.")),
    dict(id="A02", kind="ambiguous", nct=EL3, description="Relax ANC to 1.2 citing FDA Duffy passage while the regimen is myelosuppressive",
         rec=dict(criterion_id="anc", action="relax", proposed_value=1.2, claims=[fda(FDA_DUFFY)], text="Consider ANC ≥1.2 for patients with the Duffy-null phenotype.")),
    dict(id="A03", kind="ambiguous", nct=EL3, description="Valid comparator but calls the stricter value 'unnecessary'",
         rec=dict(criterion_id="hemoglobin", action="justify_in_protocol", claims=[comp("NCT03215706", 9.0, "g/dL")], text="10.0 g/dL appears unnecessary given CheckMate 9LA.")),
    dict(id="A04", kind="ambiguous", nct=EL3, description="Relax Hgb to 9.0 citing a regimen-matched comparator (still a relaxation of a toxicity-linked criterion)",
         rec=dict(criterion_id="hemoglobin", action="relax", proposed_value=9.0, claims=[comp("NCT03215706", 9.0, "g/dL")], text="Consider 9.0 g/dL as used in CheckMate 9LA, subject to clinical review.")),
    dict(id="A05", kind="ambiguous", nct=KN189, description="KEYNOTE-189: relax surgery washout from 21 to 14 days citing only FDA washout guidance",
         rec=dict(criterion_id="washout_surgery", action="relax", proposed_value=14, proposed_unit="days", claims=[fda(FDA_WASHOUT, "washout")], text="Consider 14 days.")),
]
