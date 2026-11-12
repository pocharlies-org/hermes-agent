"""Tests for the durable webhook inbox (gateway/webhook_inbox.py, SC-5381).

The contract: a turn accepted with a 202 is written before the response, the dedup answers across
boots, a dead owner's unfinished turn is replayed once per boot with a visible marker, a live owner's
row is never touched, and the attempts cap / stale cutoff end in 'abandoned' instead of looping.
"""

import asyncio
import os
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway import webhook_inbox as wi
from gateway.config import PlatformConfig
from gateway.platforms.webhook import WebhookAdapter, _WebhookDeliveryIdentity


@pytest.fixture(autouse=True)
def _fresh_db(tmp_path, monkeypatch):
    """Isolated state.db per test. The module holds its own reference to _db_path (imported from the
    reply ledger), so patch it HERE — patching delivery_ledger._db_path would not redirect this one."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(wi, "_db_path", lambda: home / "state.db")
    yield


def _record(inbox_id="in-1", profile="default", route="gmail", delivery_id="d-1", **kw):
    wi.record(inbox_id=inbox_id, profile=profile, route=route, delivery_id=delivery_id,
              prompt=kw.get("prompt", "atiende este correo"), payload=kw.get("payload", '{"a":1}'),
              event_type=kw.get("event_type", "mail"), session_key=kw.get("session_key", "agent:main:webhook:x"))


def _row(inbox_id="in-1"):
    with wi._connect() as conn:
        r = conn.execute("SELECT * FROM webhook_inbox WHERE inbox_id = ?", (inbox_id,)).fetchone()
    return None if r is None else dict(r)


def _kill_owner(inbox_id="in-1"):
    """Un dueño muerto de verdad: pid inexistente, sin start time que comparar."""
    with wi._connect() as conn:
        conn.execute("UPDATE webhook_inbox SET owner_pid = 2147483646, owner_started_at = NULL WHERE inbox_id = ?",
                     (inbox_id,))


def _make_adapter(routes=None) -> WebhookAdapter:
    config = PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": 0,
                                                "routes": routes if routes is not None else {"gmail": {"secret": "s"}}})
    adapter = WebhookAdapter(config)
    adapter.handle_message = AsyncMock()
    return adapter


# --- módulo: dedup, estados, reclamación ---

def test_el_dedup_contesta_desde_la_tabla_no_desde_la_memoria():
    _record()
    assert wi.seen("in-1", 3600) is True
    assert wi.seen("in-1", 3600, now=time.time() + 3601) is False   # pasado el TTL vuelve a aceptarse
    assert wi.seen("no-existe", 3600) is False


def test_un_turno_aceptado_queda_running_y_lo_reclama_el_siguiente_arranque():
    _record()
    assert _row()["state"] == "running"
    _kill_owner()
    claimed = wi.sweep_recoverable()
    assert [r["inbox_id"] for r in claimed] == ["in-1"]
    assert claimed[0]["attempts"] == 1 and claimed[0]["prompt"] == "atiende este correo"
    assert _row()["state"] == "running" and _row()["owner_pid"] == os.getpid()


def test_lo_de_un_proceso_vivo_no_se_reclama():
    _record()                                                     # owner = este proceso, vivo
    assert wi.sweep_recoverable() == []


def test_done_no_se_reclama_y_failed_si():
    _record(inbox_id="hecho")
    wi.mark_done("hecho")
    _record(inbox_id="roto")
    wi.mark_failed("roto", "RuntimeError('x')")
    _kill_owner("hecho")
    _kill_owner("roto")
    assert [r["inbox_id"] for r in wi.sweep_recoverable()] == ["roto"]
    assert _row("hecho")["state"] == "done"


def test_el_tope_de_intentos_y_la_vejez_acaban_en_abandoned():
    _record(inbox_id="agotado")
    _kill_owner("agotado")
    with wi._connect() as conn:
        conn.execute("UPDATE webhook_inbox SET attempts = ? WHERE inbox_id = 'agotado'", (wi.MAX_ATTEMPTS,))
    _record(inbox_id="viejo")
    _kill_owner("viejo")
    with wi._connect() as conn:
        conn.execute("UPDATE webhook_inbox SET created_at = ? WHERE inbox_id = 'viejo'",
                     (time.time() - wi.STALE_AFTER_SECONDS - 1,))
    assert wi.sweep_recoverable() == []
    assert _row("agotado")["state"] == "abandoned" and _row("viejo")["state"] == "abandoned"


def test_solo_se_reclama_lo_de_los_perfiles_que_este_arranque_sirve():
    _record(inbox_id="mio", profile="secretaria")
    _record(inbox_id="ajeno", profile="otra")
    _kill_owner("mio")
    _kill_owner("ajeno")
    assert [r["inbox_id"] for r in wi.sweep_recoverable(profiles={"secretaria"})] == ["mio"]
    assert _row("ajeno")["attempts"] == 0                          # intacto para el arranque que lo sirve


def test_el_replay_no_reinicia_los_intentos_ni_el_reloj():
    """Sin esto cada arranque volvería a attempts=0 y el turno se reintentaría para siempre."""
    _record()
    primero = _row()["created_at"]
    _kill_owner()
    wi.sweep_recoverable()
    wi.record(inbox_id="in-1", profile="default", route="gmail", delivery_id="d-1", prompt="otra vez")
    assert _row()["attempts"] == 1 and _row()["created_at"] == primero
    wi.mark_done("in-1")
    wi.record(inbox_id="in-1", profile="default", route="gmail", delivery_id="d-1", prompt="nueva entrega")
    assert _row()["attempts"] == 0                                 # una entrega nueva sí empieza limpia


def test_la_retencion_poda_los_terminales_viejos():
    _record()
    wi.mark_done("in-1")
    with wi._connect() as conn:
        conn.execute("UPDATE webhook_inbox SET updated_at = ?", (time.time() - wi._RETENTION_SECONDS - 1,))
    _record(inbox_id="in-2")                                       # record poda en su transacción
    assert _row("in-1") is None and _row("in-2") is not None


# --- adaptador: los tres puntos de toque ---

def test_identidad_v2_ida_y_vuelta():
    ident = _WebhookDeliveryIdentity.from_parts("secretaria", "gmail/correo", "d:1")
    assert _WebhookDeliveryIdentity.from_session_chat_id(ident.session_chat_id) == ident
    for basura in ("webhook:gmail-es:gmail:cuenta:1", "webhook:v2:no-es-base64", "webhook:v2:", "", None):
        assert _WebhookDeliveryIdentity.from_session_chat_id(basura) is None


@pytest.mark.asyncio
async def test_el_turno_se_escribe_antes_del_202():
    adapter = _make_adapter()
    request = MagicMock(method="POST")
    respuesta = adapter._dispatch_agent_run(request, adapter._routes["gmail"], "gmail", None, {"a": 1},
                                            "atiende", "mail", "d-1", time.time())
    assert respuesta.status == 202
    fila = _row(wi.compute_inbox_id("default", "gmail", "d-1"))
    assert fila is not None and fila["state"] == "running" and fila["prompt"] == "atiende"
    await asyncio.sleep(0)


def test_el_dedup_durable_frena_un_reintento_tras_el_reinicio():
    _record(inbox_id=wi.compute_inbox_id("default", "gmail", "d-1"))
    adapter = _make_adapter()                                      # proceso "nuevo": dict vacío
    ident = _WebhookDeliveryIdentity.from_parts(None, "gmail", "d-1")
    assert adapter._record_delivery_id(ident, time.time()) is False


@pytest.mark.asyncio
async def test_el_fin_del_turno_marca_done():
    adapter = _make_adapter()
    adapter._dispatch_agent_run(MagicMock(method="POST"), adapter._routes["gmail"], "gmail", None, {},
                                "atiende", "mail", "d-1", time.time())
    await asyncio.sleep(0)
    inbox_id = wi.compute_inbox_id("default", "gmail", "d-1")
    evento = MagicMock()
    evento.source.chat_id = _WebhookDeliveryIdentity.from_parts(None, "gmail", "d-1").session_chat_id
    await adapter.on_processing_complete(evento, None)
    assert _row(inbox_id)["state"] == "done"


@pytest.mark.asyncio
async def test_resume_inbox_relanza_con_marca_y_no_resucita_una_ruta_que_ya_no_existe():
    adapter = _make_adapter()
    _record(inbox_id=wi.compute_inbox_id("default", "gmail", "d-1"), delivery_id="d-1")
    _record(inbox_id=wi.compute_inbox_id("default", "borrada", "d-2"), route="borrada", delivery_id="d-2")
    for inbox_id in (wi.compute_inbox_id("default", "gmail", "d-1"), wi.compute_inbox_id("default", "borrada", "d-2")):
        _kill_owner(inbox_id)
    filas = wi.sweep_recoverable()
    assert adapter.resume_inbox(filas) == 1
    await asyncio.sleep(0)
    assert adapter.handle_message.await_count == 1
    evento = adapter.handle_message.await_args.args[0]
    assert evento.text.startswith(wi.RECOVERED_MARKER) and evento.message_id == "d-1"
    assert evento.raw_message == {"a": 1}
    assert _row(wi.compute_inbox_id("default", "borrada", "d-2"))["state"] == "failed"
