# Handoff: panel lateral del chat de Hermes (`chat-side-panel`)

Canvas: `design/hermes-side-panel.dc.html` (seis frames, interruptor de tema arriba a la derecha).
Se abre en el editor de Claude Design o servido por HTTP (`python3 -m http.server` en `design/`); `file://`
no le vale al navegador de ux. Datos de ejemplo: sesiones, SKUs y modelos son verosímiles, no reales.

Lectura: panel de producto (control del modelo y navegación de sesiones) para un usuario intensivo, con el
lenguaje de /vivo (cristal de doble bisel, filetes, cifras finas con halo, muelles) sobre los tokens del tema
activo de Hermes. Diales: variación 4, movimiento 5, densidad 6.

Lo que se construye toca `web/src/pages/ChatPage.tsx` (contenedor, rail, hoja), `components/ChatSidebar.tsx`,
`ReasoningPicker.tsx`, `ChatSessionList.tsx`, `ModelReloadConfirm.tsx` (deja de usarse aquí), `themes/context.tsx`
(variables del panel) e i18n. No cambia: `ModelPickerDialog`, la página `/sessions`, la barra de la app,
`ProfileSwitcher`, las APIs.

## Decisiones (una línea, con su razón)

1. **Dos piezas de cristal apiladas** (modelo arriba, sesiones abajo llenando el alto) en vez de tarjetas sueltas: es el `.ch-panel`/`.a-overlay` de /vivo y separa lo que se configura de lo que se navega.
2. **Ancho 328 px** (304 entre 1024 y 1279; hoy 240): dos líneas por sesión con fuente, mensajes y hora sin cortar todo.
3. **Los colores salen del tema**, no de /vivo: el panel vive dentro de Hermes y debe seguir a Hermes Teal, Nous Blue, Midnight o un tema propio. De /vivo se toma el lenguaje, no la paleta.
4. **Razonamiento como deslizador de ocho pasos** (apagado a ultra) en vez de Select: se ve el nivel de un vistazo y se cambia con un gesto o con flechas.
5. **«Aplica en el próximo chat» dentro de la ficha del modelo** (`PendingApplyBand`) en vez de la tarjeta `modelNotice` más el diálogo `ModelReloadConfirm`: un solo sitio, sin modal, con «Aplicar ahora» (que es `startFreshDashboardChat`).
6. **Sesiones agrupadas por última actividad** (Ahora, Hoy, Ayer, Esta semana, Antes) con cabecera pegajosa: con 30 filas, orientarse por tiempo es más rápido que leer horas.
7. **Sin título se muestra el preview en gris**, no «Sesión sin título»: es lo que permite reconocerla.
8. **Plegado = riel HUD de 56 px**, no desaparecer: es el modo Visual de /vivo; modelo, razonamiento y «Nuevo chat» siguen a mano. Sustituye al botón flotante «panel» sobre el terminal.
9. **El terminal toma el radio de la concha** (`--r-shell`, una clase en `termWrapRef`): dos cajas vecinas con radios distintos se ven rotas.
10. **Móvil (< 640 px) en hoja inferior**; entre 640 y 1023, cajón lateral de 380 px: en el teléfono el pulgar llega abajo, no al borde derecho.
11. **El disparador de la cabecera móvil enseña el modelo** (punto de conexión y nombre corto) en vez del texto «Modelo y herramientas», que queda como `aria-label`.
12. **Sin fuente nueva**: sans y mono son las del tema (y del override del usuario). Una paridad exacta con /vivo (Space Grotesk + IBM Plex Mono) sería un tema propio, fuera de este encargo.

## Tokens

Nombres del template OWU-59 (`dgx-infra`, `k8s/apps/chat/tools/design_tokens_template.dc.html`); los extras son
propuesta al template. En `web/src` se definen como variables CSS en el `ThemeProvider` (`themes/context.tsx`),
calculadas de `--background-base`, `--midground-base` y `palette.warmGlow`. Hacen falta dos fórmulas según el tono
del fondo: el `ThemeProvider` calcula la luminancia de `background.hex` y pone `data-theme-tone="light"` en `<html>`
cuando pasa de 0,5 (Nous Blue); si no, `dark`. `mix(a p, b)` = `color-mix(in srgb, a p%, b)`.

| Token | Tono oscuro | Tono claro | Hermes Teal | Nous Blue | Uso |
|---|---|---|---|---|---|
| `--bg` | background | background | `#041c1c` | `#E8F2FD` | fondo, velo |
| `--surface` | mix(mid 4, bg) | mix(#fff 60, bg) | `#0e2423` | `#f4f9fe` | plano elevado |
| `--surface-2` | mix(mid 8, bg) | mix(mid 6, bg) | `#182c2a` | `#dceafc` | fila abierta, botón icono, monograma |
| `--text` | midground | mix(mid 62, #000) | `#ffe6cb` | `#00339d` | títulos, modelo, cifras |
| `--muted` | mix(mid 64, bg) | midground | `#a59d8c` | `#0053FD` | único nivel secundario |
| `--border` | mix(mid 10, transparent) | mix(mid 14, transparent) | | | bordes de control |
| `--accent` | midground | midground | `#ffe6cb` | `#0053FD` | primario, foco, barra de la fila abierta |
| `--accent-2` | mix(mid 65, warmGlow opaco 35) | mix(mid 85, #000) | `#ffd898` | `#0046d6` | final del degradado primario |
| `--on-accent` | background | `--surface` | `#041c1c` | `#f4f9fe` | texto sobre primario |
| `--glow` | warmGlow | mix(mid 20, transparent) | `rgba(255,189,56,.35)` | `rgba(0,83,253,.2)` | halos |
| `--ok` | `--color-success` | `#16a34a` | `#4ade80` | `#16a34a` | en vivo, sesión viva |
| `--warn` | `--color-warning` | `#b26b00` | `#ffbd38` | `#b26b00` | conectando, pendiente, clave |
| `--err` / `--err-tx` | `--color-destructive` / ≈ mix(err 45, #fff) | `#d61f2c` / `#b4141f` | `#fb2c36` / `#ff9a9a` | | fallos; `-tx` para texto |
| `--hair` / `--hair-2` | mix(mid 8 / 16, transparent) | mix(mid 10 / 20, transparent) | | | filetes, carriles |
| `--shell` | mix(mid 3.5, transparent) | mix(mid 4.5, transparent) | | | concha (con `backdrop-filter: blur(24px) saturate(1.3)`) |
| `--core` / `--core-solid` | mix(bg 80, transparent) / mix(mid 1, bg) | mix(#fff 90, transparent) / `#f7fbff` | | | núcleo; opaco para cabeceras pegajosas y hoja |
| `--shade` | mix(bg 30, #000) al 88 % | mix(mid 48, #000) al 22 % | `rgba(0,8,8,.88)` | `rgba(0,40,120,.22)` | sombra teñida, nunca negro puro |

Contraste medido (WCAG): oscuro texto 14,5:1, secundario 6,5:1 (5,5:1 sobre fila abierta), primario 14,7:1;
claro texto 10,3:1, secundario 5,5:1 (4,7:1 sobre fila abierta), primario 5,4:1, punto en vivo 3,2:1 (gráfico).
Con `prefers-reduced-transparency: reduce`, la concha pasa a `--core-solid` y se quita el blur.

**Radios** (de `--theme-radius`, 8 px en Hermes Teal): concha `× 2.5` (20), núcleo `concha − 5` (15), fila `× 1.25`
(10), píldora `× 999`. Con radio 0 (Mono, Cyberpunk) todo sale a escuadra.

**Espaciado** (× `--theme-spacing-mul`): concha 5; núcleo 16 en horizontal y 14 arriba; entre piezas 10; filas
8 arriba, 10 a los lados, 9 abajo; grupo 10 arriba y 4 abajo.

**Tipografía** (sans = `--theme-font-sans`, mono = `--theme-font-mono`, `tabular-nums` en toda cifra):
modelo 21/400/-0.02em con `text-shadow: 0 0 28px var(--glow)`; contexto 22/300/-0.03em; vacío 17/400;
«Sesiones» 14/500; «Nuevo chat» 13.5/500; título de fila 13 (500 en la abierta); avisos 12.5; etiquetas 12;
metadatos mono 11; ejes mono 10.5. Sin mayúsculas con tracking.

**Movimiento**: `--spring: cubic-bezier(.32,.72,0,1)`, `--out: cubic-bezier(.16,1,.3,1)`. Estados 250 a 300 ms;
deslizador 500 ms; panel, riel y hoja 700 ms (translate y opacity); filas entran con `--out`, 500 ms y 24 ms de
escalón solo en la primera carga; la barra de la fila abierta se desliza entre filas (`layoutId` de motion, ya es
dependencia); en vivo late cada 2 s. Solo `transform` y `opacity`: el ancho del terminal no se anima (xterm haría
`fit()` en cada fotograma). Todo se apaga con `prefers-reduced-motion`.

## Componentes

| Componente | Sale de | Contenido y estados |
|---|---|---|
| `ChatSidePanel` | contenedor de `ChatPage` | `variant: inline \| rail \| sheet \| drawer`; mantiene `id="chat-side-panel"`, `role="complementary"` (diálogo en hoja y cajón) y `aria-label` de hoy |
| `GlassShell` | nuevo | concha + núcleo; `tone: neutral \| warn \| err` cambia el filete |
| `PanelHeader` | fila `h-8` de hoy | perfil (`scopedProfile`, solo lectura) + «perfil de este chat»; botón plegar (`PanelRightClose`) o cerrar (`X`) |
| `ModelCard` | `ChatSidebar` | etiqueta, `ConnectionPill`, `ModelPickButton` (abre `ModelPickerDialog`), proveedor mono, `CapabilityStrip`, `EffortSlider`, `PendingApplyBand` |
| `ConnectionPill` | `Badge` + `STATE_LABEL` | open «en vivo» (late), connecting «conectando», closed/error «sin conexión», idle «en espera» |
| `CapabilityStrip` | `getModelInfo` | `effective_context_length` como «262 k contexto»; etiquetas `supports_tools` «herramientas», `supports_vision` «visión» |
| `EffortSlider` | `ReasoningPicker` | `role="slider"`, 0 a 7 sobre `EFFORT_OPTIONS`; clic, arrastre, flechas, Inicio/Fin; guarda al soltar con el mismo `saveConfig`; estados guardando (thumb late, «guardando») y revertido («No se guardó: sigue en X», `--err-tx`); si `!supports_reasoning`, una línea: «Este modelo no admite razonamiento» |
| `PendingApplyBand` | `modelNotice` + `ModelReloadConfirm` | «Guardado. Este chat sigue con X y razonamiento Y hasta que abras uno nuevo.» + «Aplicar ahora» (`startFreshDashboardChat`) + «Más tarde» (cierra la banda) |
| `PanelAlert` | `banner` de `ChatSidebar` | mismas fuentes y acciones de hoy: sidecar/feed (err, «Reconectar panel» o «Recargar página»), credencial (warn, icono llave, «Añadir clave» a `/env` y «Cambiar modelo») |
| `SessionsCard` | `ChatSessionList` | cabecera «Sesiones» + total mono + actualizar (gira al cargar); `NewChatButton`; lista agrupada; enlace «Todas las sesiones» a `/sessions` |
| `NewChatButton` | botón de hoy | píldora con degradado `--accent`→`--accent-2` e icono `+` en círculo; hover mueve el círculo (2, -1) y escala 1.06; pulsado 0.98 |
| `SessionGroup` | nuevo | Ahora = `is_active`; Hoy, Ayer = día local; Esta semana = 7 días; Antes. Grupo vacío no se pinta |
| `SessionRow` | `ListItem` | punto que late si `is_active`; título o `preview` en `--muted`; fuente con icono; «N msj» si > 0; «N herr.» si `tool_call_count` > 0; hora mono a la derecha; `aria-current` en la de `resumeParam` |
| `SessionsSkeleton` / `SessionsEmpty` / `SessionsError` | estados de hoy | cinco filas con brillo; «Aún no hay sesiones en {perfil}.»; «No se pudo leer la lista de sesiones.» + «Reintentar» |
| `PanelRail` | botón flotante «panel» | desplegar, punto de conexión, `ModelMonogram` (tooltip modelo y razonamiento; clic abre el selector), `EffortMeter` vertical, «Nuevo chat», sesiones (despliega con foco en la fila abierta) |
| `HeaderTrigger` | botón de `setEnd` | punto + nombre corto del modelo + chevron; `aria-label` «Modelo y herramientas», `aria-expanded`, `aria-controls` |

Iconos: `lucide-react` (ya está), trazo 1.5. Fuente de la sesión: telegram `Send`, whatsapp `MessageCircle`,
cli `Terminal`, api/api_server `Globe`, webhook `Webhook`, cron `Clock`; otra fuente, solo el texto. Hoy `cli` se
oculta: pasa a mostrarse como las demás. Monograma: inicial del primer tramo + primera serie de cifras del id
(`qwen38-flash-next` Q38, `gpt-6.2-sol` G6.2, `anthropic-haiku-5-5` A5); sin cifras, dos letras (`or-glm` OR).
Hora relativa en castellano vía i18n: «ahora», «N min», «N h», «ayer», «N d» (hoy `timeAgo` dice «m ago»).

## Disposición por ancho

- **≥ 1280 px**: panel en línea de 328 px, `gap` 12 con el terminal (frame 1). Plegado: riel de 56 px (frame 3), estado en `hermes-chat-panel-collapsed` como hoy.
- **1024 a 1279**: igual, panel de 304 px.
- **640 a 1023**: cajón derecho de 380 px, portal a `document.body` (velo z 55, cajón z 60 como hoy), misma estructura que el escritorio.
- **< 640**: hoja inferior al 88 dvh con asa (frame 5). Cierra con arrastre hacia abajo > 96 px, Esc, velo o al elegir una sesión (`onPicked`). En móvil: botón icono 40 px, filas ≥ 52 px, deslizador con 36 px de zona táctil, «Nuevo chat» 46 px.
- Hoja y cajón: foco al botón de cerrar al abrir, atrapado dentro, vuelve al disparador al cerrar; `body` sin scroll mientras están abiertos (como hoy).

## i18n (claves nuevas, en `es` y `en`)

- Cabecera y modelo: `chatPanel.profileOfChat` «perfil de este chat», `chatPanel.model` «Modelo», `chatPanel.context` «contexto», `chatPanel.tools` «herramientas», `chatPanel.vision` «visión», `chatPanel.collapse`, `chatPanel.expand`.
- Razonamiento: `chatPanel.reasoning` «Razonamiento», `chatPanel.noReasoning`, `chatPanel.effort.*` (Apagado, Mínimo, Bajo, Medio, Alto, Extra alto, Máximo, Ultra), `chatPanel.saving`, `chatPanel.notSaved`.
- Cambio pendiente: `chatPanel.pending`, `chatPanel.applyNow` «Aplicar ahora», `chatPanel.later` «Más tarde».
- Conexión: `chatPanel.conn.*` (en vivo, conectando, sin conexión, en espera).
- Sesiones: `chatPanel.groups.*` (Ahora, Hoy, Ayer, Esta semana, Antes), `chatPanel.msgs` «msj», `chatPanel.toolCalls` «herr.», `chatPanel.allSessions` «Todas las sesiones», `chatPanel.emptyProfile`, `time.*` para la hora relativa. Se reutilizan `sessions.title`, `sessions.newChat`, `common.retry`, `common.refresh`,
`app.modelToolsSheetTitle`/`Subtitle`, `app.closeModelTools`.

## Cómo se comprueba (tareas de usuario para ux)

- Desde el chat, Dani cambia el razonamiento de bajo a alto con el ratón y luego con el teclado, ve «Guardado» y lo aplica con «Aplicar ahora».
- Desde el panel, abre el selector pulsando el nombre del modelo y vuelve con otro modelo; la banda le dice que el chat abierto sigue con el anterior.
- Encuentra la sesión de ayer por su grupo y la abre; la fila queda marcada y el terminal la retoma.
- Pliega el panel, crea un chat nuevo desde el riel y lo vuelve a desplegar; al recargar sigue plegado.
- A 390 px abre la hoja desde la cabecera, elige una sesión y la hoja se cierra sola.
- Con el gateway caído ve el aviso rojo y reconecta sin recargar la página; el terminal no se tapa.
