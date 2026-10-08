"""session_scope: "task" — una conexión MCP por tarea, no por servidor.

Sin la comprobación de ``session_scope`` en ``_task_server``, el test de «sin session_scope»
y el de «dos tareas» fallan: el servidor compartido se devolvería para todo.
"""
import asyncio
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
