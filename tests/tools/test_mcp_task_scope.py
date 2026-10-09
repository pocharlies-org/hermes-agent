"""session_scope: "task" — una conexión MCP por tarea, no por servidor.

Sin la comprobación de ``session_scope`` en ``_task_server``, el test de «sin session_scope»
y el de «dos tareas» fallan: el servidor compartido se devolvería para todo.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from tools import mcp_tool_handlers as h

_REAL_CHILD_CLASS = h._task_session_class  # antes del fixture, que lo sustituye


class FakeChild:
    def __init__(self, name):
        self.name = name
        self.started_with = None
        self.closed = False

    async def start(self, config):
        self.started_with = config

    async def shutdown(self):
        self.closed = True


def _run_sync(factory, timeout=30):
    """Stand-in for the MCP loop: run the factory's coroutine to completion here."""
    r = factory()
    return asyncio.run(r) if asyncio.iscoroutine(r) else r


@pytest.fixture(autouse=True)
def _fakes(monkeypatch):
    monkeypatch.setattr(h, "_task_session_class", lambda: FakeChild)
    monkeypatch.setattr(h._loop, "_run_on_mcp_loop", _run_sync)
    h._task_sessions.clear()
    yield
    h._task_sessions.clear()


def _parent(scope="task"):
    cfg = {"url": "http://x"} if scope is None else {"url": "http://x", "session_scope": scope}
    return SimpleNamespace(name="playwright", _config=cfg)


def test_dos_task_id_dan_dos_hijos_y_el_mismo_da_el_mismo():
    parent = _parent()
    a = h._task_server(parent, "t-a")
    b = h._task_server(parent, "t-b")
    again = h._task_server(parent, "t-a")
    assert a is not b
    assert again is a
    assert a is not parent and a.started_with == parent._config


def test_sin_session_scope_o_sin_task_id_vuelve_al_servidor_de_siempre():
    sin_scope = _parent(scope=None)
    assert h._task_server(sin_scope, "t-a") is sin_scope
    con_scope = _parent()
    assert h._task_server(con_scope, None) is con_scope
    assert h._task_sessions == {}


def test_el_barrido_cierra_el_hijo_inactivo(monkeypatch):
    parent = _parent()
    clock = [1000.0]
    monkeypatch.setattr(h.time, "monotonic", lambda: clock[0])
    idle = h._task_server(parent, "t-idle")
    clock[0] += h._TASK_IDLE_S + 1
    h._task_server(parent, "t-nuevo")
    assert idle.closed
    assert len(h._task_sessions) == 1


def test_el_tope_expulsa_al_mas_antiguo(monkeypatch):
    parent = _parent()
    clock = [0.0]
    monkeypatch.setattr(h.time, "monotonic", lambda: clock[0])
    hijos = []
    for i in range(h._TASK_MAX):
        clock[0] += 1
        hijos.append(h._task_server(parent, f"t-{i}"))
    clock[0] += 1
    h._task_server(parent, "t-extra")
    assert hijos[0].closed
    assert not any(c.closed for c in hijos[1:])
    assert len(h._task_sessions) == h._TASK_MAX


def test_el_hijo_no_redescubre_herramientas():
    cls = _REAL_CHILD_CLASS()
    assert cls.__mro__[1].__name__ == "MCPServerTask"
    assert asyncio.run(cls("x")._discover_tools()) is None


# --- cableado: _make_tool_handler -> _task_server -> _dispatch -------------

SERVER_NAME = "pw-task-scope-test"  # propio: el _strike del test no toca el cortacircuitos de otros


@pytest.fixture
def handler_env(monkeypatch):
    parent = _parent()
    seen = []
    monkeypatch.setattr(h, "_trust_gate_check", lambda *a, **k: None)
    monkeypatch.setattr(h, "_check_circuit_breaker", lambda *a, **k: None)
    monkeypatch.setattr(h, "_acquire_call_server", lambda *a, **k: (parent, None))
    monkeypatch.setattr(h, "_dispatch", lambda name, server, *a, **k: seen.append(server) or "{}")
    yield parent, seen, h._make_tool_handler(SERVER_NAME, "browser_navigate", 30)
    h._core._reset_server_error(SERVER_NAME)


def test_el_handler_con_task_id_corre_en_el_hijo_y_sin_task_id_en_el_padre(handler_env):
    parent, seen, handler = handler_env
    handler({}, task_id="t-a")
    handler({}, task_id=None)
    assert seen[0] is not parent and seen[0].started_with == parent._config
    assert seen[1] is parent


def test_si_task_server_lanza_el_handler_falla_cerrado(handler_env, monkeypatch):
    parent, seen, handler = handler_env

    def boom(server, task_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(h, "_task_server", boom)
    out = json.loads(handler({}, task_id="t-a"))
    assert "error" in out and "boom" in out["error"]
    assert seen == []  # nunca cae al servidor compartido


def test_un_hijo_cuyo_shutdown_lanza_no_impide_devolver_el_nuevo(monkeypatch, caplog):
    parent = _parent()
    clock = [1000.0]
    monkeypatch.setattr(h.time, "monotonic", lambda: clock[0])
    viejo = h._task_server(parent, "t-viejo")

    async def shutdown_roto():
        raise RuntimeError("cierre colgado")

    viejo.shutdown = shutdown_roto
    clock[0] += h._TASK_IDLE_S + 1
    with caplog.at_level("WARNING", logger="tools.mcp_tool"):
        nuevo = h._task_server(parent, "t-nuevo")
    assert nuevo is not viejo and nuevo.started_with == parent._config
    assert list(h._task_sessions) == [(id(parent), "t-nuevo")]
    assert "closing a task connection failed" in caplog.text
