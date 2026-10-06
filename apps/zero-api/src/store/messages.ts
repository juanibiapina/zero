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

// Which text blocks of an assistant row still owe the user a send. A block is
// deliverable when it carries non-blank text; it is outstanding until its index
// appears in the delivery claims. Shared so both stores and the delivery retry
// agree on what "already sent" means.
export const unclaimedBlockIndexes = (
  content: MessageContent,
  claimed: Iterable<number>,
): number[] => {
  const done = new Set(claimed);
  const out: number[] = [];
  for (const [index, block] of toBlocks(content).entries()) {
    if (block.type !== "text" || block.text.trim() === "") continue;
    if (!done.has(index)) out.push(index);
  }
  return out;
};

// Does a conversation still owe work? The rule replaces the old "tail role is
// user" check and is protocol-aware:
//
// - queued Telegram messages are work, whatever the transcript looks like;
// - a user message or a tool result at the tail needs a model response;
// - an assistant response that stopped for a non-terminal reason (tool_use,
//   pause_turn, or no reason at all) is mid-flight and needs continuation;
// - an assistant response with a terminal stop reason and an empty queue is
//   idle, unless one of its text blocks was persisted but never sent. A reset
//   between persisting a response and claiming its delivery leaves exactly that
//   state, and the reply is only recoverable if this predicate calls it work:
//   it is what both the alarm's thread scan and the turn itself ask.
export const conversationHasWork = (input: {
  pendingCount: number;
  tail?: { kind: MessageKind; stopReason: string | null };
  // Text blocks of the tail row that were persisted and never sent.
  undeliveredCount?: number;
}): boolean => {
  if (input.pendingCount > 0) return true;
  const tail = input.tail;
  if (!tail) return false;
  if (tail.kind === "assistant_message")
    return (
      !isTerminalStopReason(tail.stopReason) || (input.undeliveredCount ?? 0) > 0
    );
  return true;
};

// Make a rendered window safe to send. A window can open mid-turn in two ways:
// a read that hit `CONTEXT_MESSAGE_PAGE` and cut the oldest rows, or a boundary
// that landed between an assistant `tool_use` and its `tool_result`. Either way
// the array would start with a result whose call is not in it, which the API
// rejects, so drop the leading results. Rows that follow are self-contained: a
// leading assistant row carries its own calls and their results come after it.
export const trimOrphanToolResults = <T extends { kind: MessageKind }>(
  messages: T[],
): T[] => {
  let start = 0;
  while (start < messages.length && messages[start].kind === "tool_result")
    start++;
  return start === 0 ? messages : messages.slice(start);
};

// Where compaction may move a conversation's boundary.
//
// Not a row count: four rows are not one exchange, and a multi-step turn puts an
// assistant `tool_use` and its `tool_result` in separate rows, so a count-based
// cut can split them and leave the rendered context starting with an orphan
// result. The only position that is safe by construction is right after a
// terminal assistant response, because what follows it is a user message.
//
// `keepTail` holds that many newest rows out of the summary: the user is
// mid-conversation and those are the messages they are still talking about.
// Returns the index to compact through (inclusive), or null when the window has
// no safe cut, in which case the boundary must stay where it is.
export const safeCompactionCut = (
  messages: { kind: MessageKind; stopReason: string | null }[],
  options: { keepTail: number },
): number | null => {
  const end = messages.length - Math.max(0, options.keepTail);
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "assistant_message" && isTerminalStopReason(m.stopReason))
      return i;
  }
  return null;
};

// Rough token estimate from character count (~4 chars per token).
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

// --- staleness ---

// Topic reads return the knowledge version they were taken at. Once tool
// results persist, a read stays in the conversation forever, so any later topic
// write makes it a lie. Rendering replaces the result of a read taken at a
// different version with this stub.
export const STALE_TOPIC_STUB =
  "[stale: topic knowledge changed; reread before using or writing]";
