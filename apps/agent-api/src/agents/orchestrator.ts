// Turn orchestrator: the in-process glue between the two agents and the store.
// Runtime-agnostic — it knows nothing about alarms, Durable Objects, or
// Telegram, only the Store, a model, and a reply sink. The DO calls this from
// its alarm handler; tests call it directly with MemoryStore + a scripted model.

import { runInterfaceAgent, FALLBACK_MESSAGE } from "./interface";
import { isRateLimitError, RATE_LIMIT_MESSAGE } from "./llm-error";
import { log, logError, fmtErr } from "../log";
import { isDurableObjectReset } from "../do/retry";
import type { AgentLabel } from "./model";
import type { AgentModel } from "./protocol";
import {
  applyStalenessFilter,
  contentChars,
  conversationHasWork,
  CONTEXT_MESSAGE_PAGE,
  countTopicReads,
  isTerminalStopReason,
  LEARN_SIZE_THRESHOLD_TOKENS,
  estimateTokens,
  messageText,
} from "../store/messages";
import { createDelivery } from "./delivery";
import type { Store } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { PageFetcher } from "../pagefetch/types";
import type { GoogleWorkspace } from "../google/types";
import type { StoredFile, UserFileStore } from "../files/types";
import type { ScheduleBook } from "../schedules/types";

// No history window: the conversation is rendered as `summary + messages after
// the compaction boundary`, and what bounds it is size-triggered compaction, not
// a ceiling here.

export interface TurnInput {
  store: Store;
  // Per-agent model factory. The orchestrator asks it for a tagged model at
  // each agent boundary (interface, research, writer) so gateway logs attribute
  // cost per agent. Tests inject a stub that records the labels requested.
  makeModel: (agent: AgentLabel) => AgentModel;
  send: (text: string) => Promise<void>;
  // Stop the Telegram "typing" chat action. Called the moment the user's reply
  // has been sent — after the interface phase (including any research it
  // triggered, which the user genuinely waits on) and before the writer runs,
  // and on the failure path right after the fallback is sent. The writer is
  // internal topic consolidation the user is not waiting on, so typing must not
  // span it. Idempotent; optional so direct callers and tests can omit it.
  stopTyping?: () => void;
  search: WebSearch;
  // Page-fetch port for the read_page tool on the interface and research agents
  // (threaded like `search`).
  fetcher: PageFetcher;
  // Gmail + Calendar access, built by the DO and forwarded to the interface
  // agent (threaded like `search`).
  google: GoogleWorkspace;
  // User-owned file storage and active Telegram-topic delivery.
  files?: UserFileStore;
  sendFile?: (file: StoredFile, bytes: Uint8Array) => Promise<void>;
  // What the user has asked to happen later, bound to this conversation, plus
  // the callback that re-arms their timer after a change.
  schedules?: ScheduleBook;
  onScheduleChanged?: () => void;
  chatId: number;
  topicId: number;
  // Test override for how many rows one context read pages in; production uses
  // CONTEXT_MESSAGE_PAGE.
  historyLimit?: number;
  clerkUserId?: string;
  // The user's IANA timezone for the datetime anchor; undefined falls back to
  // UTC in the prompt.
  timezone?: string;
  // Persist a new user timezone (from the set_timezone tool).
  setTimezone?: (tz: string) => void;
  // The user's ISO 3166-1 alpha-2 country code, reserved for market-aware tools.
  country?: string;
  // Persist a new user country (from the set_country tool).
  setCountry?: (country: string) => void;
  // Reference time for the date anchor and relative message ages. Defaults to
  // now; injected in tests for deterministic prompt rendering.
  now?: Date;
  // Report a failure the user experienced to ZeroErrors. Optional and injected
  // by the DO (which owns `env`), so this module stays runtime-agnostic and
  // tests opt in. A DO reset is filtered inside the reporter, not here.
  reportError?: (
    err: unknown,
    context: Record<string, unknown>,
    options: { level: "error" | "warning" },
  ) => Promise<void>;
  // Called when this conversation's rendered context crosses the learning size
  // threshold. The DO wires it to the user's schedule, which asks LearningDO to
  // consolidate and compact this conversation. An event, not a poll: the turn is
  // the only place the rendered size is known.
  onContextTooLarge?: (conversationId: string, tokens: number) => void;
}

// Process one awaiting-reply thread: run the interface agent (which persists
// each reply then sends it live), then consolidate any accessed topics via the
// writer. The tail of history must be the user message being answered. Replies
// are persisted as they are sent (persist-before-send) so a mid-run eviction
// retry sees the tail is already `assistant` and skips the thread — no
// duplicate Telegram messages.
export const runTurn = async (input: TurnInput): Promise<void> => {
  const { store, makeModel, send, search, fetcher, google, chatId, topicId } =
    input;
  const stopTyping = input.stopTyping ?? (() => {});
  const limit = input.historyLimit ?? CONTEXT_MESSAGE_PAGE;

  const conversationId = store.getOrCreateConversation(chatId, topicId);
  // Telegram messages wait in the durable queue until a turn takes them. One
  // transaction moves every queued message for this conversation to the
  // transcript tail in arrival order, so a burst becomes one turn and a reset
  // can neither lose a message nor inject it twice.
  store.drainPendingMessages(conversationId);
  // What the model sees: the summary of the compacted prefix plus the messages
  // after the boundary, capped by the backstop, with topic reads taken at an
  // older knowledge version replaced by a stub.
  const context = store.getConversationContext(conversationId, limit);
  const all = context.messages;
  const tail = all[all.length - 1];
  // The protocol decides whether this conversation owes a response: a queued
  // message (already drained above), a user message or tool result at the tail,
  // or a response that stopped for a non-terminal reason. A terminal assistant
  // tail is idle.
  // A reply is persisted before it is sent, so a reset in that window leaves a
  // finished response nobody read. That state is work even though the response
  // is terminal, and it is delivery work only: re-running the model here would
  // answer the same user message a second time.
  const undeliveredCount =
    tail && tail.role === "assistant" ? store.countUndeliveredBlocks(tail.id) : 0;
  if (!conversationHasWork({ pendingCount: 0, tail, undeliveredCount })) return;
  if (
    tail &&
    tail.kind === "assistant_message" &&
    isTerminalStopReason(tail.stopReason) &&
    undeliveredCount > 0
  ) {
    const lastUserIdx = all.findLastIndex((m) => m.kind === "user_message");
    const { deliverUnclaimed } = createDelivery({
      claim: (messageId, blockIndex) => store.claimDelivery(messageId, blockIndex),
      send: (text) => send(text),
    });
    // This path sends the user a message and calls no model, so it logs nothing
    // else: without this line a recovered reply is invisible, and the only trace
    // is `alarm_finished.turns` counting a thread with no `turn_started`. That
    // is how the 2026-07-30 watermark bug was found — from the mismatch, not
    // from the event.
    log("turn_delivery_recovered", {
      chat_id: chatId,
      topic_id: topicId,
      clerk_user_id: input.clerkUserId,
      blocks: undeliveredCount,
      message_id: tail.id,
    });
    await deliverUnclaimed(all.slice(lastUserIdx + 1));
    stopTyping();
    return;
  }

  const { messages: filtered, stubbed } = applyStalenessFilter(
    all,
    store.getKnowledgeVersion(),
  );
  // The turn answers the newest real user message. Anything after it is what an
  // interrupted run of this same turn already persisted (responses and tool
  // results), which the resumed run continues from rather than replaying.
  const currentIdx = filtered.findLastIndex((m) => m.kind === "user_message");
  if (currentIdx === -1) return;
  const history = filtered.slice(0, currentIdx);
  const userMessage = messageText(filtered[currentIdx].content);
  const trailing = filtered.slice(currentIdx + 1);

  log("turn_started", {
    chat_id: chatId,
    topic_id: topicId,
    clerk_user_id: input.clerkUserId,
    history_len: history.length,
  });

  // The line the compaction threshold is derived from. `total_tokens` is an
  // estimate from characters; the authoritative number is in the gateway logs,
  // but this one is per conversation and available before the call.
  const summaryChars = context.summary?.length ?? 0;
  const messageChars =
    all.reduce((sum, m) => sum + contentChars(m.content), 0) + summaryChars;
  const totalTokens = estimateTokens(messageChars);
  log("context_rendered", {
    chat_id: chatId,
    topic_id: topicId,
    total_tokens: totalTokens,
    summary_tokens: estimateTokens(summaryChars),
    messages_after_boundary: all.length,
    stale_stubs: stubbed,
  });
  // Size trigger. Raised before the model call, not after: a conversation that
  // is already too large is too large whether or not this turn succeeds, and the
  // request only queues a job.
  if (totalTokens >= LEARN_SIZE_THRESHOLD_TOKENS) {
    log("learn_size_requested", {
      chat_id: chatId,
      topic_id: topicId,
      total_tokens: totalTokens,
    });
    input.onContextTooLarge?.(conversationId, totalTokens);
  }

  // Reads that survived the staleness filter are topic knowledge the model does
  // not have to fetch again. This pair is the whole justification for persisting
  // tool results: `topic_reads_avoided` has to outweigh `stale_stubs`.
  log("conversation_size", {
    chat_id: chatId,
    topic_id: topicId,
    message_count: all.length,
    stored_bytes: all.reduce((sum, m) => sum + contentChars(m.content), 0),
  });
  log("topic_reads_avoided", {
    count: countTopicReads(filtered) - stubbed,
  });

  try {
    await runInterfaceAgent({
      model: makeModel("interface"),
      researchModel: makeModel("research"),
      store,
      send,
      // Persist the log as the loop runs: the response before its tools, the
      // results before the next call. A reset therefore resumes rather than
      // replaying, and a delivery claim keeps a sent block from being sent
      // twice.
      persistAssistant: (content, stopReason, responseId) =>
        store.storeMessage(conversationId, "assistant", content, {
          stopReason,
          responseId,
        }),
      persistToolResults: (results) =>
        store.storeMessage(conversationId, "user", results, {
          kind: "tool_result",
        }),
      claimDelivery: (messageId, blockIndex) =>
        store.claimDelivery(messageId, blockIndex),
      // Telegram messages that arrived mid-run, taken only where the loop would
      // otherwise stop.
      drainFollowups: () => store.drainPendingMessages(conversationId),
      externalCalls: {
        begin: (toolUseId, tool) => store.beginExternalCall(toolUseId, tool),
        complete: (toolUseId, result) =>
          store.completeExternalCall(toolUseId, result),
      },
      trailing,
      search,
      fetcher,
      google,
      files: input.files,
      sendFile: input.sendFile,
      schedules: input.schedules,
      onScheduleChanged: input.onScheduleChanged,
      history,
      summary: context.summary ?? undefined,
      userMessage,
      timezone: input.timezone,
      setTimezone: input.setTimezone,
      setCountry: input.setCountry,
      now: input.now,
    });

    // The reply is out and the turn is over. Consolidating what was learned is
    // no longer part of a turn: it happens per idle period or per size threshold
    // in LearningDO, off this path entirely, so nothing the user is waiting on
    // sits behind it.
    stopTyping();
  } catch (err) {
    // A DO isolate reset (a new Worker version deployed mid-turn) is not an
    // agent failure: the platform's at-least-once alarm retry re-runs this turn
    // on a fresh isolate. The reply path is persist-before-send, so nothing was
    // committed or sent for this turn — the tail stays `user` and the retry
    // delivers exactly once. Send nothing, persist nothing, rethrow so the
    // uncaught throw leaves alarm() and triggers that retry. Sending the
    // fallback here would just be a premature, now-redundant "try again" the
    // user does not need.
    if (isDurableObjectReset(err)) {
      log("turn_reset_retrying", {
        chat_id: chatId,
        topic_id: topicId,
        clerk_user_id: input.clerkUserId,
        error: fmtErr(err),
      });
      throw err;
    }
    // The agent path threw (LLM gateway error, malformed tool loop, etc.).
    // Tell the user and persist the fallback as an assistant message so the
    // thread stops awaiting reply — this prevents the next alarm from
    // reprocessing a poison message into a retry storm. We do not rethrow:
    // an identical retry will not fix agent-level failures, and swallowing
    // keeps the user informed. Durability for enqueue still comes from the
    // alarm being re-armed by enqueueTurn.
    //
    // A rate-limit / usage-cap / overloaded (429/529) failure gets an honest
    // message telling the user we're temporarily at our usage limit, instead
    // of the generic fallback that invites a pointless immediate retry. The
    // logged fmtErr still carries the status + rate-limit headers so operators
    // can tell a short throttle from a hard cap.
    const rateLimited = isRateLimitError(err);
    logError(rateLimited ? "turn_rate_limited" : "turn_failed", {
      chat_id: chatId,
      topic_id: topicId,
      error: fmtErr(err),
    });
    // The user just got a fallback instead of an answer, so this is a defect
    // worth a ZeroErrors issue. Awaited (not fire-and-forget) because a DO
    // alarm ends the moment this returns; the reporter never rejects.
    await input.reportError?.(
      err,
      {
        site: rateLimited ? "turn_rate_limited" : "turn",
        chat_id: chatId,
        topic_id: topicId,
        clerk_user_id: input.clerkUserId,
      },
      // A throttle is upstream capacity, not a bug in us: it is a warning so it
      // does not sit next to real defects.
      { level: rateLimited ? "warning" : "error" },
    );
    const reply = rateLimited ? RATE_LIMIT_MESSAGE : FALLBACK_MESSAGE;
    // Same discipline as an ordinary reply: persist, claim, send. Without the
    // claim this row looks like a reply that was written and never sent, and
    // the next scan would deliver the fallback a second time.
    const replyId = store.storeMessage(conversationId, "assistant", reply);
    if (store.claimDelivery(replyId, 0)) await send(reply);
    // The failure reply is out; stop typing on this path too (it is idempotent
    // if the interface phase already stopped it before a writer-phase throw).
    stopTyping();
  }
  // "Returned", not "succeeded": a handled agent failure reaches here too (it
  // sent the fallback), and only the DO-reset path rethrows past it. That is
  // exactly the signal wanted — it separates a failed turn from a stalled
  // invocation, which produces no log and no exception at all.
  log("turn_completed", { chat_id: chatId, topic_id: topicId });
};
