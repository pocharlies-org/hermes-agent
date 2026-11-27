/**
 * ReasoningPicker — sets the main model's reasoning effort from the dashboard
 * Chat side panel as an eight-step slider (off → ultra), mirroring the design
 * in `design/hermes-side-panel.dc.html` (frame 1, marker 5).
 *
 * Storage is unchanged: the effort persists to config.yaml at
 * `agent.reasoning_effort` (the same key the TUI's `/reasoning <level>`
 * command writes) via the sparse `saveConfig` patch. Click, drag, arrows,
 * Home/End; the save fires on release (pointerup / key). The running chat
 * adopts the change on the next fresh session — the parent surfaces that as
 * the PendingApplyBand, not a modal.
 *
 * Profile scoping: the panel passes the chat profile explicitly, so this
 * reads/writes the same config the chat PTY was launched from.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/i18n";
import { api } from "@/lib/api";
import {
  EFFORT_OPTIONS,
  normalizeEffort,
  VALID_EFFORTS,
} from "@/lib/reasoning-effort";
import { cn } from "@/lib/utils";

interface ReasoningPickerProps {
  /** Current model string from config — re-reads the saved effort when it
   *  changes (a different model may have been selected). */
  currentModel: string;
  /** Profile whose config should be read/written. */
  profile?: string;
  /** Bumped after the model picker saves, to re-read config in lockstep. */
  refreshKey?: number;
  /** Called after a successful change so the panel can show the
   *  "applies on the next chat" band, matching the model-switch UX. */
  onChanged?: (effort: string) => void;
  /** Render the axis labels in the panel header row instead (unused here). */
  disabled?: boolean;
}

const MAX = EFFORT_OPTIONS.length - 1; // 7 — eight steps, off → ultra

export function ReasoningPicker({
  currentModel,
  profile,
  refreshKey = 0,
  onChanged,
  disabled = false,
}: ReasoningPickerProps) {
  const { t } = useI18n();
  const [effort, setEffort] = useState("medium");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastFetchKeyRef = useRef("");
  const dragRef = useRef(false);
  // Drag sets `effort` for the visuals; the value to persist on release lives
  // in a ref so the pointerup handler (same render as the pointerdown) sees it.
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    const fetchKey = `${profile ?? ""}:${currentModel}:${refreshKey}`;
    if (fetchKey === lastFetchKeyRef.current) return;
    lastFetchKeyRef.current = fetchKey;
    void api
      .getConfig(profile)
      .then((cfg) => {
        const agent = (cfg?.agent as Record<string, unknown> | undefined) ?? {};
        setEffort(normalizeEffort(agent.reasoning_effort));
        setLoaded(true);
      })
      .catch(() => {
        // Best-effort: keep the last known value rather than blanking it.
        setLoaded(true);
      });
  }, [currentModel, profile, refreshKey]);

  const commit = useCallback(
    (next: string) => {
      if (!VALID_EFFORTS.has(next) || next === effort) return;
      const prev = effort;
      setEffort(next); // optimistic
      setFailed(false);
      setSaving(true);
      // Sparse patch: PUT /api/config deep-merges onto disk, so sending only
      // the edited key never clobbers sibling keys.
      void api
        .saveConfig({ agent: { reasoning_effort: next } }, profile)
        .then(() => {
          onChanged?.(next);
        })
        .catch(() => {
          setEffort(prev); // revert on failure
          setFailed(true);
        })
        .finally(() => setSaving(false));
    },
    [effort, onChanged, profile],
  );

  const index = Math.max(
    0,
    EFFORT_OPTIONS.findIndex((o) => o.value === effort),
  );
  const label = t.chatPanel.effort[
    (EFFORT_OPTIONS[index]?.value ?? "medium") as keyof typeof t.chatPanel.effort
  ];

  const valueFromEvent = (clientX: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    const ratio = (clientX - r.left - 7) / Math.max(1, r.width - 14);
    return Math.min(MAX, Math.max(0, Math.round(ratio * MAX)));
  };

  return (
    <div className="hp-effw">
      <div className="hp-eff-h">
        <span className="hp-k">{t.chatPanel.reasoning}</span>
        <b>{saving ? `${label} · ${t.chatPanel.saving}` : label}</b>
      </div>
      <div
        className={cn("hp-eff", saving && "saving")}
        role="slider"
        tabIndex={disabled || !loaded ? -1 : 0}
        aria-label={t.chatPanel.reasoning}
        aria-disabled={disabled || !loaded}
        aria-valuemin={0}
        aria-valuemax={MAX}
        aria-valuenow={index}
        aria-valuetext={label}
        style={{ "--v": index } as React.CSSProperties}
        onPointerDown={(e) => {
          if (disabled || !loaded) return;
          dragRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const next = EFFORT_OPTIONS[valueFromEvent(e.clientX, e.currentTarget)];
          if (next) {
            setEffort(next.value);
            pendingRef.current = next.value;
          }
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const next = EFFORT_OPTIONS[valueFromEvent(e.clientX, e.currentTarget)];
          if (next) {
            setEffort(next.value);
            pendingRef.current = next.value;
          }
        }}
        onPointerUp={() => {
          if (!dragRef.current) return;
          dragRef.current = false;
          const pending = pendingRef.current;
          pendingRef.current = null;
          if (pending) commit(pending);
        }}
        onKeyDown={(e) => {
          if (disabled || !loaded) return;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            commit(EFFORT_OPTIONS[Math.min(MAX, index + 1)].value);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            commit(EFFORT_OPTIONS[Math.max(0, index - 1)].value);
          } else if (e.key === "Home") {
            e.preventDefault();
            commit(EFFORT_OPTIONS[0].value);
          } else if (e.key === "End") {
            e.preventDefault();
            commit(EFFORT_OPTIONS[MAX].value);
          }
        }}
      >
        <div className="hp-eff-rail">
          <i className="hp-eff-fill" />
        </div>
        <div className="hp-eff-ticks">
          {EFFORT_OPTIONS.map((opt, i) => (
            <i key={opt.value} className={i <= index ? "on" : undefined} />
          ))}
        </div>
        <div className="hp-eff-thumb" />
      </div>
      <div className="hp-eff-ax">
        <span>{t.chatPanel.effortAxisOff}</span>
        <span>{t.chatPanel.effortAxisUltra}</span>
      </div>
      {failed && <p className="hp-none">{t.chatPanel.notSaved}</p>}
    </div>
  );
}
