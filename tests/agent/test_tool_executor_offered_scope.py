"""DGX-791: a DIRECT tool call runs only if the tool was offered to the session.

``registry.dispatch`` knows only what is registered, so a model that echoed ``browser_exec``
from its history ran the pod's Chromium on a profile without ``browser``. Both executors
(sequential and concurrent; ``delegate_task`` children run the same ones) now gate the call
on ``agent.valid_tool_names`` before anything dispatches. The Tool Search bridge keeps its own
scope: a deferred tool is reached through ``tool_call``, as before.
"""

import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import tools.browser_use_cli  # noqa: F401 — registers browser_exec in the registry
from run_agent import AIAgent
from tools.code_execution_tool import SANDBOX_ALLOWED_TOOLS, _sandbox_tools_for
from tools.registry import registry


def _defs(*names: str) -> list:
    return [
        {"type": "function", "function": {"name": n, "description": f"{n} tool",
                                          "parameters": {"type": "object", "properties": {}}}}
        for n in names
    ]


def _agent(*offered: str) -> AIAgent:
    with (
        patch("model_tools.get_tool_definitions", return_value=_defs(*offered)),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        a = AIAgent(api_key="test-key-1234567890", base_url="https://openrouter.ai/api/v1",
                    quiet_mode=True, skip_context_files=True, skip_memory=True)
    a.client = MagicMock()
    return a


def _call(name: str, arguments: dict, call_id: str):
    return SimpleNamespace(id=call_id, type="function",
                           function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


def _run(agent, mode: str, *calls) -> list:
    msg = SimpleNamespace(content="", tool_calls=list(calls))
    messages: list = []
    getattr(agent, f"_execute_tool_calls_{mode}")(msg, messages, "task-791")
    return [m for m in messages if m["role"] == "tool"]


@pytest.fixture()
def browser_handler():
    """The real browser_exec registry handler resolves this module global at call time."""
    with patch("tools.browser_use_cli.browser_exec", return_value=json.dumps({"ok": True})) as h:
        yield h


@pytest.mark.parametrize("mode", ["sequential", "concurrent"])
def test_browser_exec_not_offered_is_refused_and_not_run(mode, browser_handler, caplog):
    agent = _agent("web_search")  # a session without browser / browser-use
    assert "browser_exec" not in agent.valid_tool_names

    with caplog.at_level(logging.WARNING, logger="agent.tool_executor"):
        results = _run(agent, mode, _call("browser_exec", {"code": "print(1)"}, "c1"))

    browser_handler.assert_not_called()
    assert len(results) == 1 and results[0]["tool_call_id"] == "c1"
    assert "'browser_exec' is not available in this session" in results[0]["content"], results[0]["content"]
    assert any("browser_exec blocked: not offered" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("mode", ["sequential", "concurrent"])
def test_browser_exec_offered_still_runs(mode, browser_handler):
    """Control: the patched handler IS the one dispatch reaches, so the refusal above is not vacuous."""
    agent = _agent("browser_exec", "web_search")
    results = _run(agent, mode, _call("browser_exec", {"code": "print(1)"}, "c1"))
    browser_handler.assert_called_once()
    assert '"ok": true' in results[0]["content"], results[0]["content"]


def test_offered_tool_runs_and_unoffered_sibling_is_refused_in_the_same_batch(browser_handler):
    agent = _agent("web_search")
    with patch("model_tools.handle_function_call", return_value="search result") as hfc:
        results = _run(agent, "concurrent",
                       _call("web_search", {"query": "x"}, "c1"), _call("browser_exec", {"code": "1"}, "c2"))
    assert [c.args[0] for c in hfc.call_args_list] == ["web_search"]
    browser_handler.assert_not_called()
    by_id = {r["tool_call_id"]: r["content"] for r in results}
    assert "search result" in by_id["c1"]
    assert "not available in this session" in by_id["c2"]


def _register_deferred(name: str, toolset: str) -> MagicMock:
    handler = MagicMock(return_value=json.dumps({"ok": True, "tool": name}))
    registry.register(
        name=name, toolset=toolset, handler=lambda args, **kw: handler(args),
        schema={"name": name, "description": f"{name} op",
                "parameters": {"type": "object", "properties": {"repo": {"type": "string"}}}},
    )
    return handler


def test_deferred_tool_through_tool_call_still_runs():
    """How a deferred tool is reached today: the model calls the ``tool_call`` bridge (offered),
    the executor unwraps it and checks ``_tool_search_scoped_names``. Unchanged."""
    handler = _register_deferred("mcp_dgx791_op", "mcp-dgx791")
    agent = _agent("tool_search", "tool_describe", "tool_call")
    agent.enabled_toolsets = ["mcp-dgx791"]

    results = _run(agent, "sequential",
                   _call("tool_call", {"name": "mcp_dgx791_op", "arguments": {"repo": "hermes"}}, "c1"))

    handler.assert_called_once_with({"repo": "hermes"})
    assert '"tool": "mcp_dgx791_op"' in results[0]["content"], results[0]["content"]


def test_deferred_tool_called_directly_is_refused():
    """A deferred tool is not in the offered schemas, so a direct call is refused here as the
    turn loop already refused it (``validate_tool_calls``: "Tool ... does not exist")."""
    handler = _register_deferred("mcp_dgx791_direct", "mcp-dgx791")
    agent = _agent("tool_search", "tool_describe", "tool_call")
    agent.enabled_toolsets = ["mcp-dgx791"]

    results = _run(agent, "sequential", _call("mcp_dgx791_direct", {"repo": "hermes"}, "c1"))

    handler.assert_not_called()
    assert "not available in this session" in results[0]["content"]


def test_injected_tools_count_as_offered():
    """Context-engine, memory-provider and message_agent tools are added to valid_tool_names
    when injected; the gate reads that same set."""
    from agent.tool_executor import _offered_scope_block

    agent = _agent("web_search")
    agent.valid_tool_names.add("lcm_grep")
    assert _offered_scope_block(agent, "lcm_grep") is None
    assert _offered_scope_block(agent, "computer_use") is not None


def test_execute_code_sandbox_only_gets_offered_tools():
    """The sandbox RPC used to fall back to EVERY sandbox tool when the session had none of
    them: execute_code without terminal reached terminal() from inside the script."""
    assert _sandbox_tools_for(["execute_code"]) == frozenset()
    assert _sandbox_tools_for(["execute_code", "terminal"]) == frozenset({"terminal"})
    assert _sandbox_tools_for(None) == SANDBOX_ALLOWED_TOOLS


@pytest.mark.parametrize("mode", ["sequential", "concurrent"])
def test_continuing_session_drops_a_saved_tool_the_profile_no_longer_offers(mode, browser_handler):
    """The DGX-791 incident. The session row pinned ``tool_names`` while the profile still had
    ``browser``; the profile lost it, and the tools freeze (``restore_agent_tool_prefix`` on a
    continuing session) restored ``browser_exec`` into tools[] and valid_tool_names, so the turn
    loop let the model call it. Now the restore drops it and the call is refused."""
    from tools.mcp_tool_agent import restore_agent_tool_prefix

    saved = ["browser_exec", "browser_vault_list", "web_search", "memory"]
    agent = _agent("web_search", "memory", "todo_list")  # what the profile offers today

    restore_agent_tool_prefix(agent, saved)

    assert [t["function"]["name"] for t in agent.tools] == ["web_search", "memory", "todo_list"]
    assert not {"browser_exec", "browser_vault_list"} & agent.valid_tool_names
    results = _run(agent, mode, _call("browser_exec", {"code": "print(1)"}, "c1"))
    browser_handler.assert_not_called()
    assert "'browser_exec' is not available in this session" in results[0]["content"]
