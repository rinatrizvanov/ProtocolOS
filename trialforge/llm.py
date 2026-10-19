"""Optional model components, run with the visitor's own OpenAI or Anthropic API key.

1. critique()             - adversarial review of one review flag; may only DOWNGRADE a flag
2. parse_recommendation() - turn a free-text challenge into the structured form the verifier checks
3. llm_only_verify()      - LLM-only verifier, used as an evaluation baseline

Credentials arrive with each request (headers X-Model-Provider, X-Model-Key, X-Model-Name) and are used for that
request only: they are never written to disk or logs; check() remembers only a SHA-256 of a key it verified, for a
few minutes. A local run without PROTOCOLOS_PUBLIC=1 may fall back to ANTHROPIC_API_KEY or OPENAI_API_KEY from the
environment (the evaluation scripts use this); the public deployment never uses a server key. Without credentials
every caller reports "not configured" rather than substituting canned output.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .settings import flag

ROOT = Path(__file__).resolve().parent.parent

# First model of each provider is the default. Only these ids are accepted, so a request cannot name an arbitrary model.
PROVIDERS = {
    "anthropic": {"name": "Anthropic", "models": ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")},
    "openai": {"name": "OpenAI", "models": ("gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna")},
}
# Anthropic models that take the server-side refusal fallback ("default" form, Claude API only).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}
ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
OPENAI_URL = "https://api.openai.com/v1"
KEY_RE = re.compile(r"[A-Za-z0-9_\-]{20,300}")
# Provider error text can echo part of a key; anything key-shaped is cut before a message leaves this module.
_KEYISH = re.compile(r"(sk-|key-)[A-Za-z0-9_\-*.]{4,}")
HEADER_PROVIDER, HEADER_KEY, HEADER_MODEL = "x-model-provider", "x-model-key", "x-model-name"
TIMEOUT = 100.0
MAX_TOKENS = 16000
CHECK_TTL = 600.0


def _load_dotenv():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_dotenv()


class ModelError(RuntimeError):
    """A model call failed; the message is safe to show (no key material)."""


def redact(text: str) -> str:
    return _KEYISH.sub(lambda m: m.group(1) + "…", text)


@dataclass(frozen=True)
class Credentials:
    provider: str
    model: str
    key: str = field(repr=False)
    source: str = "request"  # "request" (the visitor's key) or "environment" (local runs only)

    def label(self) -> str:
        owner = "your key" if self.source == "request" else "local key"
        return f"{self.model} ({PROVIDERS[self.provider]['name']}, {owner})"


def _get(headers, name: str) -> str:
    v = headers.get(name) if headers is not None else None
    return v.strip() if isinstance(v, str) else ""


def from_headers(headers) -> Credentials | None:
    """The visitor's credentials, or None when no key header was sent. Raises ValueError for a malformed set."""
    key = _get(headers, HEADER_KEY)
    if not key:
        return None
    provider = _get(headers, HEADER_PROVIDER).lower()
    if provider not in PROVIDERS:
        raise ValueError(f"{HEADER_PROVIDER} must be one of {', '.join(PROVIDERS)}")
    if not KEY_RE.fullmatch(key):
        raise ValueError("the API key has an unexpected format")
    model = _get(headers, HEADER_MODEL) or PROVIDERS[provider]["models"][0]
    if model not in PROVIDERS[provider]["models"]:
        raise ValueError(f"{HEADER_MODEL} must be one of {', '.join(PROVIDERS[provider]['models'])}")
    return Credentials(provider, model, key)


def from_env() -> Credentials | None:
    """A key from the environment, for local runs and evaluations. Never used on the public deployment."""
    if flag("PUBLIC"):
        return None
    for provider, var in ENV_KEYS.items():
        if os.environ.get(var):
            return Credentials(provider, PROVIDERS[provider]["models"][0], os.environ[var], "environment")
    return None


def resolve(headers) -> Credentials | None:
    """Request credentials, else (local runs only) environment credentials. A malformed header set counts as none."""
    try:
        creds = from_headers(headers)
    except ValueError:
        return None
    return creds or from_env()


# ----------------------------------------------------------------------------- key check

@dataclass(frozen=True)
class KeyCheck:
    ok: bool
    code: str  # ok | key_invalid | model_unavailable | provider_unreachable
    message: str


_checked: dict[str, tuple[float, KeyCheck]] = {}
_checked_lock = threading.Lock()


def _fingerprint(creds: Credentials) -> str:
    return hashlib.sha256(f"{creds.provider}\n{creds.model}\n{creds.key}".encode()).hexdigest()


def _check_anthropic(creds: Credentials) -> KeyCheck:
    import anthropic

    client = anthropic.Anthropic(api_key=creds.key, max_retries=0, timeout=15.0)
    try:
        client.models.retrieve(creds.model)
    except anthropic.AuthenticationError:
        return KeyCheck(False, "key_invalid", "Anthropic rejected this API key.")
    except anthropic.NotFoundError:
        return KeyCheck(False, "model_unavailable", f"{creds.model} is not available to this Anthropic key.")
    except anthropic.PermissionDeniedError:
        return KeyCheck(False, "model_unavailable", f"This Anthropic key may not use {creds.model}.")
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        return KeyCheck(False, "provider_unreachable", f"Anthropic did not confirm the key ({type(e).__name__}); try again.")
    return KeyCheck(True, "ok", f"Key accepted for {creds.model}.")


def _check_openai(creds: Credentials) -> KeyCheck:
    import httpx

    try:
        r = httpx.get(f"{OPENAI_URL}/models/{creds.model}", headers={"Authorization": f"Bearer {creds.key}"}, timeout=15.0)
    except httpx.HTTPError as e:
        return KeyCheck(False, "provider_unreachable", f"OpenAI did not answer ({type(e).__name__}); try again.")
    if r.status_code == 200:
        return KeyCheck(True, "ok", f"Key accepted for {creds.model}.")
    if r.status_code == 401:
        return KeyCheck(False, "key_invalid", "OpenAI rejected this API key.")
    if r.status_code == 403:
        # A valid restricted key without the "models: read" permission; an unknown key answers 401.
        return KeyCheck(True, "ok", f"Key accepted (it may not list models); {creds.model} is used as chosen.")
    if r.status_code == 404:
        return KeyCheck(False, "model_unavailable", f"{creds.model} is not available to this OpenAI key.")
    return KeyCheck(False, "provider_unreachable", f"OpenAI answered HTTP {r.status_code}; try again.")


def check(creds: Credentials) -> KeyCheck:
    """Confirm the key with a models lookup (no tokens are used). Results are kept for CHECK_TTL seconds by hash."""
    fp = _fingerprint(creds)
    now = time.monotonic()
    with _checked_lock:
        hit = _checked.get(fp)
        if hit and hit[0] > now:
            return hit[1]
    result = _check_anthropic(creds) if creds.provider == "anthropic" else _check_openai(creds)
    if result.code != "provider_unreachable":
        with _checked_lock:
            if len(_checked) > 2000:
                _checked.clear()
            _checked[fp] = (now + (CHECK_TTL if result.ok else 60.0), result)
    return result


# ----------------------------------------------------------------------------- structured calls

def _extract_json(text: str) -> dict:
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in model output")
    return json.loads(t[start : end + 1])


def _check_schema(obj: dict, schema: dict):
    missing = [k for k in schema.get("required", []) if k not in obj]
    if missing:
        raise ValueError(f"model output missing keys {missing}")
    for k, spec in schema.get("properties", {}).items():
        if "enum" in spec and k in obj and obj[k] not in spec["enum"]:
            raise ValueError(f"{k}={obj[k]!r} not in {spec['enum']}")


def strict_ok(schema) -> bool:
    """True when OpenAI's strict structured outputs accept the schema: every object closed, every property required."""
    if not isinstance(schema, dict) or not schema:
        return False
    if schema.get("type") == "object" or "properties" in schema:
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is not False or set(schema.get("required", [])) != set(props):
            return False
        return all(strict_ok(p) for p in props.values())
    if schema.get("type") == "array" or "items" in schema:
        return strict_ok(schema.get("items"))
    return True


def _anthropic_call(system: str, user: str, schema: dict, creds: Credentials, effort: str) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=creds.key, max_retries=1, timeout=TIMEOUT)
    kwargs = dict(
        model=creds.model,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
    )
    try:
        if creds.model in FALLBACK_MODELS:
            # server-side refusal fallback (beta), recommended for this model family
            resp = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
        else:
            resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError:
        raise ModelError("Anthropic rejected the API key")
    except anthropic.RateLimitError:
        raise ModelError("Anthropic rate limit or spending limit reached for this key")
    except anthropic.APIStatusError as e:
        raise ModelError(redact(f"Anthropic HTTP {e.status_code}: {getattr(e, 'message', '')}"[:300]))
    except anthropic.APIConnectionError as e:
        raise ModelError(f"Anthropic not reachable ({type(e).__name__})")
    if resp.stop_reason == "refusal":
        raise ModelError("model declined the request")
    if resp.stop_reason == "max_tokens":
        raise ModelError("model output was cut off")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if text is None:
        raise ModelError("model returned no text")
    return json.loads(text)


def _openai_call(system: str, user: str, schema: dict, creds: Credentials) -> dict:
    import httpx

    body = {
        "model": creds.model,
        "input": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "text": {"format": {"type": "json_schema", "name": "protocolos_output", "schema": schema, "strict": strict_ok(schema)}},
        "max_output_tokens": MAX_TOKENS,
    }
    try:
        r = httpx.post(f"{OPENAI_URL}/responses", headers={"Authorization": f"Bearer {creds.key}"}, json=body, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        raise ModelError(f"OpenAI not reachable ({type(e).__name__})")
    if r.status_code == 401:
        raise ModelError("OpenAI rejected the API key")
    if r.status_code == 429:
        raise ModelError("OpenAI rate limit or quota reached for this key")
    if r.status_code != 200:
        try:
            msg = (r.json().get("error") or {}).get("message", "")
        except ValueError:
            msg = ""
        raise ModelError(redact(f"OpenAI HTTP {r.status_code}: {msg}"[:300]))
    data = r.json()
    if data.get("status") == "incomplete":
        raise ModelError(f"model output incomplete ({(data.get('incomplete_details') or {}).get('reason', 'unknown')})")
    for item in data.get("output") or []:
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if part.get("type") == "refusal":
                raise ModelError("model declined the request")
            if part.get("type") == "output_text":
                obj = _extract_json(part.get("text") or "")
                _check_schema(obj, schema)
                return obj
    raise ModelError("model returned no text")


def json_call(system: str, user: str, schema: dict, creds: Credentials, effort: str = "medium") -> dict:
    """One structured call with the given credentials; raises ModelError (key-free message) on failure."""
    if creds is None:
        raise ModelError("no model key")
    try:
        if creds.provider == "anthropic":
            return _anthropic_call(system, user, schema, creds, effort)
        return _openai_call(system, user, schema, creds)
    except (ValueError, json.JSONDecodeError) as e:
        raise ModelError(f"model did not return schema-valid JSON: {redact(str(e))[:200]}")


CRITIC_SYSTEM = """You are a skeptical clinical-trial methodologist reviewing an automated eligibility-criterion review.
You receive one criterion, the evidence items the system gathered (each with a stance and a source), the system's
classification, and its suggested action. Your job is to find problems, not to agree:
- unsupported leaps (e.g. treating a permissive comparator as proof a threshold is unnecessary; treating a toxicity
  rationale as proof that a specific value is optimal; ignoring arms or regimen differences),
- evidence that contradicts the conclusion, and evidence that is missing,
- overclaims about safety, efficacy or enrollment.
Use ONLY the evidence provided; do not invent studies, values or quotes. "insufficient_evidence" is an acceptable verdict.
You may recommend a downgrade, never an upgrade."""

CRITIC_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["agree", "overstated", "insufficient_evidence", "unsupported"]},
        "issues": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["unsupported_leap", "contradictory_evidence", "missing_evidence", "overclaim", "regimen_mismatch", "other"]},
            "detail": {"type": "string"}}, "required": ["type", "detail"], "additionalProperties": False}},
        "safety_rationale_vs_threshold": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["verdict", "issues", "safety_rationale_vs_threshold", "summary"],
    "additionalProperties": False,
}


def critique(review_item: dict, regimen: dict, creds: Credentials) -> dict:
    payload = {
        "criterion": {k: review_item["criterion"][k] for k in ("label", "operator", "value_norm", "unit_norm", "section", "conditions", "exceptions")},
        "regimen": {k: {"class": v["class"], "myelosuppressive": v["myelosuppressive"], "hepatic": v["hepatic"], "renal": v["renal"], "immunotherapy": v["immunotherapy"]} for k, v in regimen.items()},
        "classification": review_item["classification"],
        "explanation": review_item["explanation"],
        "suggested_action": review_item["suggested_action"],
        "evidence": [{k: e.get(k) for k in ("kind", "stance", "strength", "summary", "quote", "nct_id")} for e in review_item["evidence"]],
        "missing_evidence": review_item["missing_evidence"],
    }
    return json_call(CRITIC_SYSTEM, json.dumps(payload, ensure_ascii=False), CRITIC_SCHEMA, creds)


PARSE_SYSTEM = """Convert a reviewer's free-text recommendation about one clinical-trial eligibility criterion into the
structured JSON form. Do not add claims the text does not make. Use criterion ids from the provided list.
Claims: drug_property (drug, property in myelosuppressive|hepatic|renal|immunotherapy, value boolean),
comparator_threshold (nct_id, value, unit), fda_quote (guidance in lab|ps|washout, quote), protocol_quote (quote)."""

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "criterion_id": {"type": "string"},
        "action": {"type": "string", "enum": ["relax", "remove", "tighten", "retain", "add_provision", "justify_in_protocol"]},
        "proposed_value": {"type": ["number", "null"]},
        "proposed_unit": {"type": ["string", "null"]},
        "claims": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["drug_property", "comparator_threshold", "fda_quote", "protocol_quote"]},
            "drug": {"type": ["string", "null"]}, "property": {"type": ["string", "null"]}, "value": {},
            "nct_id": {"type": ["string", "null"]}, "unit": {"type": ["string", "null"]},
            "guidance": {"type": ["string", "null"]}, "quote": {"type": ["string", "null"]}},
            "required": ["type"], "additionalProperties": False}},
        "text": {"type": "string"},
    },
    "required": ["criterion_id", "action", "proposed_value", "proposed_unit", "claims", "text"],
    "additionalProperties": False,
}


def parse_recommendation(text: str, ctx: dict, creds: Credentials) -> dict:
    crits = [{"id": c["id"], "label": c["label"], "current": f"{c['operator']}{c['value_norm']} {c['unit_norm']}"} for c in ctx["target"]["criteria"]]
    user = json.dumps({"criteria": crits, "regimen": sorted(ctx["target"]["regimen"]["drugs"]), "recommendation": text}, ensure_ascii=False)
    out = json_call(PARSE_SYSTEM, user, PARSE_SCHEMA, creds, effort="low")
    out["claims"] = [{k: v for k, v in c.items() if v is not None} for c in out["claims"]]
    return out


LLM_VERIFY_SYSTEM = """You verify a proposed change to a clinical-trial eligibility criterion. Decide whether it should be
REJECTED (any factual error, fabricated or mismatched source, invalid reasoning, contradiction with the trial's regimen,
or overclaim) or PASSED. You are given the trial's extracted criteria, regimen, and comparator thresholds as context.
Return the decision and the reasons."""

LLM_VERIFY_SCHEMA = {
    "type": "object",
    "properties": {"status": {"type": "string", "enum": ["REJECTED", "PASSED"]}, "reasons": {"type": "array", "items": {"type": "string"}}},
    "required": ["status", "reasons"],
    "additionalProperties": False,
}


def llm_only_verify(rec: dict, ctx: dict, creds: Credentials) -> dict:
    context = {
        "criteria": [{"id": c["id"], "current": f"{c['operator']}{c['value_norm']} {c['unit_norm']}"} for c in ctx["target"]["criteria"]],
        "regimen": {k: v["class"] for k, v in ctx["target"]["regimen"]["drugs"].items()},
        "comparators": [{"nct_id": c["study"]["nct_id"], "thresholds": {x["id"]: f"{x['operator']}{x['value_norm']} {x['unit_norm']}" for x in c["criteria"]}} for c in ctx["comparators"]],
    }
    return json_call(LLM_VERIFY_SYSTEM, json.dumps({"context": context, "recommendation": rec}, ensure_ascii=False), LLM_VERIFY_SCHEMA, creds)
