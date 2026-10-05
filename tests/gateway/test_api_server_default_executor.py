"""DGX-586: agent turns must not starve the loop's default executor."""

import asyncio
import concurrent.futures
from types import SimpleNamespace

from gateway.platforms.api_server import APIServerAdapter


def _adapter(cap):
    return SimpleNamespace(_max_concurrent_runs=cap, name="api_server",
                           _EXECUTOR_HEADROOM=APIServerAdapter._EXECUTOR_HEADROOM)


def _size_after(cap, env=None, monkeypatch=None, preset=None):
    if monkeypatch is not None:
        if env is None:
            monkeypatch.delenv("HERMES_EXECUTOR_WORKERS", raising=False)
        else:
            monkeypatch.setenv("HERMES_EXECUTOR_WORKERS", env)

    async def run():
        loop = asyncio.get_running_loop()
        if preset:
            loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=preset))
        APIServerAdapter._ensure_default_executor_capacity(_adapter(cap))
        return loop._default_executor._max_workers

    return asyncio.run(run())


def test_pool_is_sized_over_the_run_cap(monkeypatch):
    assert _size_after(200, monkeypatch=monkeypatch) == 200 + APIServerAdapter._EXECUTOR_HEADROOM


def test_uncapped_gateway_still_gets_a_large_pool(monkeypatch):
    assert _size_after(0, monkeypatch=monkeypatch) == 200 + APIServerAdapter._EXECUTOR_HEADROOM


def test_env_override(monkeypatch):
    assert _size_after(200, env="40", monkeypatch=monkeypatch) == 40


def test_never_shrinks_a_bigger_pool(monkeypatch):
    assert _size_after(10, monkeypatch=monkeypatch, preset=500) == 500


def test_short_reads_are_served_while_the_cap_is_busy(monkeypatch):
    """12 blocking 'turns' (the stock pool size on 8 cores) plus a to_thread read: the read
    must not wait for the turns once the pool is sized."""
    monkeypatch.delenv("HERMES_EXECUTOR_WORKERS", raising=False)
    import threading
    import time

    release = threading.Event()

    async def run():
        APIServerAdapter._ensure_default_executor_capacity(_adapter(200))
        loop = asyncio.get_running_loop()
        turns = [loop.run_in_executor(None, release.wait) for _ in range(40)]
        t0 = time.monotonic()
        await asyncio.wait_for(asyncio.to_thread(lambda: "ok"), timeout=2)
        elapsed = time.monotonic() - t0
        release.set()
        await asyncio.gather(*turns)
        return elapsed

    assert asyncio.run(run()) < 1.0
