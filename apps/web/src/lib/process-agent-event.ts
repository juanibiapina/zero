import type { AgentEvent, AgentAssistantMessageEvent, AgentAssistantMessage } from "@zero/core";
import type { Turn, AssistantTurn, ErrorBlock } from "./session-types";

// ─── Error Parsing ──────────────────────────────────────────────────────────

interface ParsedError {
  friendlyMessage?: string;
  isAuthError: boolean;
}

/**
 * Parse errorMessage from pi-ai. Format: "<status_code> <json_body>" or plain string.
 */
function parseErrorMessage(raw: string): ParsedError {
  // Try to split "<status> <json>"
  const spaceIdx = raw.indexOf(" ");
  if (spaceIdx > 0) {
    const jsonPart = raw.slice(spaceIdx + 1);
    try {
      const parsed = JSON.parse(jsonPart) as { error?: { type?: string; message?: string } };
      const errorType = parsed?.error?.type;
      const errorMsg = parsed?.error?.message;
      return {
        friendlyMessage: errorMsg ?? undefined,
        isAuthError: errorType === "authentication_error",
      };
    } catch {
      // Not JSON after status code — fall through
    }
  }
  return { isAuthError: false };
}

/**
 * Build an ErrorBlock from an AssistantMessage that has errorMessage set.
 */
function buildErrorBlock(message: AgentAssistantMessage): ErrorBlock {
  const raw = message.errorMessage ?? "Unknown error";
  const parsed = parseErrorMessage(raw);
  return {
    kind: "error",
    message: raw,
    friendlyMessage: parsed.friendlyMessage,
    isAuthError: parsed.isAuthError,
  };
}

// ─── Event Processing ───────────────────────────────────────────────────────

/**
 * Process an incoming agent event and return a new turns array.
 * Pure function — safe to call from React state updaters.
 *
 * Handles every AgentEvent type exhaustively. Unknown types log a
 * warning so new event types from pi-ai never silently vanish.
 */
export function processAgentEvent(
  event: AgentEvent,
  turns: Turn[]
): Turn[] {
  // Deep-clone turns so mutations (e.g. block.text += delta) are safe
  // under React StrictMode which calls updaters twice.
  const next: Turn[] = turns.map((t) =>
    t.role === "assistant"
      ? { ...t, blocks: t.blocks.map((b) => ({ ...b })) }
      : { ...t }
  );

  const ensureAssistantTurn = (): AssistantTurn => {
    const last = next[next.length - 1];
    if (last && last.role === "assistant") return last;
    const turn: AssistantTurn = { role: "assistant", blocks: [] };
    next.push(turn);
    return turn;
  };

  switch (event.type) {
    // ── Structural markers (no UI effect) ─────────────────────────────
    case "agent_start":
    case "turn_start":
    case "agent_end":
      break;

    // ── Status events (handled separately in SessionPage) ─────────────
    case "status":
      break;

    // ── Message lifecycle ─────────────────────────────────────────────
    case "message_start": {
      // Ignore user message echoes — already added locally in handleSend
      // ToolResult messages are also represented via tool_execution_end
      break;
    }

    case "message_update": {
      processAssistantMessageEvent(event.assistantMessageEvent, ensureAssistantTurn);
      break;
    }

    case "message_end": {
      // Check for error on the completed message
      if (event.message.role === "assistant" && event.message.errorMessage) {
        const turn = ensureAssistantTurn();
        turn.blocks.push(buildErrorBlock(event.message));
      }
      break;
    }

    // ── Tool execution ────────────────────────────────────────────────
    case "tool_execution_start": {
      const turn = ensureAssistantTurn();
      const last = turn.blocks[turn.blocks.length - 1];
      if (last?.kind === "toolcall" && !last.name && event.toolName) {
        last.name = event.toolName;
      }
      break;
    }

    case "tool_execution_end": {
      const turn = ensureAssistantTurn();
      const result = event.result;
      let content = "";
      if (typeof result === "string") {
        content = result;
      } else if (result && typeof result === "object" && "content" in result) {
        const parts = (result as { content: Array<{ type: string; text?: string }> }).content;
        content = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
      turn.blocks.push({
        kind: "toolresult",
        toolName: event.toolName ?? "",
        content,
        isError: event.isError ?? false,
      });
      break;
    }

    // ── Turn end — carries final assistant message (may have error) ───
    case "turn_end": {
      if (event.message.errorMessage) {
        const turn = ensureAssistantTurn();
        // Only add if message_end didn't already produce an error block
        const hasError = turn.blocks.some((b) => b.kind === "error");
        if (!hasError) {
          turn.blocks.push(buildErrorBlock(event.message));
        }
      }
      break;
    }

    default: {
      // Catch-all for unknown event types from future pi-ai versions
      const unknownEvent = event as { type: string };
      console.warn(`[processAgentEvent] Unhandled agent event type: "${unknownEvent.type}"`, event);
      break;
    }
  }

  return next;
}

// ─── AssistantMessageEvent sub-handler ──────────────────────────────────────

function processAssistantMessageEvent(
  ame: AgentAssistantMessageEvent,
  ensureAssistantTurn: () => AssistantTurn
): void {
  switch (ame.type) {
    // ── Thinking stream ──────────────────────────────────────────────
    case "thinking_start": {
      const turn = ensureAssistantTurn();
      turn.blocks.push({ kind: "thinking", text: "" });
      break;
    }
    case "thinking_delta": {
      const turn = ensureAssistantTurn();
      const last = turn.blocks[turn.blocks.length - 1];
      if (last?.kind === "thinking") {
        last.text += ame.delta ?? "";
      } else {
        turn.blocks.push({ kind: "thinking", text: ame.delta ?? "" });
      }
      break;
    }
    case "thinking_end":
      // Content already accumulated via deltas
      break;

    // ── Text stream ──────────────────────────────────────────────────
    case "text_start": {
      const turn = ensureAssistantTurn();
      turn.blocks.push({ kind: "text", text: "" });
      break;
    }
    case "text_delta": {
      const turn = ensureAssistantTurn();
      const last = turn.blocks[turn.blocks.length - 1];
      if (last?.kind === "text") {
        last.text += ame.delta ?? "";
      } else {
        turn.blocks.push({ kind: "text", text: ame.delta ?? "" });
      }
      break;
    }
    case "text_end":
      // Content already accumulated via deltas
      break;

    // ── Tool call stream ─────────────────────────────────────────────
    case "toolcall_start": {
      const turn = ensureAssistantTurn();
      const content = ame.partial?.content;
      const toolCall = content?.find((c) => c.type === "toolCall");
      turn.blocks.push({
        kind: "toolcall",
        name: (toolCall && "name" in toolCall ? toolCall.name : "") ?? "",
        text: "",
      });
      break;
    }
    case "toolcall_delta": {
      const turn = ensureAssistantTurn();
      const last = turn.blocks[turn.blocks.length - 1];
      if (last?.kind === "toolcall") {
        last.text += ame.delta ?? "";
      } else {
        turn.blocks.push({ kind: "toolcall", name: "", text: ame.delta ?? "" });
      }
      break;
    }
    case "toolcall_end":
      // Tool call content already accumulated via deltas
      break;

    // ── Initial partial (before any content blocks) ──────────────────
    case "start":
      // No UI action — the first content-specific *_start follows
      break;

    // ── Completion signals ───────────────────────────────────────────
    case "done":
      // Successful completion — message_end handles the final message
      break;

    case "error": {
      // API error (auth, rate limit, etc.) — surface immediately
      const turn = ensureAssistantTurn();
      if (ame.error?.errorMessage) {
        turn.blocks.push(buildErrorBlock(ame.error));
      }
      break;
    }

    default: {
      const unknownAme = ame as { type: string };
      console.warn(
        `[processAgentEvent] Unhandled AssistantMessageEvent type: "${unknownAme.type}"`,
        ame
      );
      break;
    }
  }
}
