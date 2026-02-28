// ─── Session View Types (message-based, mirrors pi-mono) ────────────────────

import type { AgentAssistantMessage, AgentToolResultMessage } from "@zero/core";

// Re-export for convenience
export type { AgentAssistantMessage, AgentToolResultMessage } from "@zero/core";

/**
 * User message for display. Stored separately from agent messages
 * because they arrive via SessionDO user events (not the agent stream)
 * and carry UI-only metadata like template info.
 */
export interface UserMessageDisplay {
  role: "user";
  text: string;
  template?: { slug: string; name: string };
}

/**
 * All message types that appear in the session view.
 * Rendered in order: user bubbles, assistant blocks (with inline tool
 * results paired by ID), toolResult messages skipped (rendered inline).
 */
export type DisplayMessage = UserMessageDisplay | AgentAssistantMessage | AgentToolResultMessage;

/**
 * Session view state — the single source of truth for rendering.
 *
 * - messages: completed messages (user, assistant, toolResult)
 * - streamingMessage: the currently-streaming assistant message (null when idle/replay)
 * - pendingToolCalls: tool call IDs currently being executed
 */
export interface SessionViewState {
  messages: DisplayMessage[];
  streamingMessage: AgentAssistantMessage | null;
  pendingToolCalls: Set<string>;
}

export function emptyViewState(): SessionViewState {
  return {
    messages: [],
    streamingMessage: null,
    pendingToolCalls: new Set(),
  };
}

export type { SessionStatus } from "@zero/core";

/**
 * Build a map of tool results by tool call ID for inline pairing.
 * Used at render time to pair tool calls in assistant messages with their results.
 */
export function buildToolResultsMap(
  messages: DisplayMessage[],
): Map<string, AgentToolResultMessage> {
  const map = new Map<string, AgentToolResultMessage>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      map.set(msg.toolCallId, msg);
    }
  }
  return map;
}
