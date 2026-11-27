/**
 * ChatSidebar — structured-events panel that sits next to the xterm.js
 * terminal in the dashboard Chat tab.
 *
 * Two WebSockets, one per concern:
 *
 *   1. **JSON-RPC sidecar** (`GatewayClient` → /api/ws) — a lightweight
 *      session used only for connection state (the "live" badge) and
 *      credential warnings. Independent of the PTY pane's session by
 *      design. The model badge does NOT come from here: it reads the
 *      effective config model over REST (`/api/model/info`), and the model
 *      picker writes config over REST (`/api/model/set`) then offers
 *      "Apply now" (a fresh chat) so the running chat adopts the new model.
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

  const [state, setState] = useState<ConnectionState>('idle')
  const [info, setInfo] = useState<SessionInfo>({})
  const [modelOpen, setModelOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The badge shows config.yaml's main model (`model.default`) via
  // `/api/model/info` — the same value the Models page writes and a new chat
  // session boots from. We deliberately don't use the sidecar's `session.info`
  // model: that's a one-time snapshot of the throwaway sidecar agent taken when
  // its session is created, and it never updates when the model is changed
  // elsewhere, so the badge would go stale. Pass the chat profile explicitly so
  // this card stays scoped to the PTY even if the global dashboard switcher
  // changes while the chat is open.
  const [effectiveModel, setEffectiveModel] = useState('')
  const [effectiveProvider, setEffectiveProvider] = useState('')
  // Capabilities for the ModelCard's strip (context, tools, vision) and the
  // gate on the ReasoningPicker. From `/api/model/info`.
  // `reasoning` is null when the backend doesn't report it (`capabilities: {}`
  // for litellm routes): unknown means SHOW the slider — the old UI always
  // did, and hiding it on absent data regressed effort control entirely.
  const [caps, setCaps] = useState<{ context: number; tools: boolean; vision: boolean; reasoning: boolean | null }>({
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
      offState()
      offSessionInfo()
      offError()
      gw.close()
    }
    // `profile` is read from render; scope changes bump `version` → redial.
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
        attempt = 0
        clearEventsBanner()
      }
    })

    const offSessionInfo = feed.on('session.info', ev => {
      const title = titleFromSessionInfoPayload(ev.payload)
      if (title !== undefined) {
        onSessionTitleChange?.(title)
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

  // The picker writes config.yaml over REST — it doesn't ride the sidecar
  // gateway session, so it's available whenever the sidebar is mounted.
  const modelName = effectiveModel || info.model || '—'
  const modelLabel = modelName.split('/').slice(-1)[0] ?? '—'
  const credential = credentialWarning(info.credential_warning)
  const banner = error ?? credential?.message ?? null
  const showReload = isEventsAuthRejectionMessage(error)
  const conn =
    state === 'open'
      ? { cls: '', label: t.chatPanel.conn.live }
      : state === 'connecting'
        ? { cls: 'warn', label: t.chatPanel.conn.connecting }
        : state === 'idle'
          ? { cls: 'warn', label: t.chatPanel.conn.idle }
          : { cls: 'err', label: t.chatPanel.conn.offline }
  const contextLabel =
    caps.context >= 1024 ? `${Math.round(caps.context / 1024)} k` : caps.context > 0 ? String(caps.context) : ''

  return (
    <div className={cn('hp w-full min-w-0', className)}>
      {/* ModelCard — name opens the picker, capabilities and the effort
          slider live under it; a just-saved change shows the PendingApplyBand
          inside the card instead of a dialog. */}
      <div className="hp-shell">
        <div className="hp-core hp-model">
          <div className="hp-r1">
            <span className="hp-k">{t.chatPanel.model}</span>
            <span className={cn('hp-live', conn.cls)} role="status">
              <i />
              {conn.label}
            </span>
          </div>

          <button
            type="button"
            className="hp-pick"
            aria-haspopup="dialog"
            title={modelName === '—' ? t.chatPanel.model : modelName}
            onClick={() => setModelOpen(true)}
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
              onChanged={() => setPending('effort')}
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
                    setPending(null)
                    onApplyNow?.()
                  }}
                >
                  {t.chatPanel.applyNow}
                </button>
                <button type="button" className="hp-btn ghost" onClick={() => setPending(null)}>
                  {t.chatPanel.later}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {banner && (
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
                    <button type="button" className="hp-btn" onClick={reconnect}>
                      <RefreshCw />
                      {t.chatPanel.reconnectPanel}
                    </button>
                  )}
                </div>
              )}
              {!error && credential && (
                <div className="hp-acts">
                  <button
                    type="button"
                    className="hp-btn pri"
                    // Router navigation: a full page load would tear down the
                    // xterm scrollback and the chat sockets.
                    onClick={() => navigate('/env')}
                  >
                    <KeyRound />
                    {t.chatPanel.addKey}
                  </button>
                  <button type="button" className="hp-btn" onClick={() => setModelOpen(true)}>
                    {t.chatPanel.switchModel}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
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
