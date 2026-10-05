"""DGX-578: every LiteLLM request carries the Hermes session that launched it."""

from types import SimpleNamespace

from agent.litellm_session_header import (
    LITELLM_SESSION_HEADER,
    is_litellm_target,
    merge_litellm_session_header,
)


def test_litellm_hosts_are_targets():
    assert is_litellm_target("http://litellm.litellm.svc.cluster.local:4000/v1")
    assert is_litellm_target("http://litellm-alibaba.litellm.svc.cluster.local:4000/v1")
    assert is_litellm_target("https://litellm.lan.e-dani.com")


def test_other_hosts_are_not_targets():
    assert not is_litellm_target("https://openrouter.ai/api/v1")
    assert not is_litellm_target("http://omnivoice-tts.llm.svc.cluster.local:8000/v1")
    assert not is_litellm_target(None)
    assert not is_litellm_target("")


def test_merge_adds_the_session_and_keeps_other_headers():
    kwargs = {"model": "m", "extra_headers": {"x-opencode-session": "s"}}
    out = merge_litellm_session_header(kwargs, "http://litellm:4000/v1", "epica-infra-552")
    assert out["extra_headers"] == {"x-opencode-session": "s", LITELLM_SESSION_HEADER: "epica-infra-552"}


def test_caller_pinned_value_wins():
    kwargs = {"extra_headers": {LITELLM_SESSION_HEADER: "pinned"}}
    merge_litellm_session_header(kwargs, "http://litellm:4000/v1", "other")
    assert kwargs["extra_headers"][LITELLM_SESSION_HEADER] == "pinned"


def test_no_session_or_no_litellm_is_a_noop():
    kwargs = {"model": "m"}
    assert merge_litellm_session_header(dict(kwargs), "http://litellm:4000/v1", None) == kwargs
    assert merge_litellm_session_header(dict(kwargs), "https://openrouter.ai/api/v1", "s1") == kwargs


def test_build_api_kwargs_sends_the_session_to_litellm(monkeypatch):
    import agent.chat_completion_helpers as helpers

    monkeypatch.setattr(helpers, "_build_api_kwargs_for_mode", lambda agent, m, t: {"model": "q"})
    agent = SimpleNamespace(provider="custom", base_url="http://litellm.litellm.svc.cluster.local:4000/v1",
                            session_id="epica-sc-1869")
    kwargs = helpers.build_api_kwargs(agent, [], [])
    assert kwargs["extra_headers"][LITELLM_SESSION_HEADER] == "epica-sc-1869"
