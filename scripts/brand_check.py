"""Brand check: the product name is ProtocolOS wherever a person reads it.

Scans every tracked file (and tracked file names) for the legacy name TrialLens/triallens. Each hit must
match an allowlist entry below, each with its reason; anything else counts as `unlisted_legacy`.
Prints `brand=ProtocolOS unlisted_legacy=<n>` and exits 1 when n > 0 or when a required ProtocolOS
string is missing. Run: .venv/bin/python -m scripts.brand_check [-v]
"""
from __future__ import annotations

import re
import subprocess
import sys
from fnmatch import fnmatch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEGACY = re.compile(r"trial[\s_-]?lens", re.IGNORECASE)

# (file glob, regex the hit's line must match, reason). Globs use fnmatch on the repo-relative path.
ALLOW: list[tuple[str, str, str]] = [
    # Legacy env names are still read, so they are documented next to the new ones.
    ("trialforge/settings.py", r"TRIALLENS_", "legacy env prefix read as a fallback"),
    ("web-next/next.config.ts", r"TRIALLENS_", "legacy env names read as a fallback"),
    (".env.example", r"TRIALLENS_", "documents the legacy env prefix"),
    ("tests/*", r"TRIALLENS_", "tests that the legacy env names still work"),
    ("docs/DEPLOY.md", r"TRIALLENS_", "documents the legacy env prefix"),
    ("docs/INSTALL.md", r"TRIALLENS_", "documents the legacy env prefix"),
    ("trialforge/demo_guard.py", r"legacy TRIALLENS_PUBLIC", "documents the legacy env name"),
    ("web-next/README.md", r"legacy `TRIALLENS_API_URL`", "documents the legacy env name"),
    # Chalk identifiers that are deployed; renaming them needs a new `chalk apply`.
    ("*", r"triallens_registry_profile", "deployed Chalk query name"),
    ("*", r"\bteam\W+(?:<code>|`)?triallens", "Chalk team name"),
    ("tests/*", r"not in", "a negative check that the old name is gone"),
    # Paths: the local checkout folder and the default log directories keep the old name.
    ("*", r"triallens/|/tl-|triallens-logs|task-triallens-", "local folder, log directory or spec id"),
    ("*", r"rinatrizvanov/triallens", "old GitHub URL (redirects to ProtocolOS)"),
    # The one "formerly" line that connects the old name with the new one.
    ("*", r"formerly TrialLens|renamed from TrialLens|from `?triallens`? (?:at|on|to)", "formerly-TrialLens note"),
    # Generated bundle name from before the rename, kept ignored so an old local copy is never committed.
    (".gitignore", r"triallens_investigator_eval\.py", "ignore rule for the pre-rename generated bundle"),
    ("scripts/brand_check.py", r".", "this checker names the legacy string"),
]

# Files whose rename is still pending (globs); every hit in them counts as listed. Empty: every file is renamed.
CR_PENDING: list[str] = []

# Generated files: regenerated after the rename, never hand-edited.
GENERATED: list[str] = []

# Strings that must be present (the new name is actually shown).
REQUIRED: list[tuple[str, str]] = [
    ("web-next/app/layout.tsx", "ProtocolOS"),
    ("pyproject.toml", 'name = "protocolos"'),
    ("web-next/package.json", '"name": "protocolos-web"'),
]


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def allowed(path: str, line: str) -> str | None:
    if any(fnmatch(path, g) for g in CR_PENDING):
        return "CR pending (CR-v2-R)"
    if any(fnmatch(path, g) for g in GENERATED):
        return "generated"
    for glob, rx, reason in ALLOW:
        if fnmatch(path, glob) and re.search(rx, line, re.IGNORECASE):
            return reason
    return None


def main(argv: list[str]) -> int:
    verbose = "-v" in argv
    unlisted: list[str] = []
    listed: dict[str, int] = {}
    for path in tracked():
        p = ROOT / path
        if LEGACY.search(path) and not allowed(path, path):
            unlisted.append(f"{path}: (file name)")
        if not p.is_file() or p.stat().st_size > 2_000_000:
            continue
        try:
            text = p.read_text()
        except UnicodeDecodeError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if not LEGACY.search(line):
                continue
            reason = allowed(path, line)
            if reason is None:
                unlisted.append(f"{path}:{n}: {line.strip()[:160]}")
            else:
                listed[reason] = listed.get(reason, 0) + 1
    missing = [f"{f}: {s!r}" for f, s in REQUIRED if s not in (ROOT / f).read_text()]
    for u in unlisted:
        print("UNLISTED", u)
    for m in missing:
        print("MISSING", m)
    if verbose:
        for reason, c in sorted(listed.items()):
            print(f"allowlisted {c:4d}  {reason}")
    print(f"brand=ProtocolOS unlisted_legacy={len(unlisted)}" + (f" missing_required={len(missing)}" if missing else ""))
    return 1 if unlisted or missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
