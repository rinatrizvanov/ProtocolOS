"""US general-population laboratory distributions from NHANES 2017-2018 (public-use files).

Outputs are survey-weighted percentages of adults whose measured value falls below a
threshold, with design-based standard errors (Taylor linearization over SDMVSTRA/SDMVPSU,
with-replacement approximation, as recommended in the NHANES analytic guidelines).

These are NOT oncology patient eligibility estimates: NHANES samples the civilian
non-institutionalized US population, and people with cancer typically have very different
laboratory distributions. Race/ethnicity is self-reported and is not a proxy for Duffy-null
genotype, which NHANES does not measure.
"""
from __future__ import annotations

import math
from functools import lru_cache

import pandas as pd

from .sources import fetch_nhanes

RACE = {3: "Non-Hispanic White", 4: "Non-Hispanic Black", 6: "Non-Hispanic Asian", 1: "Mexican American", 2: "Other Hispanic"}
ANALYTES = {
    # analyte -> (NHANES variable, unit, how to convert to the criterion's normalized unit)
    "hemoglobin": ("LBXHGB", "g/dL", 1.0),
    "anc": ("LBDNENO", "×10⁹/L", 1.0),  # NHANES reports 1000 cells/uL == 10^9/L
    "platelets": ("LBXPLTSI", "×10⁹/L", 1.0),
}
SOURCE = {
    "dataset": "NHANES 2017-2018 (DEMO_J, CBC_J)",
    "url": "https://wwwn.cdc.gov/nchs/nhanes/continuousnhanes/default.aspx?BeginYear=2017",
    "population": "US civilian non-institutionalized population; adults (age ≥18) with a valid CBC measurement",
    "weights": "WTMEC2YR (MEC exam weights); variance: Taylor linearization with SDMVSTRA/SDMVPSU",
}
CAVEAT = (
    "US general-population estimate, not an oncology patient eligibility estimate. Race/ethnicity is self-reported "
    "and is not a substitute for Duffy-null phenotype, which NHANES does not measure."
)


@lru_cache(maxsize=1)
def frame() -> pd.DataFrame:
    p = fetch_nhanes()
    demo = pd.read_sas(p["DEMO_J"], format="xport")[["SEQN", "RIDAGEYR", "RIAGENDR", "RIDRETH3", "WTMEC2YR", "SDMVSTRA", "SDMVPSU"]]
    cbc = pd.read_sas(p["CBC_J"], format="xport")[["SEQN", "LBXHGB", "LBDNENO", "LBXPLTSI"]]
    df = demo.merge(cbc, on="SEQN")
    return df[(df.RIDAGEYR >= 18) & (df.WTMEC2YR > 0)].copy()


def weighted_prop(df: pd.DataFrame, indicator: pd.Series) -> tuple[float, float, int]:
    """Survey-weighted proportion with Taylor-linearized SE (strata/PSU, with replacement)."""
    w = df.WTMEC2YR
    y = indicator.astype(float)
    W = w.sum()
    p = float((w * y).sum() / W)
    z = w * (y - p) / W
    g = pd.DataFrame({"h": df.SDMVSTRA, "psu": df.SDMVPSU, "z": z}).groupby(["h", "psu"]).z.sum().reset_index()
    var = 0.0
    for _, sub in g.groupby("h"):
        n = len(sub)
        if n < 2:
            continue
        var += n / (n - 1) * float(((sub.z - sub.z.mean()) ** 2).sum())
    return p, math.sqrt(var), int(len(df))


def below_threshold(analyte: str, threshold: float, min_age: int = 18, max_age: int | None = None, sex: int | None = None) -> dict:
    """% of adults with value < threshold (i.e. who would fail a '≥ threshold' criterion), by race/ethnicity."""
    if analyte not in ANALYTES:
        raise ValueError(f"No NHANES variable mapped for {analyte}")
    var, unit, _ = ANALYTES[analyte]
    df = frame()
    df = df[df[var].notna() & (df.RIDAGEYR >= min_age)]
    if max_age:
        df = df[df.RIDAGEYR <= max_age]
    if sex:
        df = df[df.RIAGENDR == sex]
    rows = []
    for code, label in RACE.items():
        # domain estimation: keep the full design, zero-out indicator outside the domain
        dom = df.RIDRETH3 == code
        sub = df[dom]
        if len(sub) < 30:
            rows.append({"group": label, "n": int(len(sub)), "pct": None, "ci95": None, "note": "n<30, not reported"})
            continue
        p, se, n = weighted_prop(sub, sub[var] < threshold)
        rows.append({
            "group": label, "n": n, "pct": round(100 * p, 2), "se": round(100 * se, 2),
            "ci95": [round(max(0.0, 100 * (p - 1.96 * se)), 2), round(min(100.0, 100 * (p + 1.96 * se)), 2)],
            "unstable": se > 0 and (se / p > 0.3 if p > 0 else True),
        })
    p_all, se_all, n_all = weighted_prop(df, df[var] < threshold)
    return {
        "analyte": analyte, "threshold": threshold, "unit": unit, "rule": f"{analyte} < {threshold} {unit} (fails '≥ {threshold}')",
        "age": f"{min_age}{'–' + str(max_age) if max_age else '+'}", "overall": {"n": n_all, "pct": round(100 * p_all, 2), "se": round(100 * se_all, 2)},
        "groups": rows, "source": SOURCE, "caveat": CAVEAT,
        "note": "Subgroup SEs computed within the subgroup's PSUs (conditional on the domain); CIs for small or rare estimates are approximate. 'unstable' = relative SE > 30%.",
    }


def compare_thresholds(analyte: str, current: float, alternative: float, min_age: int = 18) -> dict:
    a, b = below_threshold(analyte, current, min_age), below_threshold(analyte, alternative, min_age)
    return {"current": a, "alternative": b, "caveat": CAVEAT}


if __name__ == "__main__":
    for an, th in (("anc", 1.5), ("anc", 1.2), ("hemoglobin", 10.0), ("hemoglobin", 9.0)):
        r = below_threshold(an, th, 18)
        print(r["rule"], "overall", r["overall"])
        for g in r["groups"]:
            print("   ", g)
