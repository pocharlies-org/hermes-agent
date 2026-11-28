"""POST /v1/warm (DGX-1948): prefill the profile's model prefix without running a turn.

The route resolves the same model as the next real chat call and issues one max_tokens=1 completion on
the agent's own client, with the same system bytes (cached prompt + ephemeral system) and the same tools
(the chat template renders tools into the prompt). No session row, no turn, best-effort.
"""

import asyncio
import types

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware, security_headers_middleware


def _make_adapter() -> APIServerAdapter:
    return APIServerAdapter(PlatformConfig(enabled=True, extra={}))


class _FakeClient:
    def __init__(self):
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create))
        self.kw = None

    def _create(self, **kwargs):
        self.kw = kwargs


class _FakeAgent:
    ephemeral_system_prompt = "EPH"
    tools = [{"type": "function", "function": {"name": "t", "parameters": {}}}]
    model = "m-1"

    def __init__(self):
        self.client = _FakeClient()
        self.closed = False

    def _build_system_prompt(self, system_message=None):
        return "CACHED"

    def close(self):
        self.closed = True


def test_route_table_exposes_warm_for_every_profile():
    adapter = _make_adapter()
    posts = {path for method, path, _handler in adapter._http_route_table() if method == "POST"}
    assert "/v1/warm" in posts  # connect() mirrors it to /p/{profile}/v1/warm


def test_warm_issues_one_token_completion_with_same_prefix_and_tools():
    adapter = _make_adapter()
    agent = _FakeAgent()
    seen = {}
    tasks = []

    def fake_create(**kwargs):
        seen.update(kwargs)
        return agent

    adapter._create_agent = fake_create
    adapter._select_request_route = lambda body, **kw: (None, {}, None)
    adapter._track_background_task = lambda task, **kw: tasks.append(task)

    async def _run():
        app = web.Application(middlewares=[cors_middleware, security_headers_middleware])
        app.router.add_post("/v1/warm", adapter._handle_warm)
        async with TestClient(TestServer(app)) as c:
            r = await c.post("/v1/warm", json={"model": "jarvis",
                                               "messages": [{"role": "system", "content": "VOZ"}]})
            assert r.status == 202
            await asyncio.gather(*tasks)

    asyncio.run(_run())

    # the ephemeral system the frontend sends reaches the agent verbatim
    assert seen["ephemeral_system_prompt"] == "VOZ"
    assert seen["session_id"] is None and seen["gateway_session_key"] is None
    kw = agent.client.kw
    assert kw["max_tokens"] == 1 and kw["stream"] is False
    assert kw["model"] == agent.model
    assert kw["tools"] == agent.tools  # tools are part of the rendered prompt
    # cached prompt + ephemeral, appended exactly as turn_context does
    assert kw["messages"][0] == {"role": "system", "content": "CACHED\n\nEPH"}
    assert kw["messages"][1]["role"] == "user"
    assert agent.closed is True