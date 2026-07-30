// Interface agent: stateless per turn. Runs the tool loop, sends each of the
// model's text blocks to the user as it is produced, and reports which topics it
// touched so the writer can consolidate them. The returned { replies, accessed }
// is the test surface for the whole system.
//
// There is one delivery path: the assistant's text blocks are the messages. A
// block is persisted before the Telegram fetch leaves (persist-before-send), so
// a mid-run eviction leaves the tail already `assistant` and the retry skips the
// thread instead of re-sending. Multi-message turns (acknowledge, then answer
// after research) come from the model producing text on more than one step.

import type { AgentMessage, AgentModel, ToolResultBlock } from "./protocol";
import { buildInterfaceTools } from "../tools/topics";
import { buildResearchTool } from "../tools/research";
import { buildReadPageTool } from "../tools/read-page";
import { buildTimezoneTool } from "../tools/timezone";
import { buildGoogleTools } from "../tools/google";
import { buildAttachmentTool } from "../tools/attachments";
import { messageText } from "../store/messages";
import type { Attachment, Message, TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { PageFetcher } from "../pagefetch/types";
import type { GoogleWorkspace } from "../google/types";
import type { AttachmentStore } from "../attachments/types";
import {
  interfaceContext,
  interfaceSystemPrompt,
  renderPinnedTopics,
} from "./prompts";
import { runAgent, usageLogFields } from "./run";
import { markCacheBreakpoint } from "./cache";
import { log } from "../log";

// Delivered when the model never produces its intended answer (loop hit the
// step cap mid-tool-call, or finished clean with nothing to say). Named so
// tests can assert on it. Short, honest, no internal jargon.
export const FALLBACK_MESSAGE =
  "Sorry, I couldn't finish that one. Could you try again?";

// A run that never delivered anything the user can read must not end in
// silence: cap exhaustion returns finishReason "tool-calls" with empty text, and
// a clean finish can produce no text at all. Pure decision, executed by the
// runner below.
export const needsFallback = (input: {
  finishReason: string;
  sentCount: number;
}): boolean => input.finishReason !== "stop" || input.sentCount === 0;

export interface InterfaceAgentInput {
  model: AgentModel;
  // Model for the nested research agent, tagged "research" for gateway
  // attribution. Falls back to `model` when omitted (tests that don't exercise
  // research need not distinguish the two).
  researchModel?: AgentModel;
  store: TopicStore;
  send: (text: string) => Promise<void>;
  // Persist an assistant message durably before it is sent. Wired by the
  // orchestrator to the message store; defaults to a no-op in tests that only
  // assert on send/replies. Persist-before-send keeps retries idempotent.
  persistReply?: (text: string) => void;
  history: Message[];
  userMessage: string;
  search: WebSearch;
  // Page-fetch port for the read_page tool, registered on this agent and on the
  // nested research agent. Threaded exactly like `search`; tests inject the
  // memory adapter.
  fetcher: PageFetcher;
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

// Research results get a much higher ceiling. Unlike calendar/email dumps, which
// are context the writer samples from, a research report is the payload the
// writer must persist verbatim with every Source: URL. Clipping it drops
// enumerated items and their provenance before storage. The ceiling is generous
// enough that a normal report is never touched but still bounds a pathological
// runaway. See docs/plans/research-writer-handoff.md.
const MAX_RESEARCH_RESULT_CHARS = 8000;

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

// Render a tool result's content for the transcript. Image blocks are redacted
// to a marker: their base64 payload is worth thousands of tokens and nothing to
// the writer.
const renderToolResult = (content: ToolResultBlock["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[image ${block.source.media_type}]`,
    )
    .join("\n");
};

// Serialize the run's generated messages into a compact transcript. Generic
// over tools: any tool call and result is captured without per-tool code. Tool
// results carry only the call id, so names are resolved from the tool_use
// blocks seen earlier in the run.
export const renderTranscript = (
  userMessage: string,
  messages: AgentMessage[],
): string => {
  const lines: string[] = [`User: ${userMessage}`];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) lines.push(`Assistant: ${content}`);
      continue;
    }
    for (const block of content) {
      if (block.type === "text") {
        if (block.text.trim()) lines.push(`Assistant: ${block.text}`);
      } else if (block.type === "tool_use") {
        toolNames.set(block.id, block.name);
        lines.push(`Tool call ${block.name}: ${stringify(block.input)}`);
      } else if (block.type === "tool_result") {
        const name = toolNames.get(block.tool_use_id) ?? "unknown";
        const max =
          name === "research" ? MAX_RESEARCH_RESULT_CHARS : MAX_TOOL_RESULT_CHARS;
        lines.push(
          `Tool result ${name}: ${truncate(renderToolResult(block.content), max)}`,
        );
      }
    }
  }
  return lines.join("\n\n");
};

// Absolute local timestamp (YYYY-MM-DD HH:MM) for a stored message, in the
// user's timezone. Prefixed onto each user message so the model can place it in
// time. Absolute (not relative "5 min ago") so the text is stable turn-to-turn:
// a relative age would recompute every turn and mutate the prefix, breaking the
// cross-turn cache (see docs/caching.md). The datetime anchor on the latest
// message lets the model derive "how long ago".
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
// user message. The system prompt (instructions, pinned topics) is assembled
// separately, and the volatile per-turn context (current time, timezone) is
// prepended to the latest message by the caller; this array is only the
// Telegram dialogue. The history before the current message stays byte-stable
// turn-to-turn so it caches across turns (see docs/caching.md).
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
): AgentMessage[] => {
  const turns: Message[] = [
    ...history,
    {
      id: 0,
      role: "user",
      kind: "user_message",
      content: userMessage,
      stopReason: null,
      createdAt: now.toISOString(),
    },
  ];

  // Drop leading assistant messages so the array opens on a user turn.
  let start = 0;
  while (start < turns.length && turns[start].role === "assistant") start++;

  const messages: AgentMessage[] = [];
  for (const turn of turns.slice(start)) {
    // Phase 1.1 stores every row as content blocks; until the loop persists
    // tool calls (Phase 1.3) each row is one text block, so flattening to text
    // here is lossless and the rendered prompt is byte-identical to before.
    const body = messageText(turn.content);
    const text =
      turn.role === "user"
        ? `[${formatTimestamp(turn.createdAt, timezone)}] ${body}`
        : body;
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
  // get_topic calls this turn. Logged next to topic_list_rendered: dropping
  // `summary` from the listing only saves input if the model does not replace
  // it with extra full-body reads.
  const reads = { count: 0 };
  const persistReply = input.persistReply ?? (() => {});

  // Deliver one text block: persist it, then send it. Persist-before-send is
  // load-bearing (see the file header), so the order must not flip. A send
  // failure propagates out of runAgent to the orchestrator's error boundary
  // rather than becoming a tool error the model would retry.
  const deliver = async (text: string): Promise<void> => {
    persistReply(text);
    await input.send(text);
    replies.push(text);
  };

  const tools = {
    ...buildInterfaceTools({
      store: input.store,
      accessed,
      reads,
    }),
    ...buildResearchTool({
      model: input.researchModel ?? input.model,
      store: input.store,
      search: input.search,
      fetcher: input.fetcher,
      accessed,
    }),
    // Registered unconditionally (like the attachment tool) so the tool schema
    // stays byte-identical across users and turns. Lets the interface open a
    // link the user handed over without spawning a research run.
    ...buildReadPageTool({ fetcher: input.fetcher, caller: "interface" }),
    ...buildTimezoneTool({ setTimezone: input.setTimezone }),
    ...buildGoogleTools({
      google: input.google,
      timezone: input.timezone ?? "UTC",
    }),
    // Registered unconditionally so the tool schema is byte-identical across
    // users and turns (a conditional tool would break cross-user tool-cache
    // sharing). When no attachment store is wired the tool returns an error.
    ...buildAttachmentTool({
      attachments: input.attachments,
      getAttachment: input.getAttachment,
    }),
  };

  // The agent's replies are the { replies, accessed } collected by the tool
  // closures above. The runner's returned text is the model's final prose.
  const now = input.now ?? new Date();
  const start = Date.now();
  const timezone = input.timezone ?? "UTC";
  const pinned = renderPinnedTopics(input.store.getPinnedTopics());

  const convo = buildConversationMessages(
    input.history,
    input.userMessage,
    now,
    timezone,
  );
  // Prepend the volatile context (current time + timezone) to the current user
  // message so it sits after the cached history prefix and never invalidates it.
  // The last message is always the current user turn (appended by
  // buildConversationMessages), so rebuild it as a user message with the context
  // prepended.
  const lastIdx = convo.length - 1;
  convo[lastIdx] = {
    role: "user",
    content: `${interfaceContext(now, timezone)}\n\n${convo[lastIdx].content as string}`,
  };
  // Cross-turn anchor breakpoint in the messages region. The last stable message
  // (previous turn's final block) is byte-identical next turn, so it is the
  // write that yields the cross-turn history read. The current message's tail is
  // marked by the runner's loop-owned sliding breakpoint (see run.ts), so it is
  // not marked here — that keeps the per-request budget at 4 (tools + system +
  // anchor + sliding). Empty history has no stable message to anchor, and the
  // loop's sliding breakpoint covers the single current message.
  if (lastIdx >= 1) convo[lastIdx - 1] = markCacheBreakpoint(convo[lastIdx - 1]);

  const { finishReason, steps, messages, usage, stepUsages } = await runAgent({
    model: input.model,
    system: interfaceSystemPrompt(pinned),
    messages: convo,
    tools,
    maxSteps: input.maxSteps,
    onText: deliver,
  });

  const transcript = renderTranscript(input.userMessage, messages);

  log("interface_completed", {
    steps,
    finish_reason: finishReason,
    replies_count: replies.length,
    accessed_count: accessed.size,
    duration_ms: Date.now() - start,
    ...usageLogFields(usage),
  });

  log("topic_reads_per_turn", { count: reads.count });

  // Message boundaries moved when the reply tool went away: they are now the
  // model's own text blocks. This is how that shift is observed in production
  // rather than inferred from transcripts.
  log("turn_messages_sent", { count: replies.length });

  // Per-step token line for multi-step turns: exposes the tier-1 write-then-read
  // pattern (step 1 writes the prefix, later steps read it) that the aggregate
  // hides. See docs/caching.md.
  if (stepUsages.length > 1) {
    log("interface_step_usage", {
      cache_read: stepUsages.map((u) => u.cacheReadTokens),
      cache_write: stepUsages.map((u) => u.cacheWriteTokens),
      input: stepUsages.map((u) => u.inputTokens),
    });
  }

  if (needsFallback({ finishReason, sentCount: replies.length })) {
    log("turn_incomplete", { finish_reason: finishReason, steps });
    await deliver(FALLBACK_MESSAGE);
  }

  return { replies, accessed: [...accessed], transcript };
};

export type { TopicStore };
