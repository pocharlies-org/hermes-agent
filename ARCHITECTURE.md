# ARCHITECTURE — hermes-agent

Fork de [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (agente auto-mejorable
de Nous Research: CLI + gateway multiplataforma + API HTTP). La compañía lo ejecuta como runtime de los
perfiles Hermes (`cto`, `analista`, `sre-devops`, `security`, `hogar`, `skirmshop`, secretarias) en k3s.
Lo que se mantiene aquí es upstream; los cambios propios son overlays puntuales de un fichero sobre
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
    la imagen desde ramas del fork (hoy `deploy/v2026.9.14-reasoning-picker` + overlays de un fichero) y
    siembra perfiles, `config.yaml`, rutas de webhook y Secrets. Aplicación ArgoCD `hermes` (sync manual;
    despliega el workflow `hermes-despliegue.yml`).
  - `x86-host-runtime-pocharlies`: `company_encargos` / `vigilante` / `despertador` entregan turnos a los
    perfiles de compañía por la API del pod (`X-Hermes-Session-Key`, §«Sesiones por ticket»);
    `hermes_bridge` consume los eventos del gateway.

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
| clave de sesión determinista | `build_session_key` | `gateway/session.py:654` | gateway (todas las plataformas) |
| binding topic de Telegram → sesión | tabla `(profile_name, chat_id, thread_id) → session_key` | `hermes_state_telegram.py` | gateway/platforms/telegram |
| API HTTP con continuidad por clave | `APIServerAdapter`, header `X-Hermes-Session-Key` | `gateway/platforms/api_server.py:1110,75` | `company_encargos` de la compañía |
| cron propio | scheduler + `jobs.json` por perfil | `cron/jobs.py` (`~/.hermes/profiles/<p>/cron/jobs.json`) | `hermes cron`, toolset `cronjob` |
| supresión de toolsets | `agent.disabled_toolsets` (se aplica la última) | `hermes_cli/tools_config.py:594`, `toolsets.py:115` | chart `helm/hermes` (`[cronjob]`) |

## 5. Cómo se construye aquí

Código upstream: no se reorganiza. `agent/` = runtime del agente; `gateway/` = proceso multiplexador de
plataformas (`gateway/run.py` registra adaptadores; `api_server` y `webhook` son no interactivos);
`plugins/platforms/<p>/` = adaptadores; `hermes_cli/` = CLI y config (`config_defaults.py`); `cron/` =
scheduler con entrega a cualquier plataforma; `hermes_state_*.py` = SessionDB particionado por mixins.
Los perfiles viven bajo `~/.hermes/profiles/<perfil>/` (config, skills, cron, sesiones) y el gateway
multiplexa varios en un proceso. Un overlay propio se ancla a un commit del fork y toca un fichero
(api_server, health probe…); nunca una reescritura de módulo.

## 6. Tests y validaciones

```sh
python3 -m pytest tests/ -x -q          # suite Python (unit + integración sobre SessionDB y gateway)
npm test                              # JS (apps/desktop y tooling), ver .github/workflows/js-tests.yml
```

Los tests no lanzan cargas a los Sparks ni a Jira: todo contacto externo va por adaptadores parcheables.

## 7. CI/CD y despliegue

CI del fork: `ci.yaml`, `tests.yml`, `lint.yml`, `js-tests.yml`, `supply-chain-audit.yml`… (upstream).
El despliegue de la compañía **no** lee este repo directamente: ArgoCD app `hermes` lee
`k8s-openclaw-qwen36-pocharlies@deploy/prod` (chart `helm/hermes`), que fija la imagen desde una rama de
este fork con overlays de un fichero y siembra la config por ConfigMap (recarga en caliente vía sidecar
`hermes-reseed`; reinicio solo con el workflow `hermes-despliegue.yml`). Validar producción:
`kubectl exec -n hermes deploy/hermes-gateway -c hermes -- hermes -p <perfil> sessions list` y el
`/health/detailed` del pod.

## 8. Sesiones por ticket (SC-1422)

Regla de la compañía: **cada conversación de un perfil de la compañía pertenece a un ticket de Jira**
(conversación `epica-<key>` por ticket y perfil). Este repo aporta las tres piezas por las que eso es
posible, y ninguna decide el enlace ticket↔sesión — eso lo decide `x86-host-runtime-pocharlies`
(ver su `ARCHITECTURE.md`, «Sesiones por ticket»):

- **API con clave declarada**: `APIServerAdapter` acepta `X-Hermes-Session-Key` y reanuda la sesión viva
  de esa clave (`_declared_conversation_session`, `gateway/platforms/api_server.py:1581`), con
  `source="api_server"`. `company_encargos.enviar`/`turno` la usan para clavar el turno a `epica-<key>`.
- **Topics de Telegram → sesión**: el gateway enlaza cada topic de foro a una sesión
  (`hermes_state_telegram`, `build_session_key` con `thread_id`). **El enlace es topic→sesión, no
  topic→ticket**: el runtime no conoce claves de Jira. Decisión del CTO (SC-1436): Telegram abre o busca
  el ticket **con el mensaje** — como el enlace topic→key no existe en el runtime, la clave se busca en
  el texto del mensaje (`hermes_bridge.clave_en` en el x86); sin clave, al ticket de vigilancia del día.
- **CLI fuera del enlace automático** (motivo escrito): `hermes -p <perfil> chat` abre sesión con
  `source="cli"` y sin ticket — así entró la sesión suelta `20261001_154520_173428` que trazó el sre. No
  se parchea aquí: la puerta son `DENY_HERMES_CLI` (chart) y `HERMES_CLI_DENY` (company-roles). La vía
  con ticket para probar un perfil ya existe: `company-sesion` / `company_encargos.py turno` por clave.
- **Cron retirado para los perfiles de compañía**: el cron nativo existe (`cron/jobs.py`,
  `~/.hermes/profiles/<p>/cron/jobs.json`, toolset `cronjob` → `cronjob_manage`, `hermes cron`), pero el
  chart lo desactiva por config (`agent.disabled_toolsets: [cronjob]`, que `tools_config.py` aplica la
  última) y el reseed retira cualquier `jobs.json` encontrado (chart PR #481). No hay nada que cambiar
  en este repo.
- **Archivado por tick**: el runtime guarda el ciclo de vida (`archive`/`unarchive`,
  `maybe_auto_archive` por días de inactividad, `hermes_state_sessions.py:1602`); el archivador de la
  compañía (timer de 30 min, claves no `SC` incluidas) es `company_bots.archivar_sesiones` en el x86 y
  usa este almacén.

## 9. Decisiones y trampas

- `2026-09` · imagen desde rama del fork + overlays de un fichero en vez de fork interno divergente · chart `values.yaml` `image:` (SC-710, DGX-366)
- `2026-10-02` · el enlace topic→ticket no vive en el runtime: Telegram liga la clave desde el texto del mensaje · SC-1436 (decisión del CTO)
- trampa: una sesión del api_server reanudada con modelo persistido re-resolvía el provider `custom` pelado → «No LLM provider configured» desde el 2.º turno · overlay `fix/api-server-named-provider-resume` (DGX-366)

Última verificación contra el código: 2026-10-02 · f14f86d
