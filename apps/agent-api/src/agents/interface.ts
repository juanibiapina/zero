// Interface agent: stateless per turn. Runs the tool loop and sends each of the
// model's text blocks to the user as it is produced. The returned
// { replies, accessed } is the test surface for the whole system. Nothing
// consolidates knowledge after it: the durable message log is what learning
// reads, off the turn path.
//
// There is one delivery path: the assistant's text blocks are the messages. A
// block is persisted before the Telegram fetch leaves (persist-before-send), so
// a mid-run eviction leaves the tail already `assistant` and the retry skips the
// thread instead of re-sending. Multi-message turns (say it is looking, then
// answer after searching) come from the model producing text on more than one
// step.

import type {
  AgentMessage,
  AgentModel,
  ContentBlock,
  ToolResultBlock,
} from "./protocol";
import { buildInterfaceTools } from "../tools/topics";
import { buildWebSearchTool, newWebSearchStats } from "../tools/web-search";
import { buildReadPageTool } from "../tools/read-page";
import { buildTimezoneTool } from "../tools/timezone";
import { buildCountryTool } from "../tools/country";
import { buildScheduleTools } from "../tools/schedules";
import { buildGoogleTools } from "../tools/google";
import { buildFileTools } from "../tools/files";
import { messageText, toBlocks } from "../store/messages";
import type { Message, TopicStore } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { PageFetcher } from "../pagefetch/types";
import type { GoogleWorkspace } from "../google/types";
import type { StoredFile, UserFileStore } from "../files/types";
import type { ScheduleBook } from "../schedules/types";
import {
  interfaceContext,
  interfaceSystemPrompt,
  renderPinnedTopics,
} from "./prompts";
import { runAgent, usageLogFields, type ExternalCallGuard } from "./run";
import { createDelivery } from "./delivery";
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
  // Web-search port for the web_search tool; tests inject the memory adapter.
  search: WebSearch;
  // Page-fetch port for the read_page tool. Threaded exactly like `search`;
  // tests inject the memory adapter.
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
  // The user's ISO 3166-1 alpha-2 country code, rendered into the per-turn
  // context. Absent when unknown, which the context states explicitly.
  country?: string;
  // Persist a new user country (wired by the orchestrator to user settings).
  // Omitted in tests that don't exercise set_country.
  setCountry?: (country: string) => void;
  // User-owned files and active Telegram-topic delivery. Tools remain registered
  // when these are absent so the cached tool schema stays stable.
  files?: UserFileStore;
  sendFile?: (file: StoredFile, bytes: Uint8Array) => Promise<void>;
  // What the user has asked to happen later, bound to this conversation. Tools
  // stay registered when it is absent so the cached tool schema stays stable.
  schedules?: ScheduleBook;
  // Re-arm the user's schedule timer after a create or cancel. Fire-and-forget.
  onScheduleChanged?: () => void;
  // Absolute reference time for the date anchor and relative message ages.
  // Defaults to now; injected in tests for deterministic rendering.
  now?: Date;
  // Test override for the step cap; production uses AGENT_MAX_STEPS.
  maxSteps?: number;
}

export interface InterfaceAgentResult {
  replies: string[];
  // Topics this turn read or wrote. Kept for the completion log; learning reads
  // the durable message log itself rather than being handed a turn summary.
  accessed: string[];
}

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

// Append a rendered message. Append-only, by design: one stored row is one wire
// message, always, so a message's bytes are fixed the moment it is first sent
// and no later row can change a position the cache already covers.
//
// This used to coalesce consecutive same-role messages "for proxy
// compatibility", from when the worker ran on the Vercel AI SDK rather than the
// Anthropic SDK. The API needs no such help: "Consecutive `user` or `assistant`
// turns in your request will be combined into a single turn" (Messages API
// reference), and consecutive turns of either role, plus a leading assistant
// turn, were each confirmed accepted against the live API. Merging also cost
// correctness once thinking arrived, since it could splice two responses'
// thinking runs into one assistant message, which the API validates and rejects.
//
// The one ordering rule that IS real — `tool_result` blocks must come
// immediately after the `tool_use` they answer, or the request 400s — is
// satisfied by row order alone: a Telegram message that arrives mid-run waits in
// `pendingMessages` and only becomes a row at the loop's idle point, which is
// reached only when the model asked for no tools. So no user row can land
// between an assistant row and its results.
const appendMessage = (messages: AgentMessage[], next: AgentMessage): void => {
  messages.push(next);
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
  // Volatile per-turn context (current time, timezone, country). Prepended to the user
  // message being answered so it sits after the cached prefix instead of
  // invalidating it.
  context?: string;
}

// Build the model's message array from the durable log. The system prompt
// (instructions, pinned topics) is assembled separately; this array is only the
// conversation. Everything before the current user message stays byte-stable
// turn-to-turn so it caches across turns (see docs/caching.md).
//
// One stored row renders to one message, in id order, unchanged. Nothing is
// merged, reordered, or dropped: the array is append-only, which is what keeps
// turn N's request a byte prefix of turn N+1's. Empty history yields a single
// current user message.
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

  // A windowed history slice can begin on an assistant reply. That used to be
  // trimmed away on the belief that the array must open on a `user` turn; the
  // API accepts a leading assistant turn (confirmed live), and dropping real
  // replies loses conversation the user can see in their chat.
  for (const row of input.history) {
    appendMessage(messages, renderRow(row, timezone));
  }
  appendMessage(messages, { role: "user", content: current });
  for (const row of input.trailing ?? []) {
    appendMessage(messages, renderRow(row, timezone));
  }
  return messages;
};

// The last message at or before `from` that can carry a cache breakpoint.
// Assistant messages cannot (a breakpoint only goes on an input block), and the
// message before the current one is usually the previous turn's assistant reply,
// so the anchor walks back to the previous user message. The cost is that the
// last reply falls outside the anchored prefix; the alternative is no cross-turn
// anchor at all. Returns -1 when nothing before `from` is markable.
const anchorIndex = (messages: AgentMessage[], from: number): number => {
  for (let index = from; index >= 0; index--) {
    if (messages[index].role !== "assistant") return index;
  }
  return -1;
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
  // Per-turn search tally. Brave bills per query and the loop can fan out
  // several tool calls per step, so `steps` says nothing about spend; this is
  // what makes a turn's search cost readable in the logs.
  const searchStats = newWebSearchStats();

  // At-most-once sending of persisted text (see agents/delivery.ts). A send
  // failure propagates out of runAgent to the orchestrator's error boundary
  // rather than becoming a tool error the model would retry.
  const { deliver, deliverUnclaimed } = createDelivery({
    claim: (messageId, blockIndex) => claimDelivery(messageId, blockIndex),
    send: (text) => input.send(text),
    onSent: (text) => replies.push(text),
  });

  const tools = {
    ...buildInterfaceTools({
      store: input.store,
      accessed,
      reads,
    }),
    // Investigation runs in this loop, not in a nested agent: the model can
    // tell the user it is looking, search, open what it finds, and answer,
    // all as one stream of text blocks.
    ...buildWebSearchTool({ search: input.search, stats: searchStats }),
    // Registered unconditionally (like the file tools) so the tool schema
    // stays byte-identical across users and turns.
    ...buildReadPageTool({ fetcher: input.fetcher }),
    ...buildTimezoneTool({ setTimezone: input.setTimezone }),
    ...buildCountryTool({ setCountry: input.setCountry }),
    ...buildGoogleTools({
      google: input.google,
      timezone: input.timezone ?? "UTC",
      files: input.files,
    }),
    // Registered unconditionally so the tool schema is byte-identical across
    // users and turns. Unwired storage returns normal tool errors.
    ...buildFileTools({
      files: input.files,
      sendFile: input.sendFile,
    }),
    // Registered unconditionally, same reason. Given to the interface agent
    // only: the writer agent cannot message the user, so it must not be able
    // to book a turn that does.
    ...buildScheduleTools({
      schedules: input.schedules,
      timezone,
      onScheduleChanged: input.onScheduleChanged,
    }),
  };

  // The agent's replies are the { replies, accessed } collected by the tool
  // closures above. The runner's returned text is the model's final prose.
  const now = input.now ?? new Date();
  const start = Date.now();
  const pinned = renderPinnedTopics(input.store.getPinnedTopics());

  // The volatile context (current time + timezone + country) rides on the user
  // message being answered, so it sits after the cached history prefix and
  // never invalidates it.
  const convo = buildConversationMessages({
    history: input.history,
    userMessage: input.userMessage,
    trailing: input.trailing,
    now,
    timezone,
    summary: input.summary,
    context: interfaceContext(now, timezone, input.country),
  });
  const lastIdx = convo.length - 1;
  // Cross-turn anchor breakpoint in the messages region. The last stable message
  // is byte-identical next turn, so it is the write that yields the cross-turn
  // history read. The current message's tail is marked by the runner's
  // loop-owned sliding breakpoint (see run.ts), so it is not marked here — that
  // keeps the per-request budget at 4 (system head + system tail + anchor +
  // sliding). Empty history has no stable message to anchor, and the loop's
  // sliding breakpoint covers the single current message.
  const anchor = lastIdx >= 1 ? anchorIndex(convo, lastIdx - 1) : -1;
  if (anchor >= 0) convo[anchor] = markCacheBreakpoint(convo[anchor]);

  await deliverUnclaimed(input.trailing ?? []);

  let injectedFollowups = 0;
  const { finishReason, steps, usage, stepUsages } = await runAgent({
    model: input.model,
    // Static instructions and per-user pinned topics are passed apart so each
    // gets its own cache breakpoint; concatenated they are the same prompt.
    system: interfaceSystemPrompt(),
    systemTail: pinned,
    messages: convo,
    tools,
    maxSteps: input.maxSteps,
    externalCalls: input.externalCalls,
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

  log("interface_completed", {
    steps,
    finish_reason: finishReason,
    replies_count: replies.length,
    accessed_count: accessed.size,
    followups_injected: injectedFollowups,
    duration_ms: Date.now() - start,
    searches: searchStats.calls,
    searches_failed: searchStats.failed,
    searches_empty: searchStats.empty,
    unique_queries: searchStats.queries.size,
    search_ms_total: searchStats.durationMs,
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

  return { replies, accessed: [...accessed] };
};

export type { TopicStore };
