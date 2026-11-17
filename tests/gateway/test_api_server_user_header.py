"""X-Hermes-User (DGX-1621): an authenticated client asserts the turn's end-user.

The header binds ``HERMES_SESSION_USER_ID`` only on a request whose Bearer matched the
profile's API_SERVER_KEY: no key configured, a wrong Bearer or no header leave it empty
(the 401 arrives before any bind). The value is sanitized with ``agent.turn_author._clean_text``.
It is its own contract — not the ``author`` body field, which only labels memory.
"""

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import (
    APIServerAdapter,
    _api_request_user_id,
    _STATIC_FEATURE_FLAGS,
    cors_middleware,
    security_headers_middleware,
)

_KEY = "sk-user-header-test-key"


def _make_adapter(api_key: str = "") -> APIServerAdapter:
    extra = {}
    if api_key:
        extra["key"] = api_key
    return APIServerAdapter(PlatformConfig(enabled=True, extra=extra))


def _create_app(adapter: APIServerAdapter) -> web.Application:
    mws = [mw for mw in (cors_middleware, security_headers_middleware) if mw is not None]
    app = web.Application(middlewares=mws)
    app["api_server_adapter"] = adapter
    app.router.add_post("/v1/chat/completions", adapter._handle_chat_completions)
    app.router.add_post("/v1/runs", adapter._handle_runs)
    app.router.add_get("/v1/runs/{run_id}", adapter._handle_get_run)
    return app


def _capturing_agent(captured: dict) -> MagicMock:
    agent = MagicMock()

    def _capture_run(user_message=None, conversation_history=None, task_id=None, **_kw):
        from gateway.session_context import get_session_env

        captured["user_id"] = get_session_env("HERMES_SESSION_USER_ID", "<unset>")
        captured["platform"] = get_session_env("HERMES_SESSION_PLATFORM", "<unset>")
        return {"final_response": "ok", "messages": [], "api_calls": 1}

    agent.run_conversation.side_effect = _capture_run
    agent.session_prompt_tokens = 0
    agent.session_completion_tokens = 0
    agent.session_total_tokens = 0
    return agent


async def _post_chat(adapter: APIServerAdapter, headers: dict) -> tuple:
    app = _create_app(adapter)
    captured: dict = {}
    with patch.object(adapter, "_create_agent", return_value=_capturing_agent(captured)):
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/v1/chat/completions",
                json={"messages": [{"role": "user", "content": "hola"}]},
                headers=headers,
            )
    return resp, captured


class TestUserHeaderBindsTurnIdentity:
    @pytest.mark.asyncio
    async def test_valid_bearer_with_header_binds_user_id(self):
        resp, captured = await _post_chat(
            _make_adapter(api_key=_KEY),
            {"Authorization": f"Bearer {_KEY}", "X-Hermes-User": "me@e-dani.com"},
        )
        assert resp.status == 200, await resp.text()
        assert captured.get("user_id") == "me@e-dani.com"
        assert captured.get("platform") == "api_server"

    @pytest.mark.asyncio
    async def test_valid_bearer_without_header_binds_empty(self):
        resp, captured = await _post_chat(
            _make_adapter(api_key=_KEY), {"Authorization": f"Bearer {_KEY}"}
        )
        assert resp.status == 200, await resp.text()
        assert captured.get("user_id") == ""

    @pytest.mark.asyncio
    async def test_invalid_bearer_is_401_and_binds_nothing(self):
        resp, captured = await _post_chat(
            _make_adapter(api_key=_KEY),
            {"Authorization": "Bearer not-the-key", "X-Hermes-User": "me@e-dani.com"},
        )
        assert resp.status == 401
        assert captured == {}, "the turn must not start, so nothing is bound"

    @pytest.mark.asyncio
    async def test_no_key_listener_does_not_bind_asserted_user(self):
        """The no-key default listener answers without a Bearer; an asserted header rides
        nothing there — only a validated Bearer binds (DGX-1621)."""
        resp, captured = await _post_chat(
            _make_adapter(), {"X-Hermes-User": "me@e-dani.com"}
        )
        assert resp.status == 200, await resp.text()
        assert captured.get("user_id") == ""

    @pytest.mark.asyncio
    async def test_runs_route_binds_asserted_user(self):
        """/v1/runs owns its agent lifecycle (no _run_agent): the launch carries the same
        asserted identity to its own _bind_api_server_session call."""
        adapter = _make_adapter(api_key=_KEY)
        app = _create_app(adapter)
        captured: dict = {}
        auth = {"Authorization": f"Bearer {_KEY}"}
        with patch.object(adapter, "_create_agent", return_value=_capturing_agent(captured)):
            async with TestClient(TestServer(app)) as cli:
                resp = await cli.post(
                    "/v1/runs",
                    json={"input": "hola", "session_id": "runs-user-sid"},
                    headers={**auth, "X-Hermes-User": "me@e-dani.com"},
                )
                assert resp.status == 202, await resp.text()
                run_id = (await resp.json())["run_id"]
                status = {}
                for _ in range(40):
                    status = await (await cli.get(f"/v1/runs/{run_id}", headers=auth)).json()
                    if status.get("status") in ("completed", "failed"):
                        break
                    await asyncio.sleep(0.05)
        assert status.get("status") == "completed", status
        assert captured.get("user_id") == "me@e-dani.com"


class TestUserHeaderSanitized:
    def test_control_chars_and_length_cleaned_by_turn_author(self):
        """Server-side sanitizer is agent.turn_author._clean_text (control chars dropped,
        capped at 200) — an HTTP client may refuse control chars, so this is the unit seam."""
        adapter = _make_adapter(api_key=_KEY)
        request = MagicMock()
        request.headers = {
            "Authorization": f"Bearer {_KEY}",
            "X-Hermes-User": "me\x01@e-dani.com",
        }
        assert adapter._check_auth(request) is None
        assert _api_request_user_id.get() == "me@e-dani.com"

        request.headers = {"Authorization": f"Bearer {_KEY}", "X-Hermes-User": "u" * 500}
        assert adapter._check_auth(request) is None
        assert _api_request_user_id.get() == "u" * 200

    def test_bad_bearer_leaves_context_var_empty(self):
        _api_request_user_id.set("")  # sync tests share the thread context; start clean
        adapter = _make_adapter(api_key=_KEY)
        request = MagicMock()
        request.headers = {
            "Authorization": "Bearer nope",
            "X-Hermes-User": "me@e-dani.com",
        }
        assert adapter._check_auth(request) is not None
        assert _api_request_user_id.get() == ""


def test_user_header_advertised_as_contract():
    """The header name is a contract next to X-Hermes-Session-Id/Key (COMPAT_MANIFEST.md)."""
    assert _STATIC_FEATURE_FLAGS["user_identity_header"] == "X-Hermes-User"
