// Message-protocol helpers shared by both Store adapters, so DbStore and
// MemoryStore cannot disagree about what a stored message means.
//
// Storage holds wire-format content blocks as JSON. Everything that decides
// "what kind of row is this" and "does this conversation still need the model"
// lives here as pure functions, testable without a Durable Object.

import type { ContentBlock, ToolResultContent } from "../agents/protocol";
import type { Message, MessageContent, MessageKind, Role } from "./types";

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

// --- context rendering ---

// The backstop ceiling on rendered context. It exists because compaction is
// only activated in Phase 3.4: until something moves the boundary in
// production, a conversation would otherwise grow without bound between
// deploys. Delete both constants in the same commit that enables size-triggered
// compaction, not before.
export const CONTEXT_BACKSTOP_MESSAGES = 60;
export const CONTEXT_BACKSTOP_CHARS = 150_000;

// Rough token estimate from character count (~4 chars per token). Used only for
// the `context_rendered` log line the compaction threshold is derived from, so
// an approximation is enough; the real number comes from the gateway.
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export const contentChars = (content: MessageContent): number =>
  typeof content === "string" ? content.length : JSON.stringify(content).length;

// Drop the oldest messages until the rendered context fits the character
// ceiling. The newest message is always kept, however large it is: dropping the
// message being answered would be worse than exceeding the ceiling.
export const applyContextBackstop = (
  messages: Message[],
  maxChars: number = CONTEXT_BACKSTOP_CHARS,
): Message[] => {
  let total = messages.reduce((sum, m) => sum + contentChars(m.content), 0);
  let start = 0;
  while (start < messages.length - 1 && total > maxChars) {
    total -= contentChars(messages[start].content);
    start++;
  }
  return start === 0 ? messages : messages.slice(start);
};

// --- staleness ---

// Topic reads return the knowledge version they were taken at. Once tool
// results persist, a read stays in the conversation forever, so any later topic
// write makes it a lie. Rendering replaces the result of a read taken at a
// different version with this stub.
export const STALE_TOPIC_STUB =
  "[stale: topic knowledge changed; reread before using or writing]";

// Tools whose results carry a knowledge version and therefore go stale.
const TOPIC_READ_TOOLS = new Set(["list_topics", "get_topic", "list_backlinks"]);

// The version a persisted tool result was taken at, or null when the payload
// carries none (a pre-versioning row, or an error result).
const resultVersion = (content: ToolResultContent): number | null => {
  const text = typeof content === "string" ? content : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const v: unknown = parsed.version;
      return typeof v === "number" ? v : null;
    }
  } catch {
    // not JSON: no version to compare
  }
  return null;
};

// How many persisted topic-read results the rendered context carries. Counted
// on the filtered messages, so subtracting `stale_stubs` gives the reads the
// model does not have to make again this turn.
export const countTopicReads = (messages: Message[]): number => {
  const toolNames = new Map<string, string>();
  let count = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
      else if (
        block.type === "tool_result" &&
        TOPIC_READ_TOOLS.has(toolNames.get(block.tool_use_id) ?? "")
      )
        count++;
    }
  }
  return count;
};

// Replace, never delete: every `tool_use` block requires a matching
// `tool_result`, so a stale read keeps its pair and loses only its content.
// Mechanical and version-based, so it applies to every conversation without a
// model call. Returns the rendered messages and how many results were stubbed
// (logged as `context_rendered.stale_stubs`).
export const applyStalenessFilter = (
  messages: Message[],
  currentVersion: number,
): { messages: Message[]; stubbed: number } => {
  const toolNames = new Map<string, string>();
  let stubbed = 0;
  const out = messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") return message;
    let changed = false;
    const blocks = content.map((block): ContentBlock => {
      if (block.type === "tool_use") {
        toolNames.set(block.id, block.name);
        return block;
      }
      if (block.type !== "tool_result") return block;
      const name = toolNames.get(block.tool_use_id);
      if (name === undefined || !TOPIC_READ_TOOLS.has(name)) return block;
      if (resultVersion(block.content) === currentVersion) return block;
      changed = true;
      stubbed++;
      return { ...block, content: STALE_TOPIC_STUB };
    });
    return changed ? { ...message, content: blocks } : message;
  });
  return { messages: out, stubbed };
};
