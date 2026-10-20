"""The visitor's own model key (trialforge/llm.py): header parsing, key check, OpenAI and Anthropic calls. No network."""
import json

import pytest

from trialforge import llm

OPENAI = {"X-Model-Provider": "openai", "X-Model-Key": "sk-proj-" + "a" * 30}
ANTHROPIC = {"X-Model-Provider": "anthropic", "X-Model-Key": "sk-ant-api03-" + "b" * 30}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    llm._checked.clear()
    for name in ("PROTOCOLOS_PUBLIC", "TRIALLENS_PUBLIC", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def test_from_headers_defaults_and_allowlist():
    c = llm.from_headers({k.lower(): v for k, v in OPENAI.items()})
    assert (c.provider, c.model, c.source) == ("openai", "gpt-6.1-sol", "request")
    assert "sk-" not in repr(c)  # the key is not in the repr, so it cannot reach a log through it
    c = llm.from_headers({"x-model-provider": "anthropic", "x-model-key": ANTHROPIC["X-Model-Key"], "x-model-name": "claude-sonnet-5-5"})
    assert c.model == "claude-sonnet-5-5" and c.label() == "claude-sonnet-5-5 (Anthropic, your key)"
    assert llm.from_headers({}) is None
    for bad in ({"x-model-provider": "mistral", "x-model-key": "k" * 30},
                {"x-model-provider": "openai", "x-model-key": "short"},
                {"x-model-provider": "openai", "x-model-key": "sk-" + "a" * 30, "x-model-name": "claude-opus-5-5"},
                {"x-model-provider": "openai", "x-model-key": "sk-a b" + "a" * 30}):
        with pytest.raises(ValueError):
            llm.from_headers(bad)


def test_env_key_only_for_local_runs(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-local-" + "c" * 30)
    assert llm.resolve({}).source == "environment"
    monkeypatch.setenv("PROTOCOLOS_PUBLIC", "1")
    assert llm.from_env() is None and llm.resolve({}) is None


def test_strict_ok():
    assert llm.strict_ok(llm.CRITIC_SCHEMA) and llm.strict_ok(llm.LLM_VERIFY_SCHEMA)
    assert not llm.strict_ok(llm.PARSE_SCHEMA)  # claim items have optional fields and an untyped value


def test_redact():
    assert llm.redact("Incorrect API key provided: sk-proj-abc123****wxyz") == "Incorrect API key provided: sk-…"


class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


def test_openai_check_statuses_and_cache(monkeypatch):
    import httpx

    creds = llm.from_headers({k.lower(): v for k, v in OPENAI.items()})
    calls = []

    def get(url, headers, timeout):
        calls.append(url)
        assert headers["Authorization"] == f"Bearer {creds.key}"
        return FakeResponse(status[0], {})

    monkeypatch.setattr(httpx, "get", get)
    status = [401]
    assert llm.check(creds).code == "key_invalid"
    llm._checked.clear()
    status = [200]
    assert llm.check(creds).ok and llm.check(creds).ok
    assert calls[-1].endswith("/models/gpt-6.1-sol") and len(calls) == 2  # the second ok came from the cache
    assert all(creds.key not in k for k in llm._checked)  # only a hash is kept
    llm._checked.clear()
    status = [404]
    assert llm.check(creds).code == "model_unavailable"
    llm._checked.clear()
    status = [403]
    assert llm.check(creds).ok  # a restricted key without "models: read" is still a real key


def test_openai_call_reads_structured_output(monkeypatch):
    import httpx

    creds = llm.from_headers({k.lower(): v for k, v in OPENAI.items()})
    seen = {}

    def post(url, headers, json, timeout):
        seen.update(url=url, body=json)
        return FakeResponse(200, {"status": "completed", "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": '{"status": "PASSED", "reasons": ["ok"]}'}]}]})

    monkeypatch.setattr(httpx, "post", post)
    out = llm.json_call("sys", "user", llm.LLM_VERIFY_SCHEMA, creds)
    assert out == {"status": "PASSED", "reasons": ["ok"]}
    fmt = seen["body"]["text"]["format"]
    assert seen["url"].endswith("/responses") and fmt["type"] == "json_schema" and fmt["strict"] is True
    assert seen["body"]["input"][0] == {"role": "system", "content": "sys"}


def test_openai_call_errors_never_echo_the_key(monkeypatch):
    import httpx

    creds = llm.from_headers({k.lower(): v for k, v in OPENAI.items()})
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse(400, {"error": {"message": f"bad request for key {creds.key}"}}))
    with pytest.raises(llm.ModelError) as e:
        llm.json_call("s", "u", llm.LLM_VERIFY_SCHEMA, creds)
    assert creds.key not in str(e.value) and "HTTP 400" in str(e.value)
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse(200, {"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}]}))
    with pytest.raises(llm.ModelError, match="declined"):
        llm.json_call("s", "u", llm.LLM_VERIFY_SCHEMA, creds)
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse(200, {"output": [{"type": "message", "content": [{"type": "output_text", "text": '{"status": "MAYBE", "reasons": []}'}]}]}))
    with pytest.raises(llm.ModelError, match="schema-valid"):
        llm.json_call("s", "u", llm.LLM_VERIFY_SCHEMA, creds)


class _Block:
    def __init__(self, type_, text=None):
        self.type, self.text = type_, text


class _Resp:
    def __init__(self, stop_reason, text):
        self.stop_reason = stop_reason
        self.content = [_Block("thinking"), _Block("text", text)]


def test_anthropic_call_uses_the_visitors_key(monkeypatch):
    import anthropic

    creds = llm.from_headers({k.lower(): v for k, v in ANTHROPIC.items()})
    seen = {}

    class Messages:
        def create(self, **kw):
            seen.update(kw)
            return _Resp("end_turn", json.dumps({"status": "REJECTED", "reasons": ["x"]}))

    class Client:
        def __init__(self, api_key, max_retries, timeout):
            seen["api_key"] = api_key
            self.messages = Messages()
            self.beta = type("B", (), {"messages": Messages()})()

    monkeypatch.setattr(anthropic, "Anthropic", Client)
    out = llm.json_call("sys", "user", llm.LLM_VERIFY_SCHEMA, creds)
    assert out["status"] == "REJECTED" and seen["api_key"] == creds.key
    assert seen["model"] == "claude-opus-5-5" and seen["fallbacks"] == "default"
    assert seen["output_config"]["format"] == {"type": "json_schema", "schema": llm.LLM_VERIFY_SCHEMA}

    haiku = llm.Credentials("anthropic", "claude-haiku-5-5", creds.key)
    seen.clear()
    llm.json_call("sys", "user", llm.LLM_VERIFY_SCHEMA, haiku)
    assert "fallbacks" not in seen and seen["model"] == "claude-haiku-5-5"


def test_anthropic_refusal_is_a_model_error(monkeypatch):
    import anthropic

    class Client:
        def __init__(self, **kw):
            m = type("M", (), {"create": lambda self, **k: _Resp("refusal", "")})()
            self.messages, self.beta = m, type("B", (), {"messages": m})()

    monkeypatch.setattr(anthropic, "Anthropic", Client)
    with pytest.raises(llm.ModelError, match="declined"):
        llm.json_call("s", "u", llm.LLM_VERIFY_SCHEMA, llm.Credentials("anthropic", "claude-opus-5-5", "sk-ant-" + "z" * 30))


def _keywords(schema) -> set:
    if isinstance(schema, dict):
        return set(schema) | {k for v in schema.values() for k in _keywords(v)}
    if isinstance(schema, list):
        return {k for v in schema for k in _keywords(v)}
    return set()


def test_anthropic_gets_schemas_without_unsupported_keywords(monkeypatch):
    """The investigator's maxItems and the parser's nullable fields reach Anthropic in a form its structured outputs accept."""
    import anthropic

    from trialforge import investigate

    sent = []

    class Messages:
        def create(self, **kw):
            sent.append(kw["output_config"]["format"]["schema"])
            return _Resp("end_turn", "{}")

    class Client:
        def __init__(self, **kw):
            self.messages = Messages()
            self.beta = type("B", (), {"messages": Messages()})()

    monkeypatch.setattr(anthropic, "Anthropic", Client)
    creds = llm.Credentials("anthropic", "claude-opus-5-5", "sk-ant-" + "z" * 30)
    for schema in (investigate.MODEL_SCHEMA, llm.PARSE_SCHEMA, llm.CRITIC_SCHEMA, llm.LLM_VERIFY_SCHEMA):
        with pytest.raises(llm.ModelError):  # "{}" lacks the required keys; only the request matters here
            llm.json_call("s", "u", schema, creds)
    assert len(sent) == 4
    for schema in sent:
        assert not _keywords(schema) & {"maxItems", "minLength", "maxLength", "minimum", "maximum"}
    statements = sent[0]["properties"]["statements"]
    assert "maxItems" not in statements and "maxItems: 10" in statements["description"]  # kept as guidance for the model
