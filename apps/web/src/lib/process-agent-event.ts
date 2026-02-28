import type { AgentEvent } from "@zero/core";
import type { SessionViewState, UserMessageDisplay } from "./session-types";

// ─── Event Processing ───────────────────────────────────────────────────────

/**
 * Process an incoming agent event and return a new view state.
 * Pure function — safe to call from React state updaters.
 *
 * This is dramatically simpler than the old turns/blocks model because:
 * - message_update carries the full accumulated partial (no delta assembly)
 * - message_end carries the complete message (no replay reconstruction)
 * - Tool results are paired by ID at render time (no adjacency matching)
 *
 * Works identically for live streaming and replay:
 * - Live: message_update → streamingMessage, message_end → append to messages
 * - Replay: message_update is ephemeral (absent), message_end → append directly
 */
export function processAgentEvent(
  state: SessionViewState,
  event: AgentEvent,
): SessionViewState {
  switch (event.type) {
    // ── Structural markers (no state change) ────────────────────────
    case "agent_start":
    case "turn_start":
    case "status":
      return state;

    // ── Message lifecycle ───────────────────────────────────────────
    case "message_start":
      // No state change — wait for content via message_update or message_end
      return state;

    case "message_update":
      // The partial message has accumulated content (text, thinking, toolCall).
      // Just store it as the streaming message — render directly.
      return { ...state, streamingMessage: event.message };

    case "message_end": {
      // Skip user messages — they arrive separately via SessionDO user events
      if (event.message.role === "user") return state;

      // Append the complete message. Clear streamingMessage if this was
      // the assistant message we were streaming.
      return {
        ...state,
        messages: [...state.messages, event.message],
        streamingMessage:
          event.message.role === "assistant" ? null : state.streamingMessage,
      };
    }

    // ── Tool execution ──────────────────────────────────────────────
    case "tool_execution_start": {
      const pending = new Set(state.pendingToolCalls);
      pending.add(event.toolCallId);
      return { ...state, pendingToolCalls: pending };
    }

    case "tool_execution_end": {
      const pending = new Set(state.pendingToolCalls);
      pending.delete(event.toolCallId);
      return { ...state, pendingToolCalls: pending };
    }

    // ── Turn / agent end ────────────────────────────────────────────
    case "turn_end":
      return state;

    case "agent_end":
      return {
        ...state,
        streamingMessage: null,
        pendingToolCalls: new Set(),
      };

    default: {
      const unknownEvent = event as { type: string };
      console.warn(
        `[processAgentEvent] Unhandled event type: "${unknownEvent.type}"`,
        event,
      );
      return state;
    }
  }
}

/**
 * Add a user message to the view state.
 * Called for SessionDO "user" events (source: "user"), not agent events.
 */
export function addUserMessage(
  state: SessionViewState,
  text: string,
  template?: { slug: string; name: string },
): SessionViewState {
  const userMessage: UserMessageDisplay = template
    ? { role: "user", text, template }
    : { role: "user", text };

  return {
    ...state,
    messages: [...state.messages, userMessage],
  };
}
