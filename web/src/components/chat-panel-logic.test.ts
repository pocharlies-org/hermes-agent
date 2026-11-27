/**
 * Pure logic of the Chat side panel redesign (design/hermes-side-panel.dc.html):
 * session grouping by last activity, localized relative time, and the rail's
 * model monogram. Node-environment vitest, no DOM.
 */
import { describe, expect, it } from "vitest";

import { modelMonogram } from "./ChatSidePanel";
import { relativeTime, sessionGroup } from "@/lib/chat-panel";
import { en } from "@/i18n/en";

const HOUR = 3600;
const DAY = 86_400;

// Fixed "now": 2026-11-26 15:00 local.
const NOW_MS = new Date(2026, 10, 26, 15, 0, 0).getTime();

describe("sessionGroup", () => {
  it("puts active sessions in Now regardless of age", () => {
    expect(sessionGroup({ is_active: true, last_active: NOW_MS / 1000 - 30 * DAY }, NOW_MS)).toBe("now");
  });
  it("groups by local day boundaries", () => {
    expect(sessionGroup({ is_active: false, last_active: NOW_MS / 1000 - 2 * HOUR }, NOW_MS)).toBe("today");
    expect(sessionGroup({ is_active: false, last_active: NOW_MS / 1000 - 20 * HOUR }, NOW_MS)).toBe("yesterday");
    expect(sessionGroup({ is_active: false, last_active: NOW_MS / 1000 - 3 * DAY }, NOW_MS)).toBe("week");
    expect(sessionGroup({ is_active: false, last_active: NOW_MS / 1000 - 30 * DAY }, NOW_MS)).toBe("before");
  });
});

describe("relativeTime", () => {
  const t = en;
  it("uses localized units", () => {
    expect(relativeTime(NOW_MS / 1000 - 30, t, NOW_MS)).toBe(t.chatPanel.time.now);
    expect(relativeTime(NOW_MS / 1000 - 5 * 60, t, NOW_MS)).toBe("5 min");
    expect(relativeTime(NOW_MS / 1000 - 3 * HOUR, t, NOW_MS)).toBe("3 h");
    expect(relativeTime(NOW_MS / 1000 - 2 * DAY, t, NOW_MS)).toBe("2 d");
  });
});

describe("modelMonogram", () => {
  it("takes the first initial plus the first digit run", () => {
    expect(modelMonogram("qwen38-flash-next")).toBe("Q38");
    expect(modelMonogram("gpt-6.2-sol")).toBe("G6.2");
    expect(modelMonogram("anthropic-haiku-5-5")).toBe("A5");
  });
  it("falls back to two letters when the id has no digits", () => {
    expect(modelMonogram("or-glm")).toBe("OR");
  });
});
