"""Recover heartbeat watches from the gateway's canonical persisted routing index."""
from __future__ import annotations

import logging

logger = logging.getLogger("gateway.run")


async def restore_heartbeat_watches(runner) -> None:
    """Retryable startup/poll scan; failed reads never prune existing watches.

    SessionStore owns one routing index across profiles. Its origin and exact key,
    rather than a second heartbeat routing snapshot, also cover pre-upgrade state.
    Run all storage work off-loop so a cold profile DB cannot block adapters.
    """
    from gateway.run import _profile_runtime_scope
    from hermes_cli.heartbeat import HeartbeatManager
    from hermes_cli.profiles import profile_exists
    from hermes_constants import get_hermes_home

    store = runner.session_store

    def scan():
        restored = []
        # The poller may have been spawned by a named profile's /heartbeat command.
        # Anchor even default origins to the gateway home, not inherited context.
        home = getattr(store, "_routing_home", None) or get_hermes_home()
        alive: dict = {}
        with _profile_runtime_scope(home):
            entries = store.list_sessions()
            for entry in entries:
                if entry.origin is None or not entry.session_id or entry.suspended:
                    continue
                # A retired profile's entries can't hold a heartbeat: skip them before opening a
                # profile scope (each open resolves, warns and re-reads config, every poll).
                parts = (entry.session_key or "").split(":")
                if len(parts) >= 3 and parts[0] == "agent" and parts[1] not in ("main", "default"):
                    if parts[1] not in alive:
                        try:
                            alive[parts[1]] = bool(profile_exists(parts[1]))
                        except Exception:
                            alive[parts[1]] = True
                    if not alive[parts[1]]:
                        continue
                try:
                    with runner._profile_scope_for_source(entry.origin):
                        manager = HeartbeatManager(entry.session_id)
                        if manager.is_active():
                            restored.append((entry.session_key, entry.origin, entry.session_id))
                except Exception:
                    logger.debug("heartbeat restore for %s failed", entry.session_key, exc_info=True)
        return restored

    try:
        candidates = await runner._run_in_executor_with_context(scan)
        for key, source, session_id in candidates:
            # A reset/compression may have published a new owner during the executor hop.
            if store.peek_session_id(key) == session_id:
                runner._register_heartbeat_watch(key, source, session_id)
    except Exception:
        logger.debug("heartbeat restore scan failed; retrying on next poll", exc_info=True)
