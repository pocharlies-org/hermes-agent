"""DGX-1471 (barrier of the DGX-698 security verdict): the `alarma` plugin's
``ALARMA_HMAC_SECRET`` must never reach a spawned child through the terminal
scrub surfaces.

Measured on the live gateway pod (DGX-674 comments 47458/47464): a terminal
child kept the name — ``_make_run_env`` (foreground terminal) never consulted
``_ALWAYS_STRIP_KEYS`` and passed ``plugin_strip=frozenset()``, and
``_sanitize_subprocess_env`` let it through too. The name is Tier-1 and is
asserted here INJECTED — it is absent from the test env, so an assert-only
without injection would pass in vacuity.
"""

import os

import pytest

from tools.environments.local import _make_run_env, _sanitize_subprocess_env
from tools.environments.local_env_policy import _ALWAYS_STRIP_KEYS

_NAME = "ALARMA_HMAC_SECRET"


def test_alarma_hmac_name_is_tier1():
    assert _NAME in _ALWAYS_STRIP_KEYS


def test_sanitize_subprocess_env_strips_injected_name(monkeypatch):
    monkeypatch.setenv(_NAME, "s3cr3t")
    assert _NAME not in _sanitize_subprocess_env(dict(os.environ))
    # also via extra_env (the force-unwrap part of the scrub)
    assert _NAME not in _sanitize_subprocess_env({}, {_NAME: "s3cr3t"})


def test_make_run_env_strips_injected_name(monkeypatch):
    monkeypatch.setenv(_NAME, "s3cr3t")
    assert _NAME not in _make_run_env({})
    # the backend's own env dict is the other injection vector
    assert _NAME not in _make_run_env({_NAME: "s3cr3t"})


def test_force_prefix_does_not_reopen_tier1():
    """``_HERMES_FORCE_<NAME>`` forces blocklisted names through; Tier-1 stays
    sealed, matching the non-terminal surface's treatment of internal secrets."""
    assert _NAME not in _sanitize_subprocess_env({}, {f"_HERMES_FORCE_{_NAME}": "x"})
    assert _NAME not in _make_run_env({f"_HERMES_FORCE_{_NAME}": "x"})


def test_make_run_env_applies_plugin_strip_keys(monkeypatch):
    """The frozenset() passed by _make_run_env was a hole: plugin-registered
    terminal-backend strip keys never reached the terminal env (DGX-1471)."""
    monkeypatch.setattr(
        "tools.environments.local._plugin_terminal_env_strip_keys",
        lambda: frozenset({"PLUGIN_BACKEND_TOKEN"}),
    )
    assert "PLUGIN_BACKEND_TOKEN" not in _make_run_env({"PLUGIN_BACKEND_TOKEN": "tok"})
