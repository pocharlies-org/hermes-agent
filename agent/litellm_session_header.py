"""``x-litellm-session-id`` — the Hermes session behind each LiteLLM request (DGX-578).

LiteLLM turns this header into the request's ``litellm_trace_id``, which is what its
in-flight tracker and SpendLogs carry as ``trace_id``. Without it a Hermes request
only says its profile (the static ``x-hermes-profile``), so the dashboard could not
tell which of the profile's sessions launched it. With it, the panel resolves the
session's title and opens that exact conversation in its Despacho.

The value is the agent's physical ``session_id``: after a compression the agent
moves to the new tip, and the tip is the id the session listing (and so the
Despacho) shows. Only LiteLLM targets get it; other providers are left untouched.
"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlsplit

LITELLM_SESSION_HEADER = "x-litellm-session-id"


def is_litellm_target(base_url: Optional[str]) -> bool:
    """True when *base_url* points at a LiteLLM proxy (``litellm*`` host)."""
    try:
        host = (urlsplit(str(base_url or "")).hostname or "").lower()
    except ValueError:
        return False
    return host.startswith("litellm")


def merge_litellm_session_header(
    kwargs: dict[str, Any],
    base_url: Optional[str],
    session_id: Optional[str],
) -> dict[str, Any]:
    """Merge ``x-litellm-session-id`` into ``kwargs["extra_headers"]`` (in place).

    A caller-pinned value wins. No-op without a session id or for non-LiteLLM targets.
    """
    sid = str(session_id or "").strip()
    if not sid or not is_litellm_target(base_url):
        return kwargs
    existing = kwargs.get("extra_headers")
    merged = dict(existing) if isinstance(existing, dict) else {}
    merged.setdefault(LITELLM_SESSION_HEADER, sid)
    kwargs["extra_headers"] = merged
    return kwargs
