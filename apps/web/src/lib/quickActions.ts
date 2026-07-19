import * as React from "react";
import { revealChat, sendChatCommand } from "@/features/chat/controller";

/**
 * What one-tap chat actions (the digest's "Draft reply" / "Ask about this"
 * buttons) do with their composed message: send it right away, or prefill
 * the composer so the user can edit it first.
 */
export type QuickActionMode = "send" | "prefill";

const STORAGE_KEY = "trailin-quick-action-mode";

function getQuickActionMode(): QuickActionMode {
  if (typeof window === "undefined") return "send";
  return localStorage.getItem(STORAGE_KEY) === "prefill" ? "prefill" : "send";
}

/** Hand a composed message to the chat panel, honoring the Settings preference. */
export function dispatchQuickAction(text: string): void {
  sendChatCommand({ kind: getQuickActionMode() === "prefill" ? "prefill" : "send", text });
  revealChat();
}

export function useQuickActionMode() {
  const [mode, setMode] = React.useState<QuickActionMode>(getQuickActionMode);

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return [mode, setMode] as const;
}

/**
 * Navigates to the Chat tab and opens a specific run's conversation —
 * shared by every run card that offers a "go to chat" action (Home's
 * activity feed, its briefing hero, and the Automations run list). The
 * command lands on the persistent ChatPanel instance directly, so there is
 * no mount race to bridge.
 */
export function openRunInChat(runId: string, goToChat: () => void): void {
  openConversationInChat(runId, goToChat);
}

/** Navigate to Chat and open a conversation by id (a run id is one) — used by todo provenance links. */
export function openConversationInChat(conversationId: string, goToChat: () => void): void {
  goToChat();
  sendChatCommand({ kind: "open", conversationId });
}
