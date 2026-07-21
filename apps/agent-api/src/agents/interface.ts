// Interface agent: stateless per turn. Runs the tool loop, sends replies as it
// goes, and reports which topics it touched so the writer can consolidate them.
// The returned { replies, accessed } is the test surface for the whole system.

import { type LanguageModel, type ModelMessage } from "ai";
import { buildInterfaceTools } from "../tools/topics";
import { buildResearchTool } from "../tools/research";
import { buildTimezoneTool } from "../tools/timezone";
import { buildGoogleTools } from "../tools/google";
import { buildAttachmentTool } from "../tools/attachments";
import type { Attachment, Message, TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { GoogleWorkspace } from "../google/types";
import type { AttachmentStore } from "../attachments/types";
import { interfaceSystemPrompt, renderPinnedTopics } from "./prompts";
import { runAgent } from "./run";
import { log } from "../log";

// Delivered when the model never produces its intended answer (loop hit the
// step cap mid-tool-call, or finished clean with nothing to say). Named so
// tests can assert on it. Short, honest, no internal jargon.
export const FALLBACK_MESSAGE =
  "Sorry, I couldn't finish that one. Could you try again?";

export interface InterfaceAgentInput {
  model: LanguageModel;
  // Model for the nested research agent, tagged "research" for gateway
  // attribution. Falls back to `model` when omitted (tests that don't exercise
  // research need not distinguish the two).
  researchModel?: LanguageModel;
  store: TopicStore;
  send: (text: string) => Promise<void>;
  // Persist an assistant message durably before it is sent. Wired by the
  // orchestrator to the message store; defaults to a no-op in tests that only
  // assert on send/replies. Persist-before-send keeps retries idempotent.
  persistReply?: (text: string) => void;
  history: Message[];
  userMessage: string;
  search: WebSearch;
  // Gmail + Calendar access. Threaded exactly like `search`; tests inject the
  // memory adapter.
  google: GoogleWorkspace;
  // The user's IANA timezone for the datetime anchor. Defaults to UTC when the
  // user has never reported one (see prompts.ts).
  timezone?: string;
  // Persist a new user timezone (wired by the orchestrator to user settings).
  // Omitted in tests that don't exercise set_timezone.
  setTimezone?: (tz: string) => void;
  // Attachment blob store (R2) plus the id->row lookup, wired together into the
  // view_attachment tool. Omitted in tests that don't exercise attachments; the
  // tool is then not registered.
  attachments?: AttachmentStore;
  getAttachment?: (id: string) => Attachment | null;
  // Absolute reference time for the date anchor and relative message ages.
  // Defaults to now; injected in tests for deterministic rendering.
  now?: Date;
  // Test override for the step cap; production uses AGENT_MAX_STEPS.
  maxSteps?: number;
}

export interface InterfaceAgentResult {
  replies: string[];
  accessed: string[];
  // A readable serialization of the turn: the user message, each tool call and
  // its (truncated) result, and assistant text. The writer consumes this so it
  // sees what tools returned (calendar events, emails, research), not only the
  // final replies, which are lossy.
  transcript: string;
}

// Cap each serialized tool result so a large payload (a full calendar listing,
// a long email body) cannot blow up the writer's input. Truncated results keep
// enough to extract durable facts.
const MAX_TOOL_RESULT_CHARS = 1500;

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncate = (text: string): string =>
  text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]`
    : text;

// Serialize the run's model messages into a compact transcript. Generic over
// tools: any tool call and result is captured without per-tool code.
export const renderTranscript = (
  userMessage: string,
  messages: ModelMessage[],
): string => {
  const lines: string[] = [`User: ${userMessage}`];
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) lines.push(`Assistant: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "text") {
        if (part.text.trim()) lines.push(`Assistant: ${part.text}`);
      } else if (part.type === "tool-call") {
        lines.push(`Tool call ${part.toolName}: ${stringify(part.input)}`);
      } else if (part.type === "tool-result") {
        // Tool-result output is wrapped: { type: "text"|"json"|..., value }.
        // Unwrap to the value so the transcript shows the payload, not the
        // wrapper.
        const raw = (part as { output?: unknown }).output;
        const output =
          raw && typeof raw === "object" && "value" in raw
            ? (raw).value
            : raw;
        lines.push(
          `Tool result ${part.toolName}: ${truncate(stringify(output))}`,
        );
      }
    }
  }
  return lines.join("\n\n");
};

// Absolute local timestamp (YYYY-MM-DD HH:MM) for a stored message, in the
// user's timezone. Prefixed onto each user message so the model can place it in
// time. Absolute (not relative "5 min ago") so the text is stable turn-to-turn:
// a relative age would recompute every turn and mutate the prefix, defeating
// future prompt caching. The datetime anchor in the system prompt lets the
// model derive "how long ago".
export const formatTimestamp = (createdAt: string, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(createdAt));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
};

// Build the model's message array from the stored dialogue plus the current
// user message. The system prompt (instructions, datetime anchor, pinned
// topics) is assembled separately; this array is only the Telegram dialogue.
//
// Rules (see PLAN.md):
// - User messages carry an absolute timestamp prefix; assistant messages are
//   left verbatim (never rewrite the model's own prior words).
// - Leading assistant messages are dropped so the array starts with a user
//   turn (Anthropic requires the first non-system message to be `user`; a
//   windowed history slice can begin on an assistant reply).
// - Consecutive same-role messages are coalesced into one (joined by a blank
//   line): multiple reply() rows in a turn, or two user messages before a
//   reply.
// - Empty history yields a single current user message.
export const buildConversationMessages = (
  history: Message[],
  userMessage: string,
  now: Date = new Date(),
  timezone = "UTC",
): ModelMessage[] => {
  const turns: Message[] = [
    ...history,
    { role: "user", content: userMessage, createdAt: now.toISOString() },
  ];

  // Drop leading assistant messages so the array opens on a user turn.
  let start = 0;
  while (start < turns.length && turns[start].role === "assistant") start++;

  const messages: ModelMessage[] = [];
  for (const turn of turns.slice(start)) {
    const text =
      turn.role === "user"
        ? `[${formatTimestamp(turn.createdAt, timezone)}] ${turn.content}`
        : turn.content;
    const last = messages[messages.length - 1];
    if (last && last.role === turn.role) {
      // Coalesce consecutive same-role turns into one message.
      last.content = `${last.content as string}\n\n${text}`;
    } else if (turn.role === "user") {
      messages.push({ role: "user", content: text });
    } else {
      messages.push({ role: "assistant", content: text });
    }
  }
  return messages;
};

export const runInterfaceAgent = async (
  input: InterfaceAgentInput,
): Promise<InterfaceAgentResult> => {
  const accessed = new Set<string>();
  const replies: string[] = [];
  const persistReply = input.persistReply ?? (() => {});

  // A send failure inside the `reply` tool is swallowed by the AI SDK (a thrown
  // tool execute becomes a tool-error fed back to the model, not a rejected
  // generateText). Capture the first failure here and re-raise it after the
  // loop so it reaches the orchestrator's error boundary (turn_failed +
  // fallback). Short-circuit after the first failure so a fully-broken
  // transport is not hammered by repeated model retries within the step cap.
  let firstSendError: Error | null = null;
  const recordingSend = async (text: string): Promise<void> => {
    if (firstSendError !== null) throw firstSendError;
    try {
      await input.send(text);
    } catch (err) {
      firstSendError = err instanceof Error ? err : new Error(String(err));
      throw firstSendError;
    }
  };

  const tools = {
    ...buildInterfaceTools({
      store: input.store,
      send: recordingSend,
      persistReply,
      accessed,
      replies,
    }),
    ...buildResearchTool({
      model: input.researchModel ?? input.model,
      store: input.store,
      search: input.search,
      accessed,
    }),
    ...buildTimezoneTool({ setTimezone: input.setTimezone }),
    ...buildGoogleTools({
      google: input.google,
      timezone: input.timezone ?? "UTC",
    }),
    ...(input.attachments && input.getAttachment
      ? buildAttachmentTool({
          attachments: input.attachments,
          getAttachment: input.getAttachment,
        })
      : {}),
  };

  // The agent's replies are the { replies, accessed } collected by the tool
  // closures above. The runner's returned text is the model's final prose.
  const now = input.now ?? new Date();
  const start = Date.now();
  const pinned = renderPinnedTopics(input.store.getPinnedTopics());
  const { text, finishReason, steps, messages } = await runAgent({
    model: input.model,
    system: interfaceSystemPrompt(now, input.timezone, pinned),
    messages: buildConversationMessages(
      input.history,
      input.userMessage,
      now,
      input.timezone ?? "UTC",
    ),
    tools,
    maxSteps: input.maxSteps,
  });

  const transcript = renderTranscript(input.userMessage, messages);

  log("interface_completed", {
    steps,
    finish_reason: finishReason,
    replies_count: replies.length,
    accessed_count: accessed.size,
    duration_ms: Date.now() - start,
  });

  // A `reply` send failed and the AI SDK swallowed it. Re-raise so the
  // orchestrator's error boundary logs turn_failed and delivers the fallback.
  // The undelivered reply row was already persisted (persist-before-send), so
  // it stays in history alongside the fallback — the same "partial turn"
  // tradeoff as a mid-run eviction (see docs/topics.md), now visible not silent.
  if (firstSendError !== null) throw firstSendError as Error;

  const lastReply = replies[replies.length - 1]?.trim();

  // Clean finish: the model's final message is the substantive answer, so
  // deliver it — unless it is empty or an exact echo of the reply we already
  // sent. The model routinely puts the answer in its final text rather than a
  // reply() call, notably after a research tool call that followed an
  // acknowledgement reply. Earlier logic suppressed this whenever ANY reply had
  // gone out (even a bare "Searching now..." ack), which silently dropped the
  // real answer. Always sending the final message keeps ack-then-answer intact;
  // the echo guard prevents re-sending text the model already delivered.
  if (finishReason === "stop" && text.trim() && text.trim() !== lastReply) {
    persistReply(text);
    await input.send(text);
    replies.push(text);
    return { replies, accessed: [...accessed], transcript };
  }

  // Cap cut-off (finishReason !== "stop"), or a clean finish that produced no
  // final message and never sent a reply: the model never produced its intended
  // answer. Send a fallback so the user is never left in silence. (A clean
  // finish that already sent a reply and ended with empty/echo text needs no
  // fallback — the reply was the answer.)
  if (finishReason !== "stop" || replies.length === 0) {
    log("turn_incomplete", { finish_reason: finishReason, steps });
    persistReply(FALLBACK_MESSAGE);
    await input.send(FALLBACK_MESSAGE);
    replies.push(FALLBACK_MESSAGE);
  }

  return { replies, accessed: [...accessed], transcript };
};

export type { TopicStore };
