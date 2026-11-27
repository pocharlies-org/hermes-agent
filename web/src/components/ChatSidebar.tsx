/**
 * ChatSidebar — structured-events panel that sits next to the xterm.js
 * terminal in the dashboard Chat tab.
 *
 * Two WebSockets, one per concern:
 *
 *   1. **JSON-RPC sidecar** (`GatewayClient` → /api/ws) — a lightweight
 *      session used only for connection state (the "live" badge) and
 *      credential warnings. Independent of the PTY pane's session by
 *      design. The model badge does NOT come from here: it prefers the
 *      PTY chat session's runtime identity (`session.info` over the events
 *      feed — the model actually answering, which changes when a provider
 *      fallback replaces the configured primary mid-turn, #54509), falls
 *      back to the effective config model over REST (`/api/model/info`),
 *      and the model picker writes config over REST (`/api/model/set`)
 *      then offers "Apply now" (a fresh chat) so the running chat adopts it.
 *
 *   2. **Event subscriber** (/api/events?channel=…) — passive, receives
 *      every dispatcher emit from the PTY-side `tui_gateway.entry` that
 *      the dashboard fanned out.  The sidebar uses it for `session.info`
 *      (live chat title) and `dashboard.new_session_requested`.  The
 *      `channel` id ties this listener to the same chat tab's PTY child —
 *      see `ChatPage.tsx` for where the id is generated.  Transient drops
 *      (gateway restart, network blip) auto-reconnect with exponential
 *      backoff; auth rejections are terminal.  See `lib/events-reconnect`.
 *
 * Best-effort throughout: WS failures show in the badge / banner, the
 * terminal pane keeps working unimpaired.
 */

import { ModelPickerDialog } from '@/components/ModelPickerDialog'
import { ReasoningPicker } from '@/components/ReasoningPicker'
import { GatewayClient, type ConnectionState } from '@/lib/gatewayClient'
import { EventsFeedClient } from '@/lib/eventsFeedClient'
import { api } from '@/lib/api'
import {
  EVENTS_MAX_RECONNECT_ATTEMPTS,
  eventsGaveUpMessage,
  eventsReconnectDelayMs,
  eventsReconnectingMessage,
  eventsRejectedMessage,
  isEventsAuthRejection,
  isEventsAuthRejectionMessage,
  isEventsFeedMessage,
  shouldRetryEventsClose
} from '@/lib/events-reconnect'
import { credentialWarning, sidecarErrorMessage } from '@/lib/chat-sidebar-banner'
import { titleFromSessionInfoPayload } from '@/lib/chat-title'
import { useI18n } from '@/i18n'

import { cn } from '@/lib/utils'
import { AlertCircle, ChevronDown, KeyRound, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

interface SessionInfo {
  cwd?: string
  model?: string
  provider?: string
  credential_warning?: string
  title?: string
}

// Auto-redial budget for the JSON-RPC sidecar (#95951). After this many
// bounded-backoff attempts the manual Reconnect affordance stays the only
// path, mirroring the events feed's give-up contract.
const SIDE_CAR_MAX_RECONNECT_ATTEMPTS = 5;

// A socket that opens and dies within this window is a flap, not a recovery:
// only a connection that stays open this long refills a reconnect budget.
// Shared by the JSON-RPC sidecar and the events feed (#129393).
const HEALTHY_OPEN_GRACE_MS = 10_000;

// Surfaced once when the redial budget is exhausted. Only this module may
// clear it (on the next successful open), matching how the events feed
// owns its own banner messages.
const SIDE_CAR_GAVE_UP_MESSAGE =
  "gateway sidecar disconnected — gave up after " +
  `${SIDE_CAR_MAX_RECONNECT_ATTEMPTS} attempts, use Reconnect`;

/** What each sidecar state paints in the model card's live pill. */
const CONN_PILL: Record<ConnectionState, { cls: string; key: 'live' | 'connecting' | 'idle' | 'offline' }> = {
  open: { cls: '', key: 'live' },
  connecting: { cls: 'warn', key: 'connecting' },
  idle: { cls: 'warn', key: 'idle' },
  closed: { cls: 'err', key: 'offline' },
  error: { cls: 'err', key: 'offline' }
}

/** Model capabilities as `/api/model/info` reports them (absent means unknown). */
interface PanelCaps {
  context: number
  tools: boolean
  vision: boolean
  reasoning: boolean | null
}

/** The runtime model a `session.info` payload reports, or undefined when it
 *  carries none (title-only updates) — config stays the badge's source then.
 *  `session.info` is surface-specific on the wire, so narrow defensively. */
function sessionInfoModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const model = (payload as { model?: unknown }).model
  return typeof model === 'string' && model.trim() ? model : undefined
}

interface ChatSidebarProps {
  channel: string
  /** Chat profile from the dashboard switcher / URL scope. */
  profile?: string
  className?: string
  onDashboardNewSessionRequest?: () => void
  onSessionTitleChange?: (title: string | null) => void
  /** Starts a fresh chat — how a just-saved model/effort is applied now
   *  (the PendingApplyBand's primary action). */
  onApplyNow?: () => void
  /** Reports the sidecar connection state upward (the collapsed rail's dot). */
  onConnectionState?: (state: ConnectionState) => void
}

/** Build the ``session.create`` params for the sidecar session.
 *
 * Extracted from the effect below so the invariant — close_on_disconnect
 * is set, source is "tool", and the profile is forwarded when present —
 * can be tested without reading component source text. See
 * ``chat-sidebar-session-params.test.ts``.
 */
export function sidecarSessionCreateParams(profile?: string): Record<string, unknown> {
  return {
    close_on_disconnect: true,
    source: 'tool',
    ...(profile ? { profile } : {})
  }
}

export function ChatSidebar({
  channel,
  profile,
  className,
  onDashboardNewSessionRequest,
  onSessionTitleChange,
  onApplyNow,
  onConnectionState
}: ChatSidebarProps) {
  const navigate = useNavigate()
  const { t } = useI18n()
  // `version` bumps on reconnect (manual button, profile/channel switch) and
  // re-runs the socket effects. The clients themselves live for the whole
  // component: the shared client keeps per-session seq watermarks and asks
  // the gateway to replay the gap on the next `connect()`, which only works
  // when the SAME instance survives the drop.
  const [version, setVersion] = useState(0)
  const gw = useMemo(() => new GatewayClient(), [])
  const feed = useMemo(() => new EventsFeedClient(), [])
  // Sidecar auto-redial budget (#95951). A ref, NOT effect state: the counter
  // must survive the [gw, version] effect re-runs a redial triggers, or the
  // budget resets every attempt and never exhausts.
  // Reset on a successful open and on scope switches.
  const sidecarRedialAttemptRef = useRef(0)
  const sidecarGaveUpRef = useRef(false)

  const [state, setState] = useState<ConnectionState>('idle')
  const [info, setInfo] = useState<SessionInfo>({})
  const [modelOpen, setModelOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Runtime model identity of the PTY chat session, from its `session.info`
  // broadcasts over the events feed. This is the model actually answering —
  // when a provider fallback replaces the configured primary mid-turn
  // (#54509), the end-of-turn `session.info` reports the fallback model, and
  // the badge must follow it rather than attribute the response to the
  // configured model that failed.
  const [runtimeModel, setRuntimeModel] = useState('')
  // The config fallback for the badge: config.yaml's main model
  // (`model.default`) via `/api/model/info` — the same value the Models page
  // writes and a new chat session boots from, shown until the PTY session
  // has broadcast a runtime identity. We deliberately don't use the
  // SIDECAR's `session.info` model: that's a one-time snapshot of the
  // throwaway sidecar agent taken when its session is created, and it never
  // updates when the model is changed elsewhere, so the badge would go
  // stale. Pass the chat profile explicitly so this card stays scoped to
  // the PTY even if the global dashboard switcher changes while the chat
  // is open.
  const [effectiveModel, setEffectiveModel] = useState('')
  const [effectiveProvider, setEffectiveProvider] = useState('')
  // Capabilities for the ModelCard's strip (context, tools, vision) and the
  // gate on the ReasoningPicker. From `/api/model/info`.
  // `reasoning` is null when the backend doesn't report it (`capabilities: {}`
  // for litellm routes): unknown means SHOW the slider — the old UI always
  // did, and hiding it on absent data regressed effort control entirely.
  const [caps, setCaps] = useState<PanelCaps>({
    context: 0,
    tools: false,
    vision: false,
    reasoning: null
  })
  // Bumped on model change/save so ReasoningPicker re-reads the saved effort
  // (config is profile-scoped the same way the model badge is).
  const [modelRefreshKey, setModelRefreshKey] = useState(0)
  // A just-saved model/effort the running chat hasn't adopted yet: rendered as
  // the PendingApplyBand inside the ModelCard (replaces the old modelNotice
  // card + ModelReloadConfirm dialog).
  const [pending, setPending] = useState<'model' | 'effort' | null>(null)

  const refreshEffectiveModel = useCallback(() => {
    void api
      .getModelInfo(profile)
      .then(r => {
        if (r?.model) setEffectiveModel(String(r.model))
        if (r?.provider) setEffectiveProvider(String(r.provider))
        setCaps({
          context: Number(r?.effective_context_length ?? r?.capabilities?.context_window ?? 0),
          tools: !!r?.capabilities?.supports_tools,
          vision: !!r?.capabilities?.supports_vision,
          reasoning: r?.capabilities?.supports_reasoning ?? null
        })
        // Bump so ReasoningPicker re-reads the saved effort for the new model.
        setModelRefreshKey(k => k + 1)
      })
      .catch(() => {
        // Best-effort: keep the last known label rather than blanking it.
      })
  }, [profile])

  // Profile or PTY channel change tears down both WebSockets. Bump `version`
  // (same path as the manual Reconnect button) so the gateway client is
  // recreated and the events feed resubscribes — otherwise the old events
  // socket's close handler can leave a stale error banner after a switch.
  const scopeKey = `${channel}\0${profile ?? ''}`
  const prevScopeKey = useRef<string | null>(null)
  useEffect(() => {
    if (prevScopeKey.current === null) {
      prevScopeKey.current = scopeKey
      return
    }
    if (prevScopeKey.current === scopeKey) return
    prevScopeKey.current = scopeKey
    setError(null)
    // Fresh PTY child on the new scope: its runtime identity is unknown until
    // its first `session.info` broadcast, so drop the previous chat's model.
    setRuntimeModel('')
    // Fresh scope, fresh sidecar redial budget (#95951).
    sidecarRedialAttemptRef.current = 0
    sidecarGaveUpRef.current = false
    setVersion(v => v + 1)
  }, [scopeKey])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setInfo({})
      setError(null)
    })
    const offState = gw.onState(s => {
      setState(s)
      onConnectionState?.(s)
    })

    const offSessionInfo = gw.on('session.info', ev => {
      // session.info is surface-specific on the wire; narrow to the fields this sidebar reads.
      const payload = ev.payload as SessionInfo | undefined

      if (payload) {
        setInfo(prev => ({ ...prev, ...payload }))
      }
    })

    const offError = gw.on('error', ev => {
      const message = ev.payload?.message

      if (message) {
        console.warn(`[chat-sidebar] sidecar error: ${message}`)
        setError(sidecarErrorMessage(message))
      }
    })

    // Auto-redial after a transient drop (#95951): a dashboard service
    // restart closes the sidecar's WebSocket with 1012, and GatewayClient
    // deliberately delegates reconnect policy to this connection owner.
    // Bounded exponential backoff — the same shape the PTY pane uses —
    // capped at SIDE_CAR_MAX_RECONNECT_ATTEMPTS; after that the manual
    // Reconnect affordance stays the only path. A successful open resets
    // the counter; unmount or a scope switch (version bump) cancels the
    // pending timer because this effect tears down with the old client.
    let redialTimer: ReturnType<typeof setTimeout> | null = null;
    let healthyOpenTimer: ReturnType<typeof setTimeout> | null = null;
    // onState replays the current state synchronously. Ignore only that
    // subscription-time snapshot; real transitions in the same effect must
    // still consume the retry budget.
    let replayingInitialState = true;
    queueMicrotask(() => {
      replayingInitialState = false;
    });
    const offRedial = gw.onState((s) => {
      if (replayingInitialState) {
        return;
      }
      if (s === "open") {
        // A pending redialTimer would bump the version and tear down the
        // connection that just opened (#129393).
        if (redialTimer) {
          clearTimeout(redialTimer);
          redialTimer = null;
        }
        if (healthyOpenTimer) {
          clearTimeout(healthyOpenTimer);
        }
        // Do not reset the budget on every open: an open→immediate-close
        // cycle would otherwise reset it forever. Reset only after a stable
        // connection has remained open for the grace period.
        healthyOpenTimer = setTimeout(() => {
          healthyOpenTimer = null;
          sidecarRedialAttemptRef.current = 0;
          if (sidecarGaveUpRef.current) {
            sidecarGaveUpRef.current = false;
            setError((current: string | null) =>
              current === SIDE_CAR_GAVE_UP_MESSAGE ? null : current,
            );
          }
        }, HEALTHY_OPEN_GRACE_MS);
        return;
      }
      if (s !== "closed" && s !== "error") {
        return;
      }
      if (healthyOpenTimer) {
        clearTimeout(healthyOpenTimer);
        healthyOpenTimer = null;
      }
      if (cancelled || redialTimer) {
        return;
      }
      // The attempt counter lives in a ref: each redial rebuilds the client
      // and re-runs this effect, so a closure-local counter would reset and
      // the budget would never exhaust (#95951).
      if (sidecarRedialAttemptRef.current >= SIDE_CAR_MAX_RECONNECT_ATTEMPTS) {
        // Mirror the events feed's give-up contract: say so once, then the
        // manual Reconnect affordance stays the only path. Cleared again if
        // a later connection does open (manual reconnect followed by a
        // within-budget drop).
        if (!sidecarGaveUpRef.current) {
          sidecarGaveUpRef.current = true;
          setError((current) => current ?? SIDE_CAR_GAVE_UP_MESSAGE);
        }
        return;
      }
      const attempt = sidecarRedialAttemptRef.current;
      sidecarRedialAttemptRef.current += 1;
      const delayMs = Math.min(250 * 2 ** attempt, 3000);
      redialTimer = setTimeout(() => {
        redialTimer = null;
        if (!cancelled) {
          setVersion((v) => v + 1);
        }
      }, delayMs);
    });

    // Create the sidecar session so the gateway surfaces session-scoped
    // signals (connection state, credential warnings). It's independent of the
    // PTY pane's session by design. The model picker no longer rides this
    // session — it writes config.yaml over REST — so we don't track its id.
    gw.connect()
      .then(() => {
        if (cancelled) {
          return
        }
        // close_on_disconnect: the gateway reaps this sidecar session (and its
        // slash_worker subprocess) when the WS drops, instead of leaking it.
        return gw.request<{ session_id: string }>('session.create', sidecarSessionCreateParams(profile))
      })
      .catch((e: Error) => {
        if (!cancelled) {
          console.warn(`[chat-sidebar] sidecar connect failed: ${e.message}`)
          setError(sidecarErrorMessage(e.message))
        }
      })

    return () => {
      cancelled = true
      if (redialTimer) {
        clearTimeout(redialTimer)
        redialTimer = null
      }
      if (healthyOpenTimer) {
        clearTimeout(healthyOpenTimer)
        healthyOpenTimer = null
      }
      offRedial()
      offState()
      offSessionInfo()
      offError()
      gw.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gw, version])

  // Event subscriber WebSocket — receives the rebroadcast of every
  // dispatcher emit from the PTY child's gateway.  See /api/pub +
  // /api/events in hermes_cli/web_server.py for the broadcast hop.
  //
  // Framing, dispatch and connect timeout come from the shared JSON-RPC
  // client (`EventsFeedClient`); this effect owns only the retry policy and
  // the banner. Failures (auth/loopback rejection, server too old to expose
  // the endpoint, transient drops) surface in the same banner as the
  // JSON-RPC sidecar so the sidebar matches its documented best-effort UX
  // and the user always has a reconnect affordance.
  useEffect(() => {
    if (!channel) {
      return
    }
    let unmounting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let healthyOpenTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    // The banner is shared with `info.credential_warning` and the JSON-RPC
    // sidecar, and `error` is those messages' only home — the sidecar does
    // not re-emit. So the events feed may only write over an empty banner
    // or one of its own messages, and may only clear its own.
    const surface = (msg: string) =>
      !unmounting && setError(current => (isEventsFeedMessage(current) ? msg : (current ?? msg)))

    const clearEventsBanner = () => !unmounting && setError(current => (isEventsFeedMessage(current) ? null : current))

    // Single scheduling path: the client collapses `error` + `close` of one
    // socket generation into one `closed` transition, so only one timer is
    // ever queued per drop.
    const scheduleReconnect = () => {
      if (unmounting || reconnectTimer) {
        return
      }
      if (healthyOpenTimer) {
        clearTimeout(healthyOpenTimer)
        healthyOpenTimer = null
      }
      if (attempt >= EVENTS_MAX_RECONNECT_ATTEMPTS) {
        surface(eventsGaveUpMessage())
        return
      }

      const delay = eventsReconnectDelayMs(attempt)
      attempt += 1
      surface(eventsReconnectingMessage(delay))

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, delay)
    }

    const connect = async () => {
      if (unmounting) {
        return
      }
      try {
        // Re-minted every attempt: tickets are single-use with a short TTL,
        // so a reconnect cannot replay the URL from the first connection.
        await feed.connect(channel)
      } catch {
        // Connect-phase failures (ticket mint, handshake timeout, close
        // during handshake) reach the reconnect ladder through the close
        // handler when a socket existed; a pre-socket failure has no close
        // event, so schedule here. `onClose` de-dupes via `reconnectTimer`.
        if (!unmounting && feed.lastCloseCode === null) {
          scheduleReconnect()
        }
      }
    }

    const offClose = feed.onClose(code => {
      if (unmounting) {
        return
      }
      console.warn(`[chat-sidebar] events feed closed code=${code ?? 'none'}`)
      if (code !== undefined && isEventsAuthRejection(code)) {
        surface(eventsRejectedMessage(code))
        return
      }
      // `undefined` = handshake timeout / error without a close frame.
      if (shouldRetryEventsClose(code)) {
        scheduleReconnect()
      }
    })

    const offState = feed.onState(state => {
      if (state === 'open') {
        clearEventsBanner()
        // Same rule as the sidecar: an open that dies within the grace window
        // is a flap, not a recovery, so it must not refill the ladder.
        if (healthyOpenTimer) {
          clearTimeout(healthyOpenTimer)
        }
        healthyOpenTimer = setTimeout(() => {
          healthyOpenTimer = null
          attempt = 0
        }, HEALTHY_OPEN_GRACE_MS)
      }
    })

    const offSessionInfo = feed.on('session.info', ev => {
      const title = titleFromSessionInfoPayload(ev.payload)
      if (title !== undefined) {
        onSessionTitleChange?.(title)
      }
      // Runtime identity of the PTY chat session — the model actually
      // answering, which a provider fallback can swap mid-turn (#54509).
      // The gateway re-emits `session.info` at every turn end (and on model
      // switches), so this stays current without any new plumbing.
      const model = sessionInfoModel(ev.payload)
      if (model !== undefined) {
        setRuntimeModel(model)
      }
    })
    const offNewSession = feed.on('dashboard.new_session_requested', () => {
      onDashboardNewSessionRequest?.()
    })

    void connect()

    return () => {
      unmounting = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (healthyOpenTimer) {
        clearTimeout(healthyOpenTimer)
        healthyOpenTimer = null
      }
      offClose()
      offState()
      offSessionInfo()
      offNewSession()
      feed.close()
    }
  }, [channel, feed, onDashboardNewSessionRequest, onSessionTitleChange, version])

  // Seed the badge on mount and re-read it whenever the sockets are rebuilt
  // (a profile/channel switch bumps `version`).
  useEffect(() => {
    refreshEffectiveModel()
  }, [refreshEffectiveModel, version])

  const reconnect = useCallback(() => {
    setError(null)
    setPending(null)
    setVersion(v => v + 1)
  }, [])

  // Runtime-first (#54509): the PTY session's `session.info` reports the
  // model that is actually answering, so a provider-fallback swap shows the
  // fallback model, not the configured primary that failed. Config remains
  // the fallback until the PTY has broadcast a runtime identity (fresh chat,
  // events feed still connecting).
  const modelName = runtimeModel || effectiveModel || info.model || '—'
  const modelLabel = modelName.split('/').slice(-1)[0] ?? '—'
  const credential = credentialWarning(info.credential_warning)
  const banner = error ?? credential?.message ?? null
  const showReload = isEventsAuthRejectionMessage(error)
  const conn = CONN_PILL[state]

  return (
    <div className={cn('hp w-full min-w-0', className)}>
      {/* ModelCard — name opens the picker, capabilities and the effort
          slider live under it; a just-saved change shows the PendingApplyBand
          inside the card instead of a dialog. */}
      <ModelCard
        connCls={conn.cls}
        connLabel={t.chatPanel.conn[conn.key]}
        modelName={modelName}
        modelLabel={modelLabel}
        effectiveProvider={effectiveProvider}
        caps={caps}
        profile={profile}
        modelRefreshKey={modelRefreshKey}
        pending={pending}
        onPickModel={() => setModelOpen(true)}
        onEffortChanged={() => setPending('effort')}
        onApplyNow={onApplyNow}
        onDismissPending={() => setPending(null)}
      />

      {banner && (
        <PanelAlert
          error={error}
          banner={banner}
          showReload={showReload}
          hasCredential={!!credential}
          onReconnect={reconnect}
          onAddKey={() => navigate('/env')}
          onSwitchModel={() => setModelOpen(true)}
        />
      )}

      {modelOpen && (
        <ModelPickerDialog
          // Same path the Models page uses (REST /api/model/set), not the
          // sidecar config.set RPC, which didn't reliably land in the
          // config.yaml the agent boots from. Always persisted (alwaysGlobal).
          loader={() => api.getModelOptions(profile)}
          alwaysGlobal
          onApply={async ({ provider, model, confirmExpensiveModel }) => {
            setPending(null)
            const result = await api.setModelAssignment(
              {
                confirm_expensive_model: confirmExpensiveModel,
                scope: 'main',
                provider,
                model
              },
              profile
            )
            // confirm_required => the dialog shows the expensive-model prompt
            // and calls back; don't announce until the user confirms.
            if (!result.confirm_required) {
              refreshEffectiveModel()
              // The running chat keeps its model until a fresh one starts —
              // surfaced as the band, whose primary action starts it.
              setPending('model')
            }
            return result
          }}
          onClose={() => {
            setModelOpen(false)
            refreshEffectiveModel()
          }}
        />
      )}
    </div>
  )
}

/**
 * ModelCard — the panel's first glass piece: the model that answers, its
 * capabilities and the reasoning-effort slider under it. A just-saved model or
 * effort shows the PendingApplyBand inside the card (the running chat keeps its
 * model until a fresh one starts, which `onApplyNow` starts).
 */
function ModelCard({
  connCls,
  connLabel,
  modelName,
  modelLabel,
  effectiveProvider,
  caps,
  profile,
  modelRefreshKey,
  pending,
  onPickModel,
  onEffortChanged,
  onApplyNow,
  onDismissPending
}: {
  connCls: string
  connLabel: string
  modelName: string
  modelLabel: string
  effectiveProvider: string
  caps: PanelCaps
  profile?: string
  modelRefreshKey: number
  pending: 'model' | 'effort' | null
  onPickModel: () => void
  onEffortChanged: () => void
  onApplyNow?: () => void
  onDismissPending: () => void
}) {
  const { t } = useI18n()
  const contextLabel =
    caps.context >= 1024 ? `${Math.round(caps.context / 1024)} k` : caps.context > 0 ? String(caps.context) : ''

  return (
    <div className="hp-shell">
      <div className="hp-core hp-model">
        <div className="hp-r1">
          <span className="hp-k">{t.chatPanel.model}</span>
          <span className={cn('hp-live', connCls)} role="status">
            <i />
            {connLabel}
          </span>
        </div>

        <button
          type="button"
          className="hp-pick"
          aria-haspopup="dialog"
          title={modelName === '—' ? t.chatPanel.model : modelName}
          onClick={onPickModel}
        >
          <strong>{modelLabel}</strong>
          <span className="c">
            <ChevronDown />
          </span>
        </button>
        {effectiveProvider && <div className="hp-prov">{effectiveProvider}</div>}

        {(contextLabel || caps.tools || caps.vision) && (
          <div className="hp-caps">
            {contextLabel && (
              <span className="hp-ctx">
                <b>{contextLabel}</b>
                <small>{t.chatPanel.context}</small>
              </span>
            )}
            {caps.tools && <span className="hp-tag">{t.chatPanel.tools}</span>}
            {caps.vision && <span className="hp-tag">{t.chatPanel.vision}</span>}
          </div>
        )}

        <div className="hp-sep" />

        {caps.reasoning !== false ? (
          <ReasoningPicker
            currentModel={modelName}
            profile={profile}
            refreshKey={modelRefreshKey}
            onChanged={onEffortChanged}
          />
        ) : (
          <p className="hp-none">{t.chatPanel.noReasoning}</p>
        )}

        {pending && (
          <div className="hp-pend" role="status">
            <p>
              <b>{t.chatPanel.saved}</b>{' '}
              {pending === 'model'
                ? t.chatPanel.pendingModel.replace('{model}', modelLabel)
                : t.chatPanel.pendingEffort}
            </p>
            <div className="hp-acts">
              <button
                type="button"
                className="hp-btn pri"
                onClick={() => {
                  onDismissPending()
                  onApplyNow?.()
                }}
              >
                {t.chatPanel.applyNow}
              </button>
              <button type="button" className="hp-btn ghost" onClick={onDismissPending}>
                {t.chatPanel.later}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * PanelAlert — the panel-level notice: a sidecar/feed failure (with Reconnect,
 * or Reload when the login ticket died) or a missing provider key (with the way
 * to fix it). The chat itself keeps working either way.
 */
function PanelAlert({
  error,
  banner,
  showReload,
  hasCredential,
  onReconnect,
  onAddKey,
  onSwitchModel
}: {
  error: string | null
  banner: string
  showReload: boolean
  hasCredential: boolean
  onReconnect: () => void
  onAddKey: () => void
  onSwitchModel: () => void
}) {
  const { t } = useI18n()

  return (
    <div className={cn('hp-shell', error ? 'err' : 'warn')} role="alert">
      <div className={cn('hp-core hp-alert', !error && 'warn')}>
        {error ? <AlertCircle /> : <KeyRound />}
        <div className="min-w-0">
          <p className="wrap-break-word">
            <b>{banner}</b>
          </p>
          {error && (
            <div className="hp-acts">
              {showReload ? (
                <button type="button" className="hp-btn" onClick={() => window.location.reload()}>
                  <RefreshCw />
                  {t.chatPanel.reloadPage}
                </button>
              ) : (
                <button type="button" className="hp-btn" onClick={onReconnect}>
                  <RefreshCw />
                  {t.chatPanel.reconnectPanel}
                </button>
              )}
            </div>
          )}
          {!error && hasCredential && (
            <div className="hp-acts">
              <button
                type="button"
                className="hp-btn pri"
                // Router navigation: a full page load would tear down the
                // xterm scrollback and the chat sockets.
                onClick={onAddKey}
              >
                <KeyRound />
                {t.chatPanel.addKey}
              </button>
              <button type="button" className="hp-btn" onClick={onSwitchModel}>
                {t.chatPanel.switchModel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
