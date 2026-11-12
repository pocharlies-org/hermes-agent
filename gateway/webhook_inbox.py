"""Durable inbox for webhook agent turns (rows in the shared ``state.db``, same store and pid-liveness
as ``gateway.delivery_ledger``) so a restart between the 202 and the end of the run cannot lose the
turn silently. SC-5381: the mail case that woke a secretary profile used to vanish when the pod died
after accepting the POST — the delivery id lived only in an in-memory dict.

Checkpoints: record() 'running' BEFORE the 202 is written | mark_done() when the run truly ends
(``on_processing_complete``) | mark_failed() when the run task raises. Crash semantics: a 'running'
row whose owning process is gone never finished, so the turn is replayed with a visible recovered
marker (it may already have acted — at-least-once, like the ledger). 'failed' is a retry boundary and
is replayed too. Attempts are capped and stale rows expire, both -> 'abandoned' (kept briefly, then
pruned). The same table is the durable idempotency check: seen() answers across restarts, which the
in-memory dict cannot.

Only agent turns are ledgered here. cron_job, deliver_only and coalesced deliveries keep the in-memory
dedup: they are not turns, and replaying a cron trigger or a bare delivery is a different contract.

Everything is best-effort: inbox failures must never block a webhook, callers wrap every call in
try/except. Gated by ``gateway.webhook_inbox`` (default on).
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import threading
import time
from typing import Any, Optional

# Same store, same owner-liveness probe as the reply ledger: one shared state.db, one way to tell a
# dead pid from a recycled one. Reused instead of copied (gateway/delivery_ledger.py).
from gateway.delivery_ledger import _db_path, _owner_alive, _owner_stamp

logger = logging.getLogger(__name__)
_DB_LOCK = threading.Lock()

MAX_ATTEMPTS = 3
STALE_AFTER_SECONDS = 24 * 60 * 60
_RETENTION_SECONDS = 7 * 24 * 60 * 60
_MAX_ROWS = 500

RECOVERED_MARKER = ("♻️ Recovered webhook turn — the gateway restarted while this delivery was running, "
                    "so it may be a duplicate:\n\n")


def _connect() -> sqlite3.Connection:
    from hermes_cli.sqlite_util import open_db

    return open_db(_db_path(), db_label="state.db (webhook_inbox)", busy_timeout_ms=10_000,
                   row_factory=sqlite3.Row, initialize=_initialize_schema)


def _initialize_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS webhook_inbox (
            inbox_id TEXT PRIMARY KEY,
            profile TEXT NOT NULL,
            route TEXT NOT NULL,
            delivery_id TEXT NOT NULL,
            session_key TEXT,
            event_type TEXT,
            prompt TEXT NOT NULL,
            payload TEXT,
            state TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            owner_pid INTEGER,
            owner_started_at INTEGER,
            last_error TEXT
        )"""
    )


def _transaction():
    from hermes_cli.sqlite_util import transaction

    return transaction(_connect())


def compute_inbox_id(profile: str, route: str, delivery_id: str) -> str:
    """Same identity the in-memory dedup uses: one provider delivery on one route of one profile."""
    return hashlib.sha256(f"{profile}|{route}|{delivery_id}".encode("utf-8", "replace")).hexdigest()[:24]


def inbox_enabled(config: Optional[dict[str, Any]] = None) -> bool:
    """Read the ``gateway.webhook_inbox`` config gate (default on)."""
    try:
        if config is None:
            from hermes_cli.config import load_config
            config = load_config()
        value = (config.get("gateway") or {}).get("webhook_inbox", True)
        return value.strip().lower() not in {"false", "0", "no", "off"} if isinstance(value, str) else bool(value)
    except Exception:
        # Frontera deliberada: la config puede fallar de muchas formas (import, YAML, IO) y ninguna debe
        # apagar el inbox en silencio; se deja activo y la traza queda visible.
        logger.debug("[webhook-inbox] config gate unreadable, inbox left on", exc_info=True)
        return True


def seen(inbox_id: str, ttl: float, now: Optional[float] = None) -> bool:
    """True when this delivery was already accepted within *ttl* — the durable half of the dedup."""
    now = time.time() if now is None else now
    with _DB_LOCK, _transaction() as conn:
        row = conn.execute("SELECT created_at FROM webhook_inbox WHERE inbox_id = ?", (inbox_id,)).fetchone()
    return row is not None and now - row["created_at"] < ttl


def record(*, inbox_id: str, profile: str, route: str, delivery_id: str, prompt: str,
           payload: str = "", event_type: str = "", session_key: Optional[str] = None) -> None:
    """Record one accepted turn as running, BEFORE the 202 goes out. A replay of a row this boot already
    claimed keeps its attempts and its first-acceptance clock: the obligation belongs to the delivery,
    not to the spawn call, and resetting them would loop forever across boots."""
    now, (pid, started) = time.time(), _owner_stamp()
    with _DB_LOCK, _transaction() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO webhook_inbox
               (inbox_id, profile, route, delivery_id, session_key, event_type, prompt, payload,
                state, attempts, created_at, updated_at, owner_pid, owner_started_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running',
                       COALESCE((SELECT attempts FROM webhook_inbox
                                 WHERE inbox_id = ? AND state IN ('running', 'failed')), 0),
                       COALESCE((SELECT created_at FROM webhook_inbox
                                 WHERE inbox_id = ? AND state IN ('running', 'failed')), ?),
                       ?, ?, ?)""",
            (inbox_id, profile, route, delivery_id, session_key, event_type, prompt, payload,
             inbox_id, inbox_id, now, now, pid, started))
        _prune_unlocked(conn, now)


def mark_done(inbox_id: str) -> None:
    _update_state(inbox_id, "done")


def mark_failed(inbox_id: str, error: str = "") -> None:
    _update_state(inbox_id, "failed", error)


def _update_state(inbox_id: str, state: str, error: str = "") -> None:
    with _DB_LOCK, _transaction() as conn:
        conn.execute("UPDATE webhook_inbox SET state = ?, last_error = ?, updated_at = ? WHERE inbox_id = ?",
                     (state, error[:500], time.time(), inbox_id))


def sweep_recoverable(now: Optional[float] = None, *, profiles: Optional[set] = None) -> list[dict[str, Any]]:
    """Claim the turns a dead process left running (or failed), for the profiles served by this boot.
    Claiming spends one attempt; over the cap or stale -> 'abandoned'. Rows of a live owner are left
    alone: a reconnect is not a restart."""
    now = time.time() if now is None else now
    pid, started = _owner_stamp()
    claimed: list[dict[str, Any]] = []
    with _DB_LOCK, _transaction() as conn:
        for row in conn.execute("SELECT * FROM webhook_inbox WHERE state IN ('running', 'failed')").fetchall():
            d = dict(row)
            if profiles is not None and d["profile"] not in profiles:
                continue
            if _owner_alive(d["owner_pid"], d["owner_started_at"]):
                continue
            if d["attempts"] >= MAX_ATTEMPTS or now - d["created_at"] > STALE_AFTER_SECONDS:
                conn.execute("UPDATE webhook_inbox SET state = 'abandoned', updated_at = ? WHERE inbox_id = ?",
                             (now, d["inbox_id"]))
                logger.warning("[webhook-inbox] delivery %s on route %s abandoned after %d attempts",
                               d["delivery_id"], d["route"], d["attempts"])
                continue
            conn.execute(
                """UPDATE webhook_inbox SET state = 'running', attempts = attempts + 1,
                   owner_pid = ?, owner_started_at = ?, updated_at = ? WHERE inbox_id = ?""",
                (pid, started, now, d["inbox_id"]))
            d["attempts"] += 1
            claimed.append(d)
        _prune_unlocked(conn, now)
    return claimed


def _prune_unlocked(conn: sqlite3.Connection, now: float) -> None:
    """Retention DELETEs on the caller's open connection — inside the caller's transaction."""
    conn.execute("DELETE FROM webhook_inbox WHERE state IN ('done', 'abandoned') AND updated_at < ?",
                 (now - _RETENTION_SECONDS,))
    total = conn.execute("SELECT COUNT(*) FROM webhook_inbox").fetchone()[0]
    if total > _MAX_ROWS:
        conn.execute(
            """DELETE FROM webhook_inbox WHERE inbox_id IN (
                 SELECT inbox_id FROM webhook_inbox
                 ORDER BY CASE state WHEN 'done' THEN 0 WHEN 'abandoned' THEN 1 ELSE 2 END, updated_at ASC
                 LIMIT ?)""", (total - _MAX_ROWS,))
