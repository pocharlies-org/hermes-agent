# ARCHITECTURE — hermes-agent

Fork de [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (agente auto-mejorable
de Nous Research: CLI + gateway multiplataforma + API HTTP). La compañía lo ejecuta como runtime de los
perfiles Hermes (`cto`, `analista`, `sre-devops`, `security`, `hogar`, `skirmshop`, secretarias) en k3s.
Lo que se mantiene aquí es upstream; los cambios propios son overlays puntuales (los ficheros mínimos) sobre
commits del fork (ver §7 y los comentarios de `image:` en `values.yaml` del chart).

## 1. Clientes y versiones

| cliente | repositorio / ruta | versión desplegada | cómo se despliega |
|---|---|---|---|
| CLI `hermes` (TUI interactiva, `chat`, `cron`, `model`…) | este repo: `cli.py`, `hermes_cli/`, `run_agent.py` | la de la imagen del pod | imagen → chart `helm/hermes` (§7) |
| gateway (Telegram, Discord, Slack, WhatsApp, …) | `gateway/`, `plugins/platforms/` | idem | un solo proceso `hermes-gateway` por pod |
| API HTTP OpenAI-compat (`/v1/chat/completions`, `/v1/runs`, `/api/sessions`) | `gateway/platforms/api_server.py` | idem | la usa la compañía vía `company_encargos` (§«Sesiones por ticket») |
| Desktop (Electron) | `apps/desktop` | no desplegado por la compañía | — |

## 2. Dependencias, en ambos sentidos

- **Depende de**: Python ≥3.11,<3.14 (`pyproject.toml`, uv lockfile); SQLite (SessionDB, `hermes_state*.py`);
  proveedores LLM configurables por perfil (`config.yaml`).
- **Dependen de él**:
  - Chart `helm/hermes` de `pocharlies-org/k8s-openclaw-qwen36-pocharlies` (tronco `deploy/prod`): construye
    la imagen desde ramas del fork (hoy `deploy/v2026.9.14-reasoning-picker` + overlays, §7) y
    siembra perfiles, `config.yaml`, rutas de webhook y Secrets. Aplicación ArgoCD `hermes` (sync manual;
    despliega el workflow `hermes-despliegue.yml`).
  - `x86-host-runtime-pocharlies`: `company_encargos` / `vigilante` / `despertador` entregan turnos a los
    perfiles de compañía por la API del pod (`X-Hermes-Session-Key`, §«Sesiones por ticket»);
    `hermes_bridge` consume los eventos del gateway.
  - `k8s-litellm-pocharlies`: consume `x-litellm-session-id` (DGX-578). LiteLLM lo convierte en el `trace_id` de la
    petición y `session_router._session_id` lo usa como llave del sticky, del ledger KV y de la afinidad de cuenta
    de Alibaba.
  - `dgx-infra` (dashboard): lee ese `trace_id` en `/internal/active-requests` para enseñar y enlazar la sesión de
    Hermes que lanzó cada petición (DGX-578).

## 3. Stack

| pieza | versión | para qué | no se usa en su lugar |
|---|---|---|---|
| Python | 3.11–3.13 | runtime del agente y del gateway | — |
| SQLite (FTS5) | stdlib `sqlite3` | SessionDB: sesiones, mensajes, bindings de topics | ficheros JSON por sesión |
| pytest | `tests/` | tests del repo | — |
| Node/JS | `apps/desktop`, `*.mjs` | solo el desktop y tooling lint | — |

## 4. Componentes compartidos

| concepto | pieza canónica | ruta | quién la usa |
|---|---|---|---|
| SessionDB (sesiones, mensajes, búsqueda FTS5, auto-archivado) | `SessionDB` | `hermes_state.py` + mixins `hermes_state_*.py` | CLI, gateway, api_server |
| clave de sesión determinista | `build_session_key` | `gateway/session.py::build_session_key` | gateway (todas las plataformas) |
| binding topic de Telegram → sesión | tabla `telegram_dm_topic_bindings` `(profile_name, chat_id, thread_id) → session_key` | `hermes_state_telegram.py` | gateway/platforms/telegram |
| API HTTP con continuidad por clave | `APIServerAdapter`, header `X-Hermes-Session-Key` | `gateway/platforms/api_server.py::APIServerAdapter` | `company_encargos` de la compañía |
| cron propio | scheduler + `jobs.json` por perfil | `cron/jobs.py::JOBS_FILE` (`~/.hermes/profiles/<perfil>/cron/jobs.json`) | `hermes cron`, toolset `cronjob` |
| cabecera de sesión por petición a un proxy | `merge_litellm_session_header` (LiteLLM, `x-litellm-session-id`) y `merge_opencode_session_headers` (OpenCode, `x-opencode-session`) | `agent/litellm_session_header.py`, `agent/opencode_affinity.py`; las dos cableadas en `agent/chat_completion_helpers.py::build_api_kwargs` | todo turno del agente |
| supresión de toolsets | `agent.disabled_toolsets` (por turno, en el gateway) | `gateway/run_turn.py::_resolve_turn_toolsets`, entrada `"cronjob"` de `toolsets.py` | chart `helm/hermes` (`[cronjob]`) |

## 5. Cómo se construye aquí

Código upstream: no se reorganiza. `agent/` = runtime del agente; `gateway/` = proceso multiplexador de
plataformas (`gateway/run.py` registra adaptadores; `api_server` y `webhook` son no interactivos);
`plugins/platforms/<p>/` = adaptadores; `hermes_cli/` = CLI y config (`config_defaults.py`); `cron/` =
scheduler con entrega a cualquier plataforma; `hermes_state_*.py` = SessionDB particionado por mixins.
Los perfiles viven bajo `~/.hermes/profiles/<perfil>/` (config, skills, cron, sesiones) y el gateway
multiplexa varios en un proceso. Un overlay propio se ancla a un commit del fork y toca los ficheros mínimos,
listados en `docker/Dockerfile.overlay`; nunca una reescritura de módulo.

## 6. Tests y validaciones

```sh
python3 -m pytest tests/ -x -q          # suite Python (unit + integración sobre SessionDB y gateway)
node .github/scripts/run-workspace-checks.mjs   # checks JS (lo que lanza .github/workflows/js-tests.yml)
```

Los tests no lanzan cargas a los Sparks ni a Jira: todo contacto externo va por adaptadores parcheables.

## 7. CI/CD y despliegue

CI del fork: `ci.yaml`, `tests.yml`, `lint.yml`, `js-tests.yml`, `supply-chain-audit.yml`… (upstream).
El despliegue de la compañía **no** lee este repo directamente: ArgoCD app `hermes` lee
`k8s-openclaw-qwen36-pocharlies@deploy/prod` (chart `helm/hermes`), que fija la imagen desde una rama de
este fork con overlays y siembra la config por ConfigMap (recarga en caliente vía sidecar
`hermes-reseed`; reinicio solo con el workflow `hermes-despliegue.yml`). Validar producción:
`kubectl exec -n hermes deploy/hermes-gateway -c hermes -- hermes -p <perfil> sessions list` y el
`/health/detailed` del pod.

**Imagen overlay.** Un push a una rama `overlay/**` lanza `.github/workflows/hermes-overlay.yml`:
- corre en el runner `arc-k8s` con el BuildKit del clúster (`buildkitd-amd64.buildkit.svc.cluster.local:1234`);
- construye `docker/Dockerfile.overlay`: `ARG BASE` es el tag y el digest vivos del chart en el momento del pin y los `COPY` son los ficheros cambiados;
- sube el tag de `docker/overlay-tag` a `harbor.lan.e-dani.com/homelab/hermes-agent` con el robot de la org
  (`HARBOR_USER`/`HARBOR_PASSWORD`).

El pin en `helm/hermes/values.yaml` de k8s-openclaw-qwen36-pocharlies es una PR aparte, y el reinicio lo hace
`hermes-despliegue.yml`. Al cortar un overlay nuevo se cambian a la vez `ARG BASE`, los `COPY` y `overlay-tag` en el primer commit que se empuja.
El tag es mutable: un segundo push a la misma rama lo sobrescribe en Harbor, así que cada overlay lleva tag nuevo.

## 8. Decisiones y trampas

- `2026-09` · imagen desde rama del fork + overlays puntuales en vez de fork interno divergente · chart `values.yaml` `image:` (SC-710, DGX-366)
- `2026-10-02` · el enlace topic→ticket no vive en el runtime: Telegram liga la clave desde el texto del mensaje · SC-1436 (decisión del CTO)
- trampa: una sesión del api_server reanudada con modelo persistido re-resolvía el provider `custom` pelado → «No LLM provider configured» desde el 2.º turno · overlay `fix/api-server-named-provider-resume` (DGX-366)

- `2026-10-05` · el executor por defecto del loop se dimensiona a `max_concurrent_runs + 64`; `HERMES_EXECUTOR_WORKERS`
  lo fuerza y nunca encoge uno mayor · `api_server.py::APIServerAdapter._ensure_default_executor_capacity` (DGX-586).
  Trampa: los turnos del api_server (`api_server.py::_run_agent` y `api_server_runs.py`) y los `asyncio.to_thread`
  de la BD de sesiones comparten el executor por defecto. Con el pool de serie (`min(32, cpu+4)` = 12 hilos) y tope
  200, doce turnos lentos dejaban `GET /api/sessions` minutos en cola. Un executor propio para los turnos (patrón
  `GatewayRunner._get_executor`) es el seguimiento
- `2026-10-05` · cada petición a un host `litellm*` lleva `x-litellm-session-id` con el `session_id` físico del agente
  (la punta, el id que enseña el listado) · `agent/litellm_session_header.py` (DGX-578). Al desplegar, el sticky de
  `session_router` de Hermes pasa de `pfx-<hash>` a la sesión: las conversaciones vivas llegan frías una vez

### Sesiones por ticket (SC-1422)

Regla de la compañía: **cada conversación de un perfil de la compañía pertenece a un ticket de Jira**
(conversación `epica-<key>` por ticket y perfil). Este repo aporta las piezas por las que eso es
posible, y ninguna decide el enlace ticket↔sesión — eso lo decide `x86-host-runtime-pocharlies`
(ver su `ARCHITECTURE.md`, «Sesiones por ticket»). Las citas van por símbolo para que no se
pudran con el próximo rebase del fork:

- **API con clave declarada**: `gateway/platforms/api_server.py::APIServerAdapter` acepta el header
  `X-Hermes-Session-Key` (nombre publicitado en `/v1/capabilities` vía
  `api_server.py::_STATIC_FEATURE_FLAGS["session_key_header"]`) y reanuda la sesión viva de esa clave
  (`::APIServerAdapter._declared_conversation_session`), con `source="api_server"`.
  `company_encargos.enviar`/`turno` (x86-host-runtime-pocharlies `libexec/company_encargos.py`) lo
  usan para clavar el turno a `epica-<key>`.
- **Topics de Telegram → sesión**: el gateway enlaza cada topic de foro a una sesión
  (tabla `telegram_dm_topic_bindings`, clave `(profile_name, chat_id, thread_id)`, en
  `hermes_state_telegram.py`; clave determinista en `gateway/session.py::build_session_key`, que
  mete `thread_id`). **El enlace es topic→sesión, no topic→ticket**: el runtime no conoce claves de
  Jira. Decisión del CTO (SC-1436): Telegram abre o busca el ticket **con el mensaje** — como el
  enlace topic→key no existe en el runtime, la clave se busca en el texto del mensaje
  (`x86-host-runtime-pocharlies/libexec/hermes_bridge.py::clave_en`); sin clave, al ticket de
  vigilancia del día.
- **CLI fuera del enlace automático** (motivo escrito): `hermes -p <perfil> chat` abre sesión sin
  ticket. En el tronco, el modo de una sola vez (`-q`) queda `source="oneshot"`
  (`run_agent.py::ONESHOT_SOURCE`, línea 55; `CLI_FAMILY_SOURCES = {"cli", ONESHOT_SOURCE}`, línea 56;
  `::_session_source_for_agent` devuelve `ONESHOT_SOURCE` en la línea 70 y `"cli"` solo por defecto en
  la 71) — el valor concreto depende de la rama desplegada: la sesión suelta
  `20261001_154520_173428` que trazó el sre figura `cli` porque el pod corría una rama del fork. No
  se parchea aquí: la puerta son `DENY_HERMES_CLI` (chart `helm/hermes` de
  pocharlies-org/k8s-openclaw-qwen36-pocharlies) y `HERMES_CLI_DENY` (company-roles
  `lib/permissions.js`). La vía con ticket para probar un perfil ya existe: `company-sesion` /
  `company_encargos.py turno` por clave.
- **Cron retirado para los perfiles de compañía**: el cron nativo existe (`cron/jobs.py::JOBS_FILE`
  → `~/.hermes/profiles/<perfil>/cron/jobs.json`, toolset `"cronjob"` en `toolsets.py` →
  `cronjob_manage`, comando `hermes cron`), pero el chart lo desactiva por config
  (`agent.disabled_toolsets: [cronjob]`, que el gateway lee por turno en
  `gateway/run_turn.py::_resolve_turn_toolsets`) y el reseed retira cualquier `jobs.json` encontrado
  (pocharlies-org/k8s-openclaw-qwen36-pocharlies#481). No hay nada que cambiar en este repo.
- **Archivado por tick**: el runtime guarda el ciclo de vida (`archive`/`unarchive` y el barrido por
  días de inactividad `hermes_state_sessions.py::SessionSessionsMixin.maybe_auto_archive` (mixín de `SessionDB`); el archivador de la
  compañía (timer de 30 min, claves no `SC` incluidas) es `company_bots.archivar_sesiones` en
  x86-host-runtime-pocharlies `libexec/company_bots.py` y opera sobre este almacén.

- `2026-10-08` · `session_scope: task` en la config de un servidor MCP abre una conexión hija por `task_id` (tope 8, 600 s sin uso), con su navegador y su `_rpc_lock`; el chart lo emite solo para `playwright` · `tools/mcp_tool_handlers.py::_task_server` (SC-1939)
- trampa: `ARG BASE` es el tag vivo en `origin/deploy/prod` del chart **en el momento del pin** (no el de tu checkout), fijado además por digest, el del `imageID` del pod. Dos overlays en vuelo sobre el mismo tag no pueden estar vivos a la vez: el segundo se reconstruye sobre el primero. Comprobar al construir: `diff_ids` de la imagen = los de la base + 1 por cada `COPY`. Una rama cortada de otro overlay hereda su `overlay-tag`: no empujar con un tag que ya exista en Harbor (SC-1939, 09-10-2026; `pbddbbb7` pisado por la primera versión de la rama, y la base vieja no era la viva)

Última verificación contra el código: 2026-10-09 · c54c13d (rama `overlay/sc1939-session-scope-task`)
