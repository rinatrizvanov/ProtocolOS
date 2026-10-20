"""Who may start work on the public deployment: visitor sessions, client addresses, key checks and rate limits.

Work that costs the server (analysing a trial that is not cached, drafting a new idea) or that calls a model needs
the visitor's own OpenAI or Anthropic key (llm.from_headers), confirmed by llm.check(). Limits are in memory, per
process (the deployment runs one worker):

- key checks: PROTOCOLOS_CHECKS_PER_HOUR per visitor (default 20) and 600 per hour overall
- new analyses and drafts: PROTOCOLOS_NEW_PER_HOUR per visitor (default 6) and PROTOCOLOS_NEW_PER_DAY overall
  (default 25), and none while less than PROTOCOLOS_MIN_FREE_MB of disk is free (default 1024)
- model calls: PROTOCOLOS_MODEL_PER_HOUR per visitor (default 30)

A visitor is the client address together with a hash of the key it sent. The address is the first
X-Vercel-Forwarded-For / X-Forwarded-For entry, which a direct caller can set and which a proxy may replace with its
own; the key part keeps two visitors behind one address apart. The per-visitor limits slow casual abuse; the
overall limits are the real ceiling.

A visitor session is a random 32-hex id the browser keeps (header X-ProtocolOS-Session, or ?session= on an export
link); reviewer decisions are stored per session on the public deployment.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import threading
import time
from collections import deque

from . import llm
from .settings import env

SESSION_RE = re.compile(r"[0-9a-f]{32}")
SESSION_HEADER = "x-protocolos-session"
HOUR, DAY = 3600.0, 86400.0

KEY_NEEDED = {
    "new_trial": "Analysing a trial that is not preloaded needs your own OpenAI or Anthropic API key.",
    "new_draft": "Drafting criteria for a new idea needs your own OpenAI or Anthropic API key.",
    "upload": "Reviewing your own protocol needs your own OpenAI or Anthropic API key.",
    "model": "Model answers use your own OpenAI or Anthropic API key.",
}


class AccessDenied(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    def body(self) -> dict:
        return {"detail": self.message, "code": self.code}


def _int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except (TypeError, ValueError):
        return default


class Window:
    """Sliding-window counter: at most `limit` events per `span` seconds for each key."""

    def __init__(self, span: float):
        self.span = span
        self.events: dict[str, deque] = {}
        self.lock = threading.Lock()

    def _live(self, key: str, now: float) -> deque:
        q = self.events.setdefault(key, deque())
        while q and q[0] <= now - self.span:
            q.popleft()
        return q

    def allow(self, key: str, limit: int, record: bool = True) -> bool:
        now = time.monotonic()
        with self.lock:
            if len(self.events) > 10000:
                self.events = {k: q for k, q in self.events.items() if q and q[-1] > now - self.span}
            q = self._live(key, now)
            if len(q) >= limit:
                return False
            if record:
                q.append(now)
            return True

    def reset(self) -> None:
        with self.lock:
            self.events.clear()


CHECKS, CHECKS_ALL, NEW_WORK, NEW_TODAY, MODEL_CALLS = Window(HOUR), Window(HOUR), Window(HOUR), Window(DAY), Window(HOUR)


def reset() -> None:
    """Clear every limit (tests)."""
    for w in (CHECKS, CHECKS_ALL, NEW_WORK, NEW_TODAY, MODEL_CALLS):
        w.reset()


def visitor(client: str, creds: llm.Credentials) -> str:
    """The limit key: client address plus a short hash of the key (never the key itself)."""
    return f"{client}|{hashlib.sha256(f'{creds.provider}:{creds.key}'.encode()).hexdigest()[:16]}"


def session_of(headers, query=None) -> str | None:
    """The visitor session id from the header or ?session=, or None when absent or not 32 lowercase hex digits."""
    for v in ((headers.get(SESSION_HEADER) if headers is not None else None), (query.get("session") if query is not None else None)):
        if isinstance(v, str) and SESSION_RE.fullmatch(v.strip()):
            return v.strip()
    return None


def client_of(headers, scope_client=None) -> str:
    for name in ("x-vercel-forwarded-for", "x-forwarded-for", "x-real-ip"):
        v = headers.get(name) if headers is not None else None
        if v:
            return v.split(",")[0].strip()[:64]
    return (scope_client or ("unknown",))[0]


def credentials(headers) -> llm.Credentials | None:
    try:
        return llm.from_headers(headers)
    except ValueError as e:
        raise AccessDenied(400, "key_malformed", str(e))


def check_key(headers, client: str, kind: str = "model") -> llm.Credentials:
    """Credentials from the headers, confirmed with the provider; AccessDenied when missing, invalid or over a limit."""
    creds = credentials(headers)
    if creds is None:
        raise AccessDenied(401, "key_required", KEY_NEEDED.get(kind, KEY_NEEDED["model"]))
    if not CHECKS.allow(visitor(client, creds), _int("CHECKS_PER_HOUR", 20)) or not CHECKS_ALL.allow("all", 600):
        raise AccessDenied(429, "rate_limited", "Too many key checks; try again in an hour.")
    result = llm.check(creds)
    if not result.ok:
        raise AccessDenied(502 if result.code == "provider_unreachable" else 401, result.code, result.message)
    return creds


def allow_new_work(headers, client: str, kind: str) -> llm.Credentials:
    """Gate for analysing an uncached trial or drafting a new idea on the public deployment."""
    creds = check_key(headers, client, kind)
    free_mb = shutil.disk_usage(llm.ROOT).free // (1024 * 1024)
    if free_mb < _int("MIN_FREE_MB", 1024):
        raise AccessDenied(507, "storage_full", "The demo server is out of space for new analyses; preloaded trials still work.")
    who = visitor(client, creds)
    if not NEW_WORK.allow(who, _int("NEW_PER_HOUR", 6), record=False):
        raise AccessDenied(429, "rate_limited", "You have started the maximum number of new analyses for this hour; try again later.")
    if not NEW_TODAY.allow("all", _int("NEW_PER_DAY", 25)):
        raise AccessDenied(429, "daily_limit", "The demo server has reached today's limit of new analyses; preloaded trials still work.")
    NEW_WORK.allow(who, _int("NEW_PER_HOUR", 6))
    return creds


def allow_model_call(headers, client: str) -> llm.Credentials:
    creds = check_key(headers, client, "model")
    if not MODEL_CALLS.allow(visitor(client, creds), _int("MODEL_PER_HOUR", 30)):
        raise AccessDenied(429, "rate_limited", "Too many model requests; try again in an hour.")
    return creds
