"""SC-2147: the CONFIRMAR_* payment-confirmation secrets must never reach a
spawned child through the terminal scrub surfaces.

qa measured (70-qa.md, session 13bbf65a) that on the live gateway pod a process
with the gateway's uid could read the payment Jira token from a terminal child's
environment: ``_sanitize_subprocess_env`` and ``_make_run_env`` both let
``CONFIRMAR_PAGO_JIRA_TOKEN`` through (plugin_strip was empty and no CONFIRMAR_*
name was in ``_ALWAYS_STRIP_KEYS``). The HMAC signing keys share the same
injection path, so all three names are Tier-1 and are asserted here INJECTED —
they are absent from the real gateway env, so an assert-only-without-injection
test would pass in vacuity.
"""

import os
import sys

import pytest

from tools.environments.local import _make_run_env, _sanitize_subprocess_env
from tools.environments.local_env_policy import _ALWAYS_STRIP_KEYS

_CONFIRMAR_NAMES = (
    "CONFIRMAR_PAGO_JIRA_TOKEN",
    "CONFIRMAR_PAGO_HMAC_SECRET",
    "CONFIRMAR_PAGO_HMAC_DECISION_SECRET",
)


def test_confirmar_names_are_tier1():
    assert set(_CONFIRMAR_NAMES) <= set(_ALWAYS_STRIP_KEYS)


@pytest.mark.parametrize("name", _CONFIRMAR_NAMES)
def test_sanitize_subprocess_env_strips_injected_name(monkeypatch, name):
    monkeypatch.setenv(name, "s3cr3t")
    assert name not in _sanitize_subprocess_env(os.environ.copy())
    # also via extra_env (the force-unwrap part of the scrub)
    assert name not in _sanitize_subprocess_env({}, {name: "s3cr3t"})


@pytest.mark.parametrize("name", _CONFIRMAR_NAMES)
def test_make_run_env_strips_injected_name(monkeypatch, name):
    monkeypatch.setenv(name, "s3cr3t")
    assert name not in _make_run_env({"PATH": "/usr/bin:/bin"})
    # the backend's own env dict is the other injection vector
    assert name not in _make_run_env({"PATH": "/usr/bin:/bin", name: "s3cr3t"})


def test_force_prefix_does_not_reopen_tier1(monkeypatch):
    """``_HERMES_FORCE_<NAME>`` forces blocklisted names through; Tier-1 stays
    sealed, matching the non-terminal surface's treatment of internal secrets."""
    for name in _CONFIRMAR_NAMES:
        assert name not in _sanitize_subprocess_env({}, {f"_HERMES_FORCE_{name}": "x"})


def test_make_run_env_applies_plugin_strip_keys(monkeypatch):
    """The frozenset() passed by _make_run_env was a hole: plugin-registered
    terminal-backend strip keys never reached the terminal env (SC-2147)."""
    monkeypatch.setattr(
        "tools.environments.local._plugin_terminal_env_strip_keys",
        lambda: frozenset({"PLUGIN_BACKEND_TOKEN"}),
    )
    assert "PLUGIN_BACKEND_TOKEN" not in _make_run_env(
        {"PATH": "/usr/bin:/bin", "PLUGIN_BACKEND_TOKEN": "tok"})


_PROBE_SRC = (
    "import os,sys\n"
    "try:\n"
    "    open(f'/proc/{os.getppid()}/environ','rb').read()\n"
    "except PermissionError:\n"
    "    sys.exit(69)\n"
)


def _probe_same_uid_read() -> int:
    import subprocess
    return subprocess.run([sys.executable, "-I", "-c", _PROBE_SRC],
                          capture_output=True, timeout=30).returncode


@pytest.mark.skipif(sys.platform != "linux", reason="prctl is Linux-only")
def test_make_process_non_dumpable_blocks_same_uid_environ_read():
    """The live-pod attack (SC-2147): a same-uid child reads the gateway's
    /proc/<pid>/environ. Non-dumpable must turn that into EACCES — and the probe
    must succeed again once dumpable is restored, proving the flag (not some
    kernel policy) is what blocked it."""
    import ctypes

    from hermes_proc_hardening import PR_SET_DUMPABLE, make_process_non_dumpable

    if not make_process_non_dumpable():
        pytest.skip("kernel refused PR_SET_DUMPABLE=0")
    try:
        # A non-dumpable process's /proc files are root-owned.
        assert os.stat("/proc/self/environ").st_uid == 0
        assert _probe_same_uid_read() == 69, "same-uid child still read environ"
    finally:
        ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 1, 0, 0, 0)
    assert _probe_same_uid_read() == 0, "probe failed after restoring dumpable"
