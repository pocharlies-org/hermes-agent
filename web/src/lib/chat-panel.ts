/**
 * Pure helpers of the Chat side panel (design `design/hermes-side-panel.dc.html`):
 * session grouping by last activity and localized relative time. Kept in a
 * non-component module so `Date.now()` defaults are not called in render
 * (react-hooks/purity), same pattern as `timeAgo` in `lib/utils`.
 */

import type { Translations } from "@/i18n/types";

export type SessionGroupId = "now" | "today" | "yesterday" | "week" | "before";

/** Group a session by last activity, local-day boundaries. Pure, tested. */
export function sessionGroup(
  session: { is_active: boolean; last_active: number },
  nowMs: number = Date.now(),
): SessionGroupId {
  if (session.is_active) return "now";
  const now = new Date(nowMs);
  const then = new Date(session.last_active * 1000);
  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (nowMs / 1000 - session.last_active < 7 * 86_400) return "week";
  return "before";
}

/** Relative time with localized units from `t.chatPanel.time`. Pure, tested. */
export function relativeTime(
  ts: number,
  t: Translations,
  nowMs: number = Date.now(),
): string {
  const delta = Math.max(0, nowMs / 1000 - ts);
  if (delta < 60) return t.chatPanel.time.now;
  if (delta < 3600) return t.chatPanel.time.min.replace("{n}", String(Math.floor(delta / 60)));
  if (delta < 86_400) return t.chatPanel.time.hours.replace("{n}", String(Math.floor(delta / 3600)));
  if (delta < 172_800) return t.chatPanel.time.yesterday;
  return t.chatPanel.time.days.replace("{n}", String(Math.floor(delta / 86_400)));
}
