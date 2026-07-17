// Turn orchestrator: the in-process glue between the two agents and the store.
// Runtime-agnostic — it knows nothing about alarms, Durable Objects, or
// Telegram, only the Store, a model, and a reply sink. The DO calls this from
// its alarm handler; tests call it directly with MemoryStore + a scripted model.

import { runInterfaceAgent, FALLBACK_MESSAGE } from "./interface";
import { runWriterAgent } from "./writer";
import { log, logError, fmtErr } from "../log";
import type { LanguageModel } from "ai";
import type { Store } from "../store/types";
import type { WebSearch } from "../websearch/types";

const DEFAULT_HISTORY_LIMIT = 20;

export interface TurnInput {
  store: Store;
  model: LanguageModel;
  send: (text: string) => Promise<void>;
  search: WebSearch;
  chatId: number;
  topicId: number;
  historyLimit?: number;
  clerkUserId?: string;
  // Reference time for the date anchor and relative message ages. Defaults to
  // now; injected in tests for deterministic prompt rendering.
  now?: Date;
}

// Process one awaiting-reply thread: run the interface agent (which persists
// each reply then sends it live), then consolidate any accessed topics via the
// writer. The tail of history must be the user message being answered. Replies
// are persisted as they are sent (persist-before-send) so a mid-run eviction
// retry sees the tail is already `assistant` and skips the thread — no
// duplicate Telegram messages.
export const runTurn = async (input: TurnInput): Promise<void> => {
  const { store, model, send, search, chatId, topicId } = input;
  const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const conversationId = store.getOrCreateConversation(chatId, topicId);
  const all = store.getConversationHistory(conversationId, limit);
  const last = all[all.length - 1];
  if (!last || last.role !== "user") return;

  const userMessage = last.content;
  const history = all.slice(0, -1);

  log("turn_started", {
    chat_id: chatId,
    topic_id: topicId,
    clerk_user_id: input.clerkUserId,
    history_len: history.length,
  });

  const persistReply = (text: string) =>
    store.storeMessage(conversationId, "assistant", text);

  store.markBusy(conversationId);
  try {
    const { replies, accessed } = await runInterfaceAgent({
      model,
      store,
      send,
      persistReply,
      search,
      history,
      userMessage,
      now: input.now,
    });

    // Run the writer every turn, even when nothing was accessed: proactive
    // topic creation must be possible on turns that introduce a brand-new
    // subject. The prompt keeps trivial turns to a single no-tool step.
    const writerStart = Date.now();
    await runWriterAgent({
      model,
      store,
      accessed,
      exchange: { user: userMessage, assistant: replies },
    });
    log("writer_completed", {
      accessed_count: accessed.length,
      duration_ms: Date.now() - writerStart,
    });
  } catch (err) {
    // The agent path threw (LLM gateway error, malformed tool loop, etc.).
    // Tell the user and persist the fallback as an assistant message so the
    // thread stops awaiting reply — this prevents the next alarm from
    // reprocessing a poison message into a retry storm. We do not rethrow:
    // an identical retry will not fix agent-level failures, and swallowing
    // keeps the user informed. Durability for enqueue still comes from the
    // alarm being re-armed by enqueueTurn.
    logError("turn_failed", {
      chat_id: chatId,
      topic_id: topicId,
      error: fmtErr(err),
    });
    await send(FALLBACK_MESSAGE);
    store.storeMessage(conversationId, "assistant", FALLBACK_MESSAGE);
  } finally {
    store.clearBusy(conversationId);
  }
};
