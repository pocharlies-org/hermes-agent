/**
 * ChatSessionList — the SessionsCard of the dashboard Chat side panel
 * (design `design/hermes-side-panel.dc.html`, frames 1-2): the most recent
 * sessions for the active profile, grouped by last activity (Now / Today /
 * Yesterday / This week / Earlier) with sticky group headers, so with 30 rows
 * orienting by time beats reading clocks.
 *
 * Selecting a row sets `/chat?resume=<id>`; ChatPage treats the resume target
 * as part of the PTY identity, so the change tears down the current terminal
 * child and respawns it resuming that conversation (see ChatPage.tsx). The
 * "New chat" action calls ChatPage's `startFreshDashboardChat`.
 *
 * Best-effort, like ChatSidebar: a failed fetch surfaces an inline error with
 * a retry affordance and the terminal pane keeps working. Delete, rename and
 * export live on the Sessions page — this card only switches and starts.
 */

import {
  ArrowUpRight,
  Clock,
  Globe,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  Webhook,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useI18n } from "@/i18n";
import { api, type SessionInfo } from "@/lib/api";
import { relativeTime, sessionGroup, type SessionGroupId } from "@/lib/chat-panel";
import { cn } from "@/lib/utils";

const SESSION_LIMIT = 30;

interface ChatSessionListProps {
  /** Active resume target (the session currently shown in the terminal). */
  activeSessionId: string | null;
  /** Management profile from the dashboard switcher — scopes the listing. */
  profile?: string;
  className?: string;
  /** Optional callback fired after a row is picked (e.g. close mobile sheet). */
  onPicked?: () => void;
  /**
   * Starts a fresh chat. ChatPage supplies its `startFreshDashboardChat`,
   * which clears `?resume` AND bumps the reconnect nonce so a brand-new PTY
   * spawns even when the user is already on an unsaved fresh session.
   */
  onNewChat?: () => void;
}

const GROUP_ORDER: SessionGroupId[] = ["now", "today", "yesterday", "week", "before"];

function rowLabel(session: SessionInfo, untitled: string): { text: string; preview: boolean } {
  const title = session.title?.trim();
  if (title && title !== "Untitled") return { text: title, preview: false };
  const preview = session.preview?.trim();
  if (preview) return { text: preview, preview: true };
  return { text: untitled, preview: true };
}

function SourceIcon({ source }: { source: string }) {
  const icon =
    source === "telegram" ? Send :
    source === "whatsapp" ? MessageCircle :
    source === "cli" ? Terminal :
    source === "api" || source === "api_server" ? Globe :
    source === "webhook" ? Webhook :
    source === "cron" ? Clock :
    null;
  if (!icon) return <span>{source}</span>;
  const Icon = icon;
  return (
    <span className="src">
      <Icon />
      {source}
    </span>
  );
}

export function ChatSessionList({
  activeSessionId,
  profile,
  className,
  onPicked,
  onNewChat,
}: ChatSessionListProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to force a refetch (after switching, on Refresh, on mount).
  const [reloadNonce, setReloadNonce] = useState(0);

  // `profile` is read inside the fetch; it's part of the scope key so a
  // profile switch refetches. The empty-string fallback keeps the dep
  // stable when no profile is selected (default profile).
  const scopeKey = profile ?? "";

  // Monotonic request token: only the most recent fetch is allowed to
  // commit state, so a fast profile switch (or Refresh spam) can't land a
  // stale list out of order.
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    api
      .getSessions(SESSION_LIMIT, 0, scopeKey, "recent")
      .then((res) => {
        if (reqRef.current !== myReq) return;
        setSessions(res.sessions);
      })
      .catch((e: Error) => {
        if (reqRef.current !== myReq) return;
        setError(e.message || "failed to load sessions");
      })
      .finally(() => {
        if (reqRef.current === myReq) setLoading(false);
      });
  }, [scopeKey]);

  useEffect(() => {
    // Dashboard data surfaces fetch from an effect on mount + scope change;
    // keep this local and explicit until the shared lint profile is updated
    // for async loaders (matches FilesPage).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // `reloadNonce` is a manual refetch trigger (Refresh button / row pick).
  }, [load, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // Picking a row sets `/chat?resume=<id>`. Re-picking the row already in
  // the terminal is a no-op (avoids a needless PTY teardown).
  const pick = useCallback(
    (id: string) => {
      onPicked?.();
      if (id === activeSessionId) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("resume", id);
          return next;
        },
        { replace: false },
      );
    },
    [activeSessionId, onPicked, setSearchParams],
  );

  const startNew = useCallback(() => {
    onPicked?.();
    if (onNewChat) {
      onNewChat();
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("resume");
        return next;
      },
      { replace: false },
    );
  }, [onNewChat, onPicked, setSearchParams]);

  const groups = useMemo(() => {
    if (!sessions) return null;
    const buckets = new Map<SessionGroupId, SessionInfo[]>();
    for (const s of sessions) {
      const g = sessionGroup(s);
      const list = buckets.get(g);
      if (list) list.push(s);
      else buckets.set(g, [s]);
    }
    // Newest first inside each group (the API already sorts by recency;
    // sort defensively so the grouping never shows a stale-first list).
    return GROUP_ORDER.flatMap((id) => {
      const items = buckets.get(id);
      if (!items?.length) return [];
      return [{ id, items: [...items].sort((a, b) => b.last_active - a.last_active) }];
    });
  }, [sessions]);

  let body: React.ReactNode;
  if (loading && sessions === null) {
    body = (
      <div className="hp-list" aria-busy="true" aria-label={t.common.loading}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="hp-sk-row">
            <span />
            <span>
              <span className="hp-sk" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
              <span className="hp-sk" style={{ width: "46%", height: 7, marginTop: 7 }} />
            </span>
            <span className="hp-sk" style={{ width: 30, height: 7 }} />
          </div>
        ))}
      </div>
    );
  } else if (error) {
    body = (
      <div className="hp-empty">
        <b>{t.chatPanel.listError}</b>
        <p>{error}</p>
        <div className="hp-acts">
          <button type="button" className="hp-btn" onClick={reload}>
            <RefreshCw />
            {t.common.retry}
          </button>
        </div>
      </div>
    );
  } else if (!groups?.length) {
    body = (
      <div className="hp-empty">
        <b>{t.chatPanel.emptyProfile.replace("{profile}", scopeKey || "main")}</b>
      </div>
    );
  } else {
    body = (
      <div className="hp-list">
        {groups.map((g) => (
          <div key={g.id}>
            <div className="hp-grp">{t.chatPanel.groups[g.id]}</div>
            {g.items.map((s) => {
              const label = rowLabel(s, t.sessions.untitledSession);
              const isActive = s.id === activeSessionId;
              return (
                <button
                  key={s.id}
                  type="button"
                  className="hp-row"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => pick(s.id)}
                >
                  <span className="st">{s.is_active ? <i /> : null}</span>
                  <span className="b">
                    <span className={cn("t", label.preview && "pv")}>{label.text}</span>
                    <span className="m">
                      {s.source && <SourceIcon source={s.source} />}
                      {s.message_count > 0 && (
                        <span>
                          {s.message_count} {t.chatPanel.msgs}
                        </span>
                      )}
                      {s.tool_call_count > 0 && (
                        <span>{t.chatPanel.toolCalls.replace("{n}", String(s.tool_call_count))}</span>
                      )}
                    </span>
                  </span>
                  <span className="r">{relativeTime(s.last_active, t)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("hp-shell hp-ses w-full min-w-0", className)}>
      <div className="hp-core">
        <div className="hp-ses-h">
          <div>
            <b>{t.sessions.title}</b>
            {sessions && <em>{sessions.length}</em>}
          </div>
          <button
            type="button"
            className={cn("hp-ib", loading && "spin")}
            onClick={reload}
            aria-label={t.common.refresh}
            aria-busy={loading || undefined}
            title={t.common.refresh}
          >
            <RefreshCw />
          </button>
        </div>

        <div className="hp-ses-cta">
          <button type="button" className="hp-cta" onClick={startNew}>
            {t.sessions.newChat}
            <i>
              <Plus />
            </i>
          </button>
        </div>

        {body}

        {groups?.length ? (
          <button type="button" className="hp-all" onClick={() => navigate("/sessions")}>
            {t.chatPanel.allSessions}
            <ArrowUpRight />
          </button>
        ) : null}
      </div>
    </div>
  );
}
