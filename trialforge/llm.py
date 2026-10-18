"""Optional LLM components (Chalk Model Gateway when its key is set, otherwise the Anthropic SDK).

1. critique()             - adversarial review of one review flag; may only DOWNGRADE a flag
2. parse_recommendation() - turn a free-text challenge into the structured form the verifier checks
3. llm_only_verify()      - LLM-only verifier, used as an evaluation baseline

If no credentials are configured, available() is False and every caller shows the component as
"not configured" rather than substituting canned output.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

MODEL = os.environ.get("TRIALFORGE_MODEL", "claude-opus-5-5")
ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_dotenv()


CHALK_ROUTER_URL = os.environ.get("CHALK_ROUTER_URL", "https://api.chalk.ai/v1/router")
CHALK_ROUTER_ENV = os.environ.get("CHALK_ROUTER_ENV_ID", "clkdcdaf84e")
CHALK_ROUTER_MODEL = os.environ.get("CHALK_ROUTER_MODEL", "openai/gpt-6.1-sol")


def provider() -> str | None:
    """Chalk Model Gateway (router) is preferred when its key is present; Anthropic API otherwise."""
    if os.environ.get("CHALK_ROUTER_API_KEY"):
        return "chalk_router"
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    return None


def available() -> bool:
    return provider() is not None


def model_label() -> str | None:
    p = provider()
    return f"{CHALK_ROUTER_MODEL} via Chalk Model Gateway" if p == "chalk_router" else (MODEL if p == "anthropic" else None)


def _client():
    import anthropic

    return anthropic.Anthropic()


def _extract_json(text: str) -> dict:
    import re

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


def _router_call(system: str, user: str, schema: dict) -> dict:
    """OpenAI-compatible chat completion through the Chalk router. No temperature (per event guidance)."""
    import httpx

    instructions = system + "\n\nReturn ONLY a JSON object (no prose, no code fences) that conforms to this JSON Schema:\n" + json.dumps(schema)
    last_err = None
    for attempt in range(2):
        r = httpx.post(
            f"{CHALK_ROUTER_URL.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {os.environ['CHALK_ROUTER_API_KEY']}", "X-Chalk-Env-Id": CHALK_ROUTER_ENV, "Content-Type": "application/json"},
            json={"model": CHALK_ROUTER_MODEL, "max_tokens": 3000,
                  "messages": [{"role": "system", "content": instructions}, {"role": "user", "content": user}]},
            timeout=120,
        )
        if r.status_code != 200:
            raise RuntimeError(f"Chalk router HTTP {r.status_code}: {r.text[:300]}")
        content = r.json()["choices"][0]["message"]["content"]
        try:
            obj = _extract_json(content)
            _check_schema(obj, schema)
            return obj
        except (ValueError, json.JSONDecodeError) as e:
            last_err = e
            user = user + "\n\nYour previous reply was not valid JSON for the schema. Reply with the JSON object only."
    raise RuntimeError(f"model did not return schema-valid JSON: {last_err}")


def _json_call(system: str, user: str, schema: dict, effort: str = "medium") -> dict:
    if provider() == "chalk_router":
        return _router_call(system, user, schema)
    import anthropic

    client = _client()
    kwargs = dict(
        model=MODEL,
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
    )
    try:
        # server-side refusal fallback (beta) as recommended for this model family
        resp = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    except anthropic.BadRequestError:
        resp = client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined the request")
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


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


def critique(review_item: dict, regimen: dict) -> dict:
    payload = {
        "criterion": {k: review_item["criterion"][k] for k in ("label", "operator", "value_norm", "unit_norm", "section", "conditions", "exceptions")},
        "regimen": {k: {"class": v["class"], "myelosuppressive": v["myelosuppressive"], "hepatic": v["hepatic"], "renal": v["renal"], "immunotherapy": v["immunotherapy"]} for k, v in regimen.items()},
        "classification": review_item["classification"],
        "explanation": review_item["explanation"],
        "suggested_action": review_item["suggested_action"],
        "evidence": [{k: e.get(k) for k in ("kind", "stance", "strength", "summary", "quote", "nct_id")} for e in review_item["evidence"]],
        "missing_evidence": review_item["missing_evidence"],
    }
    return _json_call(CRITIC_SYSTEM, json.dumps(payload, ensure_ascii=False), CRITIC_SCHEMA)


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


def parse_recommendation(text: str, ctx: dict) -> dict:
    crits = [{"id": c["id"], "label": c["label"], "current": f"{c['operator']}{c['value_norm']} {c['unit_norm']}"} for c in ctx["target"]["criteria"]]
    user = json.dumps({"criteria": crits, "regimen": sorted(ctx["target"]["regimen"]["drugs"]), "recommendation": text}, ensure_ascii=False)
    out = _json_call(PARSE_SYSTEM, user, PARSE_SCHEMA, effort="low")
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


def llm_only_verify(rec: dict, ctx: dict) -> dict:
    context = {
        "criteria": [{"id": c["id"], "current": f"{c['operator']}{c['value_norm']} {c['unit_norm']}"} for c in ctx["target"]["criteria"]],
        "regimen": {k: v["class"] for k, v in ctx["target"]["regimen"]["drugs"].items()},
        "comparators": [{"nct_id": c["study"]["nct_id"], "thresholds": {x["id"]: f"{x['operator']}{x['value_norm']} {x['unit_norm']}" for x in c["criteria"]}} for c in ctx["comparators"]],
    }
    return _json_call(LLM_VERIFY_SYSTEM, json.dumps({"context": context, "recommendation": rec}, ensure_ascii=False), LLM_VERIFY_SCHEMA)
