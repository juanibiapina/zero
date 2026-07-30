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

import type {
  AgentMessage,
  AgentModel,
  ContentBlock,
  ToolResultBlock,
} from "./protocol";
import { buildInterfaceTools } from "../tools/topics";
import { buildResearchTool } from "../tools/research";
import { buildReadPageTool } from "../tools/read-page";
import { buildTimezoneTool } from "../tools/timezone";
import { buildGoogleTools } from "../tools/google";
import { buildAttachmentTool } from "../tools/attachments";
import { messageText, toBlocks } from "../store/messages";
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
import { runAgent, usageLogFields, type ExternalCallGuard } from "./run";
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
  // Persist one model response verbatim, returning its row id. Called before
  // the response's text is sent and before its tools run, so the log always has
  // the response ahead of its side effects. Defaults to a no-op returning null
  // in tests that only assert on send/replies.
  // `responseId` is the model's own id for the response, absent for Zero's own
  // fallback text (which is not a model response and starts no chain).
  persistAssistant?: (
    content: ContentBlock[],
    stopReason: string | null,
    responseId?: string,
  ) => number | null;
  // Persist one step's ordered tool results before the next model call.
  persistToolResults?: (results: ToolResultBlock[]) => void;
  // Claim one assistant text block for delivery, returning false when it was
  // already claimed. A resumed run must not send a block the interrupted run
  // already sent. Defaults to always claiming.
  claimDelivery?: (messageId: number, blockIndex: number) => boolean;
  // Take the Telegram messages that arrived while this run was working. Called
  // only where the loop would otherwise stop, so a follow-up never cuts into a
  // tool sequence. Defaults to no follow-ups.
  drainFollowups?: () => Message[];
  // Durable claims for irreversible tool calls (send mail, create an event), so
  // a resumed turn reports an unknown outcome instead of repeating it. Omitted
  // in tests that do not exercise external writes.
  externalCalls?: ExternalCallGuard;
  history: Message[];
  // Rows persisted for this turn by an interrupted run of it (see
  // ConversationRender.trailing).
  trailing?: Message[];
  // Summary of the compacted prefix of this conversation, if it has one. It is
  // rendered as the first user message, ahead of the surviving history, so the
  // model keeps continuity without the raw messages.
  summary?: string;
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

// Render one stored row as a wire message.
//
// - A real user message becomes plain text with an absolute timestamp prefix.
// - An assistant response keeps its content blocks **verbatim**: it is what the
//   model produced, tool calls included, and re-sending the same bytes next turn
//   is what lets the prefix cache across turns (see docs/caching.md). Never
//   flatten it to prose.
// - A tool-result row keeps its blocks verbatim too, on the `user` role, which
//   is where the wire format puts them.
const renderRow = (row: Message, timezone: string): AgentMessage => {
  if (row.role === "assistant") {
    return { role: "assistant", content: toBlocks(row.content) };
  }
  if (row.kind === "tool_result") {
    return { role: "user", content: toBlocks(row.content) };
  }
  return {
    role: "user",
    content: `[${formatTimestamp(row.createdAt, timezone)}] ${messageText(row.content)}`,
  };
};

// Tool results must lead their user message; the model pairs them with the
// preceding assistant response.
const orderUserBlocks = (blocks: ContentBlock[]): ContentBlock[] => {
  const results = blocks.filter((b) => b.type === "tool_result");
  if (results.length === 0 || results.length === blocks.length) return blocks;
  return [...results, ...blocks.filter((b) => b.type !== "tool_result")];
};

// Append a rendered message, coalescing it into the previous one when the roles
// match: Anthropic's models are trained on alternating turns, and a drained
// burst of Telegram messages or two assistant rows in a row would otherwise
// produce consecutive same-role messages. Two texts join with a blank line;
// anything carrying blocks concatenates as blocks.
const appendMessage = (messages: AgentMessage[], next: AgentMessage): void => {
  const last = messages[messages.length - 1];
  if (!last || last.role !== next.role) {
    messages.push(next);
    return;
  }
  if (typeof last.content === "string" && typeof next.content === "string") {
    last.content = `${last.content}\n\n${next.content}`;
    return;
  }
  const merged = [...toBlocks(last.content), ...toBlocks(next.content)];
  last.content = next.role === "user" ? orderUserBlocks(merged) : merged;
};

export interface ConversationRender {
  // Everything before the user message being answered.
  history: Message[];
  // The text of the user message being answered.
  userMessage: string;
  // Rows already persisted for this same turn by a run that was interrupted:
  // the model's responses and their tool results. Empty on a fresh turn; on a
  // resume they are what tells the model where it got to.
  trailing?: Message[];
  now?: Date;
  timezone?: string;
  summary?: string;
  // Volatile per-turn context (current time, timezone). Prepended to the user
  // message being answered so it sits after the cached prefix instead of
  // invalidating it.
  context?: string;
}

// Build the model's message array from the durable log. The system prompt
// (instructions, pinned topics) is assembled separately; this array is only the
// conversation. Everything before the current user message stays byte-stable
// turn-to-turn so it caches across turns (see docs/caching.md).
//
// Rules (see PLAN.md):
// - Leading assistant messages are dropped so the array starts with a user
//   turn (Anthropic requires the first non-system message to be `user`; a
//   windowed history slice can begin on an assistant reply).
// - Consecutive same-role messages are coalesced into one.
// - Empty history yields a single current user message.
export const buildConversationMessages = (
  input: ConversationRender,
): AgentMessage[] => {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? "UTC";
  const stamp = formatTimestamp(now.toISOString(), timezone);
  const current = input.context
    ? `${input.context}\n\n[${stamp}] ${input.userMessage}`
    : `[${stamp}] ${input.userMessage}`;

  const messages: AgentMessage[] = [];
  // The compacted prefix opens the array as a user message. It is stable text
  // (it only changes when compaction runs again), so it caches like history.
  if (input.summary) {
    messages.push({
      role: "user",
      content: `[summary of earlier conversation]\n\n${input.summary}`,
    });
  }

  // Drop leading assistant messages so the array opens on a user turn. Only
  // needed without a summary: with one, the array already opens on `user` and
  // dropping the first replies would lose real conversation.
  let start = 0;
  if (!input.summary) {
    while (start < input.history.length && input.history[start].role === "assistant")
      start++;
  }

  for (const row of input.history.slice(start)) {
    appendMessage(messages, renderRow(row, timezone));
  }
  appendMessage(messages, { role: "user", content: current });
  for (const row of input.trailing ?? []) {
    appendMessage(messages, renderRow(row, timezone));
  }
  return messages;
};

// The response id this conversation last received, for the cross-turn cache
// diagnostic chain. Null when the conversation has no persisted response yet (or
// only pre-1.4 rows, which recorded none).
const lastResponseId = (
  history: Message[],
  trailing: Message[] = [],
): string | null => {
  for (const row of [...history, ...trailing].reverse()) {
    if (row.responseId) return row.responseId;
  }
  return null;
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
  const persistAssistant =
    input.persistAssistant ?? ((): number | null => null);
  const persistToolResults = input.persistToolResults ?? (() => {});
  const claimDelivery = input.claimDelivery ?? (() => true);
  const drainFollowups = input.drainFollowups ?? (() => []);
  const timezone = input.timezone ?? "UTC";

  // Deliver one text block of a persisted assistant response. The response is
  // already in the log (the runner persists it before this runs), so what is
  // needed here is at-most-once sending: claim the block durably, then send.
  // A resumed run finds the block already claimed and stays quiet instead of
  // repeating it. A send failure propagates out of runAgent to the
  // orchestrator's error boundary rather than becoming a tool error the model
  // would retry.
  const deliver = async (
    text: string,
    ref?: { messageId: number | null; blockIndex: number },
  ): Promise<void> => {
    if (ref && ref.messageId !== null && !claimDelivery(ref.messageId, ref.blockIndex)) {
      log("delivery_skipped", { block_index: ref.blockIndex });
      return;
    }
    await input.send(text);
    replies.push(text);
  };

  // A run interrupted between persisting a response and sending its text left
  // the user with nothing to read. The claims say exactly which blocks got out,
  // so send the rest before continuing the loop.
  const deliverUnclaimed = async (rows: Message[]): Promise<void> => {
    for (const row of rows) {
      if (row.role !== "assistant") continue;
      for (const [blockIndex, block] of toBlocks(row.content).entries()) {
        if (block.type !== "text" || block.text.trim() === "") continue;
        await deliver(block.text, { messageId: row.id, blockIndex });
      }
    }
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
  const pinned = renderPinnedTopics(input.store.getPinnedTopics());

  // The volatile context (current time + timezone) rides on the user message
  // being answered, so it sits after the cached history prefix and never
  // invalidates it.
  const convo = buildConversationMessages({
    history: input.history,
    userMessage: input.userMessage,
    trailing: input.trailing,
    now,
    timezone,
    summary: input.summary,
    context: interfaceContext(now, timezone),
  });
  const lastIdx = convo.length - 1;
  // Cross-turn anchor breakpoint in the messages region. The last stable message
  // (previous turn's final block) is byte-identical next turn, so it is the
  // write that yields the cross-turn history read. The current message's tail is
  // marked by the runner's loop-owned sliding breakpoint (see run.ts), so it is
  // not marked here — that keeps the per-request budget at 4 (tools + system +
  // anchor + sliding). Empty history has no stable message to anchor, and the
  // loop's sliding breakpoint covers the single current message.
  if (lastIdx >= 1) convo[lastIdx - 1] = markCacheBreakpoint(convo[lastIdx - 1]);

  await deliverUnclaimed(input.trailing ?? []);

  let injectedFollowups = 0;
  const { finishReason, steps, messages, usage, stepUsages } = await runAgent({
    model: input.model,
    system: interfaceSystemPrompt(pinned),
    messages: convo,
    tools,
    maxSteps: input.maxSteps,
    externalCalls: input.externalCalls,
    previousResponseId: lastResponseId(input.history, input.trailing),
    onAssistant: async (content, stopReason, responseId) =>
      persistAssistant(content, stopReason, responseId),
    onText: deliver,
    onToolResults: async (results) => persistToolResults(results),
    onIdle: async () => {
      const rows = drainFollowups();
      if (rows.length === 0) return [];
      injectedFollowups += rows.length;
      log("followups_injected", {
        count: rows.length,
        oldest_age_ms: Date.now() - new Date(rows[0].createdAt).getTime(),
      });
      return rows.map((row) => renderRow(row, timezone));
    },
  });

  const transcript = renderTranscript(input.userMessage, messages);

  log("interface_completed", {
    steps,
    finish_reason: finishReason,
    replies_count: replies.length,
    accessed_count: accessed.size,
    followups_injected: injectedFollowups,
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
    // The fallback is Zero's own text, not the model's, so it gets its own
    // assistant row. Persisting it terminally is also what stops the work rule
    // from resuming a run the step cap already gave up on.
    const messageId = persistAssistant(
      [{ type: "text", text: FALLBACK_MESSAGE }],
      "end_turn",
    );
    await deliver(
      FALLBACK_MESSAGE,
      messageId === null ? undefined : { messageId, blockIndex: 0 },
    );
  }

  return { replies, accessed: [...accessed], transcript };
};

export type { TopicStore };
