/**
 * ChatSidePanel — shared pieces of the Chat side panel that sit outside
 * ChatSidebar/ChatSessionList (design `design/hermes-side-panel.dc.html`):
 *
 *  - `PanelHeader`: the profile line + collapse/close button above the two
 *    glass pieces (frames 1-2, marker 1).
 *  - `PanelRail`: the 56 px HUD the panel collapses to (frame 3) — the /vivo
 *    "Visual mode" idea: model, reasoning level and "New chat" stay at hand
 *    while the terminal takes the width. Replaces the old floating "panel"
 *    button that was painted over the terminal.
 *
 * The rail reads model + effort over REST (`/api/model/info`, `/api/config`)
 * — no sidecar WS of its own; the connection dot is the last state ChatSidebar
 * reported before collapsing.
 */

import { History, PanelRightOpen, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import type { ConnectionState } from "@/lib/gatewayClient";
import { EFFORT_OPTIONS, normalizeEffort } from "@/lib/reasoning-effort";
import { cn } from "@/lib/utils";

/** Monogram for the rail: initial of the first segment + the first digit run
 *  of the id (`qwen38-flash-next` → Q38, `gpt-6.2-sol` → G6.2); no digits →
 *  first two letters (`or-glm` → OR). Pure, tested. */
export function modelMonogram(modelId: string): string {
  const first = modelId.split(/[-_/]/)[0] ?? "";
  const initial = (first[0] ?? "").toUpperCase();
  const digits = /\d+(?:\.\d+)?/.exec(modelId);
  if (digits) return `${initial}${digits[0]}`;
  return (first.slice(0, 2) || "?").toUpperCase();
}

/** Model + effort for the collapsed rail, re-read when it becomes visible or
 *  `refreshKey` bumps (the rail's own picker saved a model). */
export function useRailModel(profile: string | undefined, active: boolean, refreshKey = 0) {
  const [model, setModel] = useState("");
  const [effortIndex, setEffortIndex] = useState(-1);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api
      .getModelInfo(profile)
      .then((r) => {
        if (cancelled || !r?.model) return;
        setModel(String(r.model));
        void api
          .getConfig(profile)
          .then((cfg) => {
            if (cancelled) return;
            const agent = (cfg?.agent as Record<string, unknown> | undefined) ?? {};
            const effort = normalizeEffort(agent.reasoning_effort);
            setEffortIndex(EFFORT_OPTIONS.findIndex((o) => o.value === effort));
          })
          .catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile, active, refreshKey]);

  return { model, effortIndex };
}

export function PanelHeader({
  profile,
  narrow,
  onToggle,
}: {
  profile?: string;
  narrow: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="hp-top">
      <div>
        <b>{profile || "main"}</b>
        <span>{t.chatPanel.profileOfChat}</span>
      </div>
      <button
        type="button"
        className="hp-ib"
        onClick={onToggle}
        aria-label={narrow ? t.app.closeModelTools : t.chatPanel.collapse}
        title={t.chatPanel.collapse}
      >
        <PanelRightOpen />
      </button>
    </div>
  );
}

export function PanelRail({
  profile,
  connState,
  model,
  effortIndex,
  onExpand,
  onOpenSessions,
  onNewChat,
  onModelApplied,
}: {
  profile?: string;
  connState: ConnectionState;
  model: string;
  effortIndex: number;
  onExpand: () => void;
  onOpenSessions: () => void;
  onNewChat: () => void;
  /** Refresh signal after the rail's own picker saves (same REST path as the
   *  panel's — the running chat adopts the model on the next fresh session). */
  onModelApplied: () => void;
}) {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const conn =
    connState === "open"
      ? { cls: "", label: t.chatPanel.conn.live }
      : connState === "connecting"
        ? { cls: "warn", label: t.chatPanel.conn.connecting }
        : { cls: "err", label: t.chatPanel.conn.offline };
  const effortLabel =
    effortIndex >= 0
      ? t.chatPanel.effort[
          (EFFORT_OPTIONS[effortIndex]?.value ?? "medium") as keyof typeof t.chatPanel.effort
        ]
      : "";

  return (
    <aside className="hp-rail" role="complementary" aria-label={t.app.modelToolsSheetTitle}>
      <div className="hp-shell">
        <div className="hp-core">
          <button
            type="button"
            className="hp-ib"
            onClick={onExpand}
            aria-label={t.chatPanel.expand}
            title={t.chatPanel.expand}
          >
            <PanelRightOpen />
          </button>
          <span className={cn("hp-live", conn.cls)} role="status" aria-label={conn.label} title={conn.label}>
            <i />
          </span>
          <button
            type="button"
            className="hp-mono"
            onClick={() => setPickerOpen(true)}
            aria-label={t.chatPanel.railModelLabel
              .replace("{model}", model || "—")
              .replace("{effort}", effortLabel)}
            title={`${model}${effortLabel ? ` · ${effortLabel}` : ""}`}
          >
            {model ? modelMonogram(model) : "—"}
          </button>
          {effortIndex >= 0 && (
            <span className="hp-vm" aria-hidden="true">
              {EFFORT_OPTIONS.map((opt, i) => (
                <i key={opt.value} className={i <= effortIndex ? "on" : undefined} />
              ))}
            </span>
          )}
          <span className="hp-rsep" aria-hidden="true" />
          <button
            type="button"
            className="hp-rcta"
            onClick={onNewChat}
            aria-label={t.sessions.newChat}
            title={t.sessions.newChat}
          >
            <Plus />
          </button>
          <button
            type="button"
            className="hp-ib"
            onClick={onOpenSessions}
            aria-label={t.sessions.title}
            title={t.sessions.title}
          >
            <History />
          </button>
        </div>
      </div>

      {pickerOpen && (
        <ModelPickerDialog
          loader={() => api.getModelOptions(profile)}
          alwaysGlobal
          onApply={async ({ provider, model: next, confirmExpensiveModel }) => {
            const result = await api.setModelAssignment(
              { confirm_expensive_model: confirmExpensiveModel, scope: "main", provider, model: next },
              profile,
            );
            if (!result.confirm_required) onModelApplied();
            return result;
          }}
          onClose={() => {
            setPickerOpen(false);
            onModelApplied();
          }}
        />
      )}
    </aside>
  );
}
