// Turn orchestrator: the in-process glue between the two agents and the store.
// Runtime-agnostic — it knows nothing about alarms, Durable Objects, or
// Telegram, only the Store, a model, and a reply sink. The DO calls this from
// its alarm handler; tests call it directly with MemoryStore + a scripted model.

import { runInterfaceAgent, FALLBACK_MESSAGE } from "./interface";
import { isRateLimitError, RATE_LIMIT_MESSAGE } from "./llm-error";
import { runWriterAgent } from "./writer";
import { usageLogFields } from "./run";
import { log, logError, fmtErr } from "../log";
import type { AgentLabel } from "./model";
import type { AgentModel } from "./protocol";
import type { Store } from "../store/types";
import type { WebSearch } from "../websearch/types";
import type { PageFetcher } from "../pagefetch/types";
import type { GoogleWorkspace } from "../google/types";
import type { AttachmentStore } from "../attachments/types";

const DEFAULT_HISTORY_LIMIT = 20;

export interface TurnInput {
  store: Store;
  // Per-agent model factory. The orchestrator asks it for a tagged model at
  // each agent boundary (interface, research, writer) so gateway logs attribute
  // cost per agent. Tests inject a stub that records the labels requested.
  makeModel: (agent: AgentLabel) => AgentModel;
  send: (text: string) => Promise<void>;
  search: WebSearch;
  // Page-fetch port for the research agent's read_page tool (threaded like
  // `search`).
  fetcher: PageFetcher;
  // Gmail + Calendar access, built by the DO and forwarded to the interface
  // agent (threaded like `search`).
  google: GoogleWorkspace;
  // Attachment blob store (R2), forwarded to the interface agent's
  // view_attachment tool. Optional so tests that don't exercise images can omit
  // it (the tool is then not registered).
  attachments?: AttachmentStore;
  chatId: number;
  topicId: number;
  historyLimit?: number;
  clerkUserId?: string;
  // The user's IANA timezone for the datetime anchor; undefined falls back to
  // UTC in the prompt.
  timezone?: string;
  // Persist a new user timezone (from the set_timezone tool).
  setTimezone?: (tz: string) => void;
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
  const { store, makeModel, send, search, fetcher, google, chatId, topicId } =
    input;
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
    const { accessed, transcript } = await runInterfaceAgent({
      model: makeModel("interface"),
      researchModel: makeModel("research"),
      store,
      send,
      persistReply,
      search,
      fetcher,
      google,
      attachments: input.attachments,
      getAttachment: input.attachments
        ? (id) => store.getAttachment(id)
        : undefined,
      history,
      userMessage,
      timezone: input.timezone,
      setTimezone: input.setTimezone,
      now: input.now,
    });

    // Run the writer every turn, even when nothing was accessed: proactive
    // topic creation must be possible on turns that introduce a brand-new
    // subject. The prompt keeps trivial turns to a single no-tool step.
    const writerStart = Date.now();
    const writerUsage = await runWriterAgent({
      model: makeModel("writer"),
      store,
      accessed,
      transcript,
    });
    log("writer_completed", {
      accessed_count: accessed.length,
      duration_ms: Date.now() - writerStart,
      ...usageLogFields(writerUsage),
    });
  } catch (err) {
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
    const reply = rateLimited ? RATE_LIMIT_MESSAGE : FALLBACK_MESSAGE;
    await send(reply);
    store.storeMessage(conversationId, "assistant", reply);
  } finally {
    store.clearBusy(conversationId);
  }
};
