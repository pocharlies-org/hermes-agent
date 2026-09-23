"""Resumed api_server sessions keep a named ``providers:`` entry's identity.

The global runtime for ``model.provider: litellm`` (a ``providers:`` entry) resolves to
``provider="custom"`` + ``requested_provider="litellm"``. A session with a persisted model must
re-resolve by ``litellm``, never by bare ``custom`` (which routes to OpenRouter without a key).
"""
from unittest.mock import MagicMock

from gateway.platforms.api_server import APIServerAdapter


def _adapter(calls):
    adapter = APIServerAdapter.__new__(APIServerAdapter)
    adapter._model_name = "hermes-agent"
    adapter._last_resolved_model = {}
    adapter._session_model_override_for = MagicMock(return_value=None)

    def _resolve(provider, *, target_model, required):
        calls.append(provider)
        if provider == "litellm":
            return {"provider": "custom", "base_url": "http://litellm:4000/v1", "api_key": "k"}
        return None  # bare "custom": no credentials

    adapter._resolve_provider_runtime = _resolve
    return adapter


def _runtime():
    return {"provider": "custom", "requested_provider": "litellm",
            "base_url": "http://litellm:4000/v1", "api_key": "k", "api_mode": "chat_completions"}


def test_session_persisted_model_reresolves_by_named_provider():
    calls = []
    runtime = _runtime()
    model, *_ = _adapter(calls)._select_agent_runtime(
        runtime, "qwen38-off", requested_model=None, requested_provider=None, route=None,
        session_model="qwen38-off", confirmed_runtime_lock=False,
        gateway_session_key=None, session_id="s1")
    assert calls == ["litellm"]
    assert model == "qwen38-off"
    assert runtime["base_url"] == "http://litellm:4000/v1" and runtime["api_key"] == "k"


def test_non_custom_provider_is_untouched():
    calls = []
    runtime = {"provider": "openrouter", "requested_provider": "openrouter", "api_key": "k"}
    _adapter(calls)._select_agent_runtime(
        runtime, "m", requested_model=None, requested_provider=None, route=None,
        session_model="m2", confirmed_runtime_lock=False, gateway_session_key=None, session_id="s1")
    assert calls == ["openrouter"]
