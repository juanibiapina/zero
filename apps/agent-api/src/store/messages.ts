// Message-protocol helpers shared by both Store adapters, so DbStore and
// MemoryStore cannot disagree about what a stored message means.
//
// Storage holds wire-format content blocks as JSON. Everything that decides
// "what kind of row is this" and "does this conversation still need the model"
// lives here as pure functions, testable without a Durable Object.

import type { ContentBlock } from "../agents/protocol";
import type { MessageContent, MessageKind, Role } from "./types";

// The default kind for a row the caller did not classify: a user row is a real
// user message, an assistant row is a model response. `tool_result` rows are
// user-role rows and must be named explicitly by the caller.
export const defaultKind = (role: Role): MessageKind =>
  role === "assistant" ? "assistant_message" : "user_message";

// Stop reasons that mean the model is done and expects nothing back. Anything
// else (tool_use, pause_turn, compaction, or a missing reason) means the
// conversation is mid-response and still owes the user work.
const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
]);

export const isTerminalStopReason = (reason: string | null): boolean =>
  reason !== null && TERMINAL_STOP_REASONS.has(reason);

// Normalize content for storage: always a JSON array of blocks, so no reader
// has to guess whether a row is text or wire format.
export const encodeContent = (content: MessageContent): string =>
  JSON.stringify(toBlocks(content));

// Read stored content back. Tolerant on purpose: a row written before the
// protocol migration, or any value that is not a block array, is read as one
// text block rather than throwing inside a turn.
export const decodeContent = (stored: string): ContentBlock[] => {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
  } catch {
    // fall through: legacy plain text
  }
  return [{ type: "text", text: stored }];
};

export const toBlocks = (content: MessageContent): ContentBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

// The readable text of a message: its text blocks joined. Tool calls, results
// and images have no text and contribute nothing. Used wherever a message is
// rendered as prose (prompt building, transcripts).
export const messageText = (content: MessageContent): string =>
  typeof content === "string"
    ? content
    : content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> =>
          b.type === "text",
        )
        .map((b) => b.text)
        .join("\n\n");

// Does a conversation still owe work? The rule replaces the old "tail role is
// user" check and is protocol-aware:
//
// - queued Telegram messages are work, whatever the transcript looks like;
// - a user message or a tool result at the tail needs a model response;
// - an assistant response that stopped for a non-terminal reason (tool_use,
//   pause_turn, or no reason at all) is mid-flight and needs continuation;
// - an assistant response with a terminal stop reason and an empty queue is
//   idle.
export const conversationHasWork = (input: {
  pendingCount: number;
  tail?: { kind: MessageKind; stopReason: string | null };
}): boolean => {
  if (input.pendingCount > 0) return true;
  const tail = input.tail;
  if (!tail) return false;
  if (tail.kind === "assistant_message") return !isTerminalStopReason(tail.stopReason);
  return true;
};
