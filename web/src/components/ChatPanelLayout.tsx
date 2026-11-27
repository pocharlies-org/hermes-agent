/**
 * ChatPanelLayout — where the Chat side panel sits, in its two shapes:
 *
 * - `ChatPanelColumn`: the desktop column next to the terminal (frame 1-2 of
 *   `design/hermes-side-panel.dc.html`).
 * - `ChatPanelSheet`: the phone sheet, portaled to `document.body` so it stacks
 *   above the app sidebar (`z-50`) and mobile chrome (`z-40`) — the main
 *   dashboard column uses `relative z-2`, which traps `position:fixed`
 *   descendants below those layers (see Toast.tsx).
 *
 * Both are the same two cards (model, sessions) behind the same header; the
 * collapse toggle only changes which shape ChatPage asks for.
 */

import { Button } from "@nous-research/ui/ui/components/button";
import { createPortal } from "react-dom";

import { ChatSessionList } from "@/components/ChatSessionList";
import { ChatSidebar } from "@/components/ChatSidebar";
import { PanelHeader } from "@/components/ChatSidePanel";
import { cn } from "@/lib/utils";

interface PanelBodyProps {
  channel: string
  profile?: string
  /** Session the chat is resuming, so the list can mark the current row. */
  activeSessionId: string | null
  isActive: boolean
  workspaceCwd: string
  onWorkspaceChange: (cwd: string) => void
  onNewChat: () => void
  onSessionTitleChange: (title: string | null) => void
  onConnectionState: (state: import("@/lib/gatewayClient").ConnectionState) => void
}

export function ChatPanelColumn({
  label,
  onToggle,
  body,
}: { body: PanelBodyProps; label: string; onToggle: () => void }) {
  return (
    <aside
      id="chat-side-panel"
      role="complementary"
      aria-label={label}
      className="flex min-h-0 w-[328px] shrink-0 flex-col overflow-hidden xl:w-[328px] lg:w-[304px]"
    >
      <PanelHeader profile={body.profile} narrow={false} onToggle={onToggle} />
      <div className="hp min-h-0 flex-1 gap-2.5 overflow-hidden">
        <PanelCards {...body} />
      </div>
    </aside>
  )
}

export function ChatPanelSheet({
  active,
  narrow,
  portalRoot,
  open,
  sheetMode,
  label,
  onClose,
  body,
}: {
  body: PanelBodyProps
  active: boolean
  narrow: boolean
  portalRoot: Element | null
  open: boolean
  sheetMode: boolean
  label: string
  onClose: () => void
}) {
  if (!active || !narrow || !portalRoot) {
    return null
  }

  return createPortal(
    <>
      {open && (
        <Button
          ghost
          aria-label={label}
          onClick={onClose}
          className={cn("fixed inset-0 z-[55] p-0 block", "bg-black/60")}
        />
      )}

      <div
        id="chat-side-panel"
        role={sheetMode ? "dialog" : "complementary"}
        aria-modal={sheetMode || undefined}
        aria-label={label}
        className={cn(
          "fixed z-[60] flex min-w-0 flex-col",
          "bg-background-base/95",
          "transition-transform duration-200 ease-out",
          "[background:color-mix(in_srgb,var(--background-base)_97%,transparent)]",
          sheetMode
            ? cn(
                "hp-sheet inset-x-0 bottom-0 h-[88dvh] p-3 pb-0",
                open ? "translate-y-0" : "pointer-events-none translate-y-full",
              )
            : cn(
                "top-0 right-0 h-dvh max-h-dvh w-[380px] border-l border-current/20 p-3",
                open ? "translate-x-0" : "pointer-events-none translate-x-full",
              ),
        )}
      >
        {sheetMode && <div className="hp-grab" aria-hidden="true" />}
        <PanelHeader profile={body.profile} narrow onToggle={onClose} />
        <div className="hp flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
          <PanelCards onPicked={onClose} {...body} />
        </div>
      </div>
    </>,
    portalRoot,
  )
}

/** The two cards every shape of the panel shows: model (with the effort slider)
 *  above, sessions filling the rest. */
function PanelCards({
  channel,
  profile,
  activeSessionId,
  isActive,
  workspaceCwd,
  onWorkspaceChange,
  onNewChat,
  onSessionTitleChange,
  onConnectionState,
  onPicked,
}: PanelBodyProps & { onPicked?: () => void }) {
  return (
    <>
      <ChatSidebar
        channel={channel}
        profile={profile}
        onDashboardNewSessionRequest={onNewChat}
        onSessionTitleChange={onSessionTitleChange}
        onApplyNow={onNewChat}
        onConnectionState={onConnectionState}
      />
      <ChatSessionList
        className="min-h-0"
        activeSessionId={activeSessionId}
        isActive={isActive}
        profile={profile}
        onPicked={onPicked}
        onNewChat={onNewChat}
        workspaceCwd={workspaceCwd}
        onWorkspaceChange={onWorkspaceChange}
      />
    </>
  )
}
