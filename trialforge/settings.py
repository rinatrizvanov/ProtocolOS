"""Environment settings for ProtocolOS (formerly TrialLens).

`env("PUBLIC")` reads PROTOCOLOS_PUBLIC first, then the legacy TRIALLENS_PUBLIC, so existing shells,
tests, the Dockerfile and deployed variables keep working after the rename.
"""
from __future__ import annotations

import os

PREFIXES = ("PROTOCOLOS_", "TRIALLENS_")


def env(name: str, default: str | None = None) -> str | None:
    """Value of PROTOCOLOS_<name>, else TRIALLENS_<name>, else `default`."""
    for prefix in PREFIXES:
        v = os.environ.get(prefix + name)
        if v is not None:
            return v
    return default


def flag(name: str) -> bool:
    """True when the setting is exactly "1" (the convention for PUBLIC and ALLOW_MODEL)."""
    return env(name) == "1"
