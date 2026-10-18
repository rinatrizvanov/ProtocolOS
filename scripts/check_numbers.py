"""Check every fraction and percentage in the README, Devpost text and deck against the committed results.

    python -m scripts.check_numbers            # exit 0 when every number is backed, 1 otherwise

Allowed set, built only from committed result files: `data/*.json`, `evals/first_run_snapshot.json`,
`evals/planted/first_run_planted_results.json`, `evals/investigator/results.json` (if present):
- a two-integer list `[a, b]` -> a/b;
- two integers in the same object -> a/b (a <= b);
- a rate in [0, 1] in a child object times an integer of its parent, when the product is whole -> k/n;
- a fraction or percentage written inside a string;
- percentages: 100 * every number in [0, 1] (the rates the eval scripts store), and percentages in strings.
  Percentages are not derived from arbitrary integer pairs: that would let coincidental values pass.
Documents: README.md, docs/DEVPOST.md, docs/deck/deck.html (style/script blocks, tags and URLs removed).
"a/b", "a of b", ranges "a-b/n" and "a-b of n" count as fractions. Latency claims (`2.0 s`, `~1 min`)
are never in the allowed set: re-measure them or remove them. Then the headline manifest: each headline
number is recomputed from its JSON field. Offenders are printed as `file:line`; the documents are never edited.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ["README.md", "docs/DEVPOST.md", "docs/deck/deck.html"]
SOURCES = sorted((ROOT / "data").glob("*.json")) + [
    ROOT / "evals" / "first_run_snapshot.json",
    ROOT / "evals" / "planted" / "first_run_planted_results.json",
    ROOT / "evals" / "investigator" / "results.json",
    ROOT / "evals" / "draft" / "results.json",
    ROOT / "evals" / "impact" / "impact_numbers.json",
]
# Numbers from an external, cited source, each checked by hand against that source.
# Format: {"57%": "Getz et al. 2016, <table/page>"}.
EXTERNAL_CITED: dict[str, str] = {
    # Checked 2026-10-18 against the PubMed abstract (efetch PMID 30227022), RESULTS section, verbatim.
    "57%": "Getz KA et al. Ther Innov Regul Sci 2016;50(4):436-441 (PMID 30227022): '57% of protocols had at least one "
           "substantial amendment'",
    "45%": "Getz KA et al. Ther Innov Regul Sci 2016;50(4):436-441 (PMID 30227022): 'nearly half (45%) of these amendments "
           "were deemed \"avoidable\"'",
}

NUM = r"(?:\d{1,3}(?:,\d{3})+|\d+)"
FRACTION = re.compile(rf"(?<![\w/.,])({NUM})(?:\s*[–-]\s*({NUM}))?\s*(?:/|\s+of\s+)\s*({NUM})(?![\w/])")
PERCENT = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*%")
LATENCY = re.compile(r"(?<![\w.])~?\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|min|mins|minutes)\b")
URL = re.compile(r"https?://\S+|\]\([^)]*\)")


def _int(s: str) -> int:
    return int(s.replace(",", ""))


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_rate(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1


def collect(obj, fracs: set, pcts: set, parent_ints: list[int] | None = None) -> None:
    if isinstance(obj, dict):
        ints = [v for v in obj.values() if _is_int(v)]
        for a in ints:
            for b in ints:
                if b > 0 and 0 <= a <= b:
                    fracs.add((a, b))
        for v in obj.values():
            if isinstance(v, float) and _is_rate(v):
                pcts.add(100 * v)
                for n in parent_ints or []:
                    k = v * n
                    if n > 0 and abs(k - round(k)) < 1e-9:
                        fracs.add((round(k), n))
            collect(v, fracs, pcts, ints)
    elif isinstance(obj, list):
        if len(obj) == 2 and all(_is_int(x) for x in obj) and obj[1] > 0 and 0 <= obj[0] <= obj[1]:
            fracs.add((obj[0], obj[1]))
        for v in obj:
            collect(v, fracs, pcts, parent_ints)
    elif isinstance(obj, str):
        for m in FRACTION.finditer(obj):
            fracs.update((_int(x), _int(m.group(3))) for x in (m.group(1), m.group(2)) if x)
        pcts.update(float(m.group(1)) for m in PERCENT.finditer(obj))


def allowed_set() -> tuple[set, set, list[str]]:
    fracs, pcts, used = set(), set(), []
    for p in SOURCES:
        if p.exists():
            collect(json.loads(p.read_text()), fracs, pcts)
            used.append(str(p.relative_to(ROOT)))
    return fracs, pcts, used


def doc_lines(path: Path) -> list[str]:
    text = path.read_text()
    if path.suffix == ".html":
        blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))  # noqa: E731  keep line numbers
        text = re.sub(r"<(style|script)\b.*?</\1>", blank, text, flags=re.S | re.I)
        text = re.sub(r"<[^>]*>", blank, text, flags=re.S)
    return [URL.sub(" ", line) for line in text.splitlines()]


def pct_ok(value: str, pcts: set) -> bool:
    d = len(value.split(".")[1]) if "." in value else 0
    return any(round(p, d) == float(value) for p in pcts)


def check_docs(fracs: set, pcts: set) -> list[str]:
    bad, seen = [], [0, 0]
    for rel in DOCS:
        path = ROOT / rel
        if not path.exists():
            bad.append(f"{rel}:0: document missing")
            continue
        for no, line in enumerate(doc_lines(path), start=1):
            for m in FRACTION.finditer(line):
                seen[0] += 1
                n = _int(m.group(3))
                for x in (m.group(1), m.group(2)):
                    if x and (_int(x), n) not in fracs and m.group(0).strip() not in EXTERNAL_CITED:
                        bad.append(f"{rel}:{no}: fraction {_int(x)}/{n} (\"{m.group(0).strip()}\") not in the allowed set")
            for m in PERCENT.finditer(line):
                seen[1] += 1
                if not pct_ok(m.group(1), pcts) and m.group(0).replace(" ", "") not in EXTERNAL_CITED:
                    bad.append(f"{rel}:{no}: percentage {m.group(0)} not in the allowed set")
            for m in LATENCY.finditer(line):
                bad.append(f"{rel}:{no}: latency claim \"{m.group(0)}\" (re-measure or remove)")
    print(f"checked {seen[0]} fractions and {seen[1]} percentages in {', '.join(DOCS)}")
    return bad


def _load(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text())


def _get(d, path: str):
    for k in path.split("."):
        d = d[k]
    return d


def _pair(rel: str, path: str) -> str:
    a, b = _get(_load(rel), path)
    return f"{a}/{b}"


def manifest() -> list[tuple[str, str, str]]:
    """(headline claim, value computed from the JSON field, source) for each headline number."""
    ev = _load("data/eval_results.json")["suites"]["extraction"]
    ch = _load("data/chalk_eval_run.json")
    return [
        ("122/128", f"{ev['found_correct']}/{ev['gold_criteria']}", "data/eval_results.json suites.extraction.found_correct/gold_criteria"),
        ("16/24", _pair("data/planted_results.json", "summary.stricter.escalated_strict"), "data/planted_results.json summary.stricter.escalated_strict"),
        ("22/24", _pair("data/planted_results_no_cutoff.json", "summary.stricter.escalated_strict"), "data/planted_results_no_cutoff.json summary.stricter.escalated_strict"),
        ("24/24", _pair("data/planted_results.json", "summary.stricter.escalated_lenient"), "data/planted_results.json summary.stricter.escalated_lenient"),
        ("24/24", _pair("data/planted_results_no_cutoff.json", "summary.stricter.escalated_lenient"), "data/planted_results_no_cutoff.json summary.stricter.escalated_lenient"),
        ("0/10", _pair("data/planted_results.json", "summary.looser.false_over_restriction_flags"), "data/planted_results.json summary.looser.false_over_restriction_flags"),
        ("39", str(ch["rows"]), "data/chalk_eval_run.json rows"),
        ("24/24", f"{ch['fault_rejected']}/{ch['n_fault']}", "data/chalk_eval_run.json fault_rejected/n_fault"),
        ("0/10", f"{ch['valid_rejected']}/{ch['n_valid']}", "data/chalk_eval_run.json valid_rejected/n_valid"),
    ]


def main() -> int:
    fracs, pcts, used = allowed_set()
    print(f"allowed set: {len(fracs)} fractions, {len(pcts)} percentages from {', '.join(used)}")
    bad = check_docs(fracs, pcts)
    for claim, got, src in manifest():
        ok = claim == got
        print(f"manifest {'OK  ' if ok else 'FAIL'} {claim:>8} <- {got:>8}  {src}")
        if not ok:
            bad.append(f"manifest: headline {claim} but {src} gives {got}")
    for b in bad:
        print("OFFENDER", b)
    print(f"{len(bad)} offender(s)" if bad else "all fractions and percentages are backed by committed results")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
