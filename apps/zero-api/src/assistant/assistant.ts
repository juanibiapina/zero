import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  AgentChange,
  CommitPublication,
  ConversationId,
  EntryRecord,
  Harness,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { FALLBACK_MESSAGE } from "../agents/fallback";
import { RATE_LIMIT_MESSAGE } from "../agents/llm-error";
import {
  completeJob,
  EMPTY_STATE,
  JOB_KEY,
  logJobQueued,
  requestJob,
  type LearnReason,
  type LearningJob,
  type LearningState,
} from "../do/learning-job";
import { log, logError, fmtErr } from "../log";
import { estimateTokens } from "../store/messages";
import { BACKGROUND } from "./context";
import type { AgentKind } from "./harness";
import type { ChatRef, ChatRow, Ledger, OperationRow } from "./ledger";

export const CHECK_INTERVAL_MS = 30_000;
export const TYPING_INTERVAL_MS = 4_000;
export const LEARN_JOB_BUDGET_TOKENS = 40_000;
const MAX_RENDERED_RESULT_CHARS = 2_000;
const ENTRY_PAGE = 200;
const DELIVERABLE = new Set(["stop", "length", "toolUse"]);

export interface OperationResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
}

export interface AssistantHost {
  pi(): Promise<Harness>;
  agents(): Promise<Record<AgentKind, AgentChange>>;
  createSession(change: AgentChange): Promise<string>;
  submit(session: string, text: string, operationId: string): Promise<void>;
  wait(session: string, operationId: string): Promise<OperationResult>;
  reset(session: string): Promise<void>;
  scheduleCheck(at: number): Promise<void>;
}

export interface TelegramPort {
  send(chat: ChatRef, text: string): Promise<void>;
  typing(chat: ChatRef): Promise<void>;
}

export type ReportError = (
  err: unknown,
  context: Record<string, unknown>,
  options: { level: "error" | "warning" },
) => Promise<void>;

export interface AssistantDeps {
  host: AssistantHost;
  ledger: Ledger;
  telegram: TelegramPort;
  reportError?: ReportError;
  clerkUserId?: string;
  turnFields?: (session: string) => Record<string, unknown>;
  now?: () => number;
}

export interface AssistantJob {
  kind: Extract<AgentKind, "onboarding" | "admin">;
  jobId: string;
  prompt: string;
}

export interface Assistant {
  start(): Promise<void>;
  submit(input: {
    chat: ChatRef;
    conversationId: string;
    text: string;
    operationId: string;
  }): Promise<void>;
  reset(chat: ChatRef): Promise<void>;
  runJob(job: AssistantJob): Promise<OperationResult>;
  learn(reason: LearnReason, conversationId?: string): Promise<void>;
  check(): Promise<boolean>;
  chatFor(session: string): ChatRow | null;
  sessionOf(conversationId: ConversationId): string;
}

const textBlocks = (message: AssistantMessage): { index: number; text: string }[] =>
  message.content.flatMap((part, index) =>
    part.type === "text" && part.text.trim() !== "" ? [{ index, text: part.text }] : [],
  );

const assistantOf = (entry: EntryRecord): AssistantMessage | null => {
  if (entry.kind !== "pi.assistant") return null;
  const message = entry.model?.[0];
  return message?.role === "assistant" ? message : null;
};

const detailText = (record: SubmissionRecord): string => {
  if (record.status !== "unanswered") return "";
  const detail = record.detail;
  return typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
};

const isRateLimit = (record: SubmissionRecord): boolean =>
  record.status === "unanswered" &&
  /\((429|529)\)|rate.?limit|overloaded/i.test(detailText(record));

const NO_FALLBACK = new Set(["aborted", "reset", "stale"]);

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

const renderMessage = (message: Message): string | null => {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return `User: ${text}`;
  }
  if (message.role === "assistant") {
    const parts = message.content.flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "toolCall") return [`[called ${part.name}]`];
      return [];
    });
    return parts.length === 0 ? null : `Assistant: ${parts.join("\n")}`;
  }
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : "[image]"))
          .join("\n");
  return `Assistant: [tool result] ${truncate(text, MAX_RENDERED_RESULT_CHARS)}`;
};

const LEARNABLE = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);

export const learnerPrompt = (sections: string[]): string =>
  `# Messages since the last consolidation\n\n${sections.join("\n\n")}\n\nConsolidate what these messages establish about the user into topics.`;

export const createAssistant = (deps: AssistantDeps): Assistant => {
  const { host, ledger, telegram } = deps;
  const now = deps.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();
  const typing = new Map<string, ReturnType<typeof setInterval>>();
  let unsubscribe: (() => void) | undefined;

  const serial = (key: string, work: () => Promise<void>): Promise<void> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.catch((err) =>
      logError("assistant_work_failed", { key, error: fmtErr(err) }),
    );
    queues.set(key, settled);
    return settled;
  };

  const conversation = async (session: string) => {
    const pi = await host.pi();
    const found = await pi.conversation(Number(session) as ConversationId, BACKGROUND);
    if (!found) throw new Error(`unknown session ${session}`);
    return found;
  };

  const entriesAfter = async (
    session: string,
    after: number,
    through?: number,
  ): Promise<EntryRecord[]> => {
    const convo = await conversation(session);
    const out: EntryRecord[] = [];
    let cursor;
    do {
      const page = await convo.entries(
        {
          minEntryId: (after + 1) as EntryRecord["id"],
          ...(through === undefined ? {} : { maxEntryId: through as EntryRecord["id"] }),
        },
        ENTRY_PAGE,
        cursor,
        BACKGROUND,
      );
      out.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return out.reverse();
  };

  const startTyping = (row: ChatRow): void => {
    if (typing.has(row.session)) return;
    const tick = () => void telegram.typing(row).catch(() => {});
    tick();
    typing.set(row.session, setInterval(tick, TYPING_INTERVAL_MS));
  };

  const stopTyping = (session: string): void => {
    const timer = typing.get(session);
    if (timer) clearInterval(timer);
    typing.delete(session);
  };

  const flush = (session: string): Promise<void> =>
    serial(`flush:${session}`, async () => {
      const row = ledger.chatBySession(session);
      if (!row) return;
      const entries = await entriesAfter(session, row.sentThrough);
      for (const entry of entries) {
        const message = assistantOf(entry);
        if (message && DELIVERABLE.has(message.stopReason)) {
          for (const block of textBlocks(message)) {
            if (!ledger.claimDelivery(entry.id, block.index)) {
              log("delivery_skipped", { block_index: block.index });
              continue;
            }
            try {
              await telegram.send(row, block.text);
            } catch (err) {
              logError("telegram_delivery_failed", { error: fmtErr(err) });
              await deps.reportError?.(err, { site: "delivery", clerk_user_id: deps.clerkUserId }, { level: "error" });
            }
          }
        }
        ledger.setSentThrough(session, entry.id);
      }
    });

  const submissionOf = async (op: OperationRow): Promise<SubmissionRecord | undefined> => {
    const pi = await host.pi();
    return pi.commit(
      (tx) => tx.submissionByRequest(Number(op.session) as ConversationId, op.operationId),
      BACKGROUND,
    );
  };

  const deliveredInRun = async (session: string, record: SubmissionRecord): Promise<boolean> => {
    if (record.status !== "done") return false;
    const entries = await entriesAfter(session, Number(record.entry), Number(record.answer));
    return entries.some((entry) => {
      const message = assistantOf(entry);
      return message !== null && DELIVERABLE.has(message.stopReason) && textBlocks(message).length > 0;
    });
  };

  const sendFallback = async (op: OperationRow, row: ChatRow, record: SubmissionRecord) => {
    const key = `fallback:${op.operationId}`;
    if (ledger.getValue<boolean>(key)) return;
    ledger.putValue(key, true);
    const rateLimited = isRateLimit(record);
    const reason = record.status === "unanswered" ? record.reason : "no_reply";
    logError(rateLimited ? "turn_rate_limited" : "turn_failed", {
      chat_id: row.chatId,
      topic_id: row.topicId,
      reason,
      detail: detailText(record) || undefined,
    });
    await deps.reportError?.(
      new Error(`turn ${reason}: ${detailText(record)}`),
      {
        site: rateLimited ? "turn_rate_limited" : "turn",
        chat_id: row.chatId,
        topic_id: row.topicId,
        clerk_user_id: deps.clerkUserId,
      },
      { level: rateLimited ? "warning" : "error" },
    );
    try {
      await telegram.send(row, rateLimited ? RATE_LIMIT_MESSAGE : FALLBACK_MESSAGE);
    } catch (err) {
      logError("telegram_delivery_failed", { error: fmtErr(err) });
    }
  };

  const finishChat = async (op: OperationRow, record: SubmissionRecord) => {
    const row = ledger.chatBySession(op.session);
    if (row) {
      await flush(op.session);
      const needsFallback =
        record.status === "unanswered"
          ? !NO_FALLBACK.has(record.reason)
          : !(await deliveredInRun(op.session, record));
      if (needsFallback) await sendFallback(op, row, record);
      log("interface_completed", {
        chat_id: row.chatId,
        topic_id: row.topicId,
        status: record.status,
        reason: record.status === "unanswered" ? record.reason : undefined,
        duration_ms: now() - op.createdAt,
        ...deps.turnFields?.(op.session),
      });
      log("turn_completed", { chat_id: row.chatId, topic_id: row.topicId });
    }
    ledger.finishOperation(op.operationId);
    const stillBusy = ledger
      .operations()
      .some((other) => other.kind === "chat" && other.session === op.session);
    if (!stillBusy) stopTyping(op.session);
  };

  const learningState = (): LearningState =>
    ledger.getValue<LearningState>(JOB_KEY) ?? EMPTY_STATE;

  const finishLearning = async (op: OperationRow, record: SubmissionRecord) => {
    const state = learningState();
    const job = state.active;
    const jobId = op.operationId.slice("learn:".length);
    ledger.finishOperation(op.operationId);
    if (!job || job.id !== jobId) return;
    const plan = ledger.getValue<{ through: Record<string, number>; truncated: boolean }>(
      `learn-plan:${job.id}`,
    );
    if (record.status === "done" && plan) {
      for (const [session, through] of Object.entries(plan.through)) {
        ledger.setConsolidatedThrough(session, through);
      }
      log("learn_completed", {
        reason: job.reason,
        sessions: Object.keys(plan.through).length,
        duration_ms: now() - op.createdAt,
      });
    } else {
      logError("learn_failed", {
        reason: job.reason,
        status: record.status,
        detail: record.status === "unanswered" ? record.reason : undefined,
      });
      await deps.reportError?.(
        new Error(`learning ${record.status === "unanswered" ? record.reason : "failed"}`),
        { site: "learning", clerk_user_id: deps.clerkUserId },
        { level: "error" },
      );
    }
    const { state: next, next: successor } = completeJob(state);
    ledger.putValue(JOB_KEY, next);
    if (record.status === "done" && plan?.truncated && !successor) {
      await learn("idle");
      return;
    }
    if (successor) await startLearning(successor);
  };

  const settleOne = async (op: OperationRow): Promise<boolean> => {
    const record = await submissionOf(op);
    if (!record) return true;
    if (record.status !== "done" && record.status !== "unanswered") return true;
    if (op.kind === "chat") await finishChat(op, record);
    else if (op.kind === "learn") await finishLearning(op, record);
    else ledger.finishOperation(op.operationId);
    return false;
  };

  const settle = (): Promise<void> =>
    serial("settle", async () => {
      for (const op of ledger.operations()) await settleOne(op);
    });

  const check = async (): Promise<boolean> => {
    const state = learningState();
    if (state.active && !ledger.jobSession(`learn:${state.active.id}`)) {
      await startLearning(state.active);
    }
    for (const row of ledger.chats()) {
      if (ledger.operations().some((op) => op.session === row.session)) await flush(row.session);
    }
    await settle();
    const pending = ledger.operations().length > 0;
    if (pending) await host.scheduleCheck(now() + CHECK_INTERVAL_MS);
    return pending;
  };

  const onCommit = (publication: CommitPublication): void => {
    const flushes = new Set<string>();
    let settled = false;
    for (const change of publication.changes) {
      if (change.type === "entry" && change.value.kind === "pi.assistant") {
        flushes.add(String(change.value.conversationId));
      }
      if (
        change.type === "submission" &&
        (change.value.status === "done" || change.value.status === "unanswered")
      ) {
        settled = true;
      }
    }
    queueMicrotask(() => {
      for (const session of flushes) {
        if (ledger.chatBySession(session)) void flush(session);
      }
      if (settled) void settle();
    });
  };

  const ensureChat = async (chat: ChatRef, conversationId: string): Promise<ChatRow> => {
    const existing = ledger.chat(chat);
    if (existing) return existing;
    const agents = await host.agents();
    const session = await host.createSession(agents.interface);
    ledger.addChat({ ...chat, conversationId, session });
    return ledger.chat(chat)!;
  };

  const track = async (op: OperationRow, text: string): Promise<void> => {
    ledger.addOperation(op);
    await host.submit(op.session, text, op.operationId);
    await host.scheduleCheck(now() + CHECK_INTERVAL_MS);
  };

  const buildLearningInput = async () => {
    const sections: string[] = [];
    const through: Record<string, number> = {};
    let tokens = 0;
    let truncated = false;
    let index = 0;
    for (const row of ledger.chats()) {
      if (truncated) break;
      const lines: string[] = [];
      for (const entry of await entriesAfter(row.session, row.consolidatedThrough)) {
        if (!LEARNABLE.has(entry.kind)) {
          through[row.session] = entry.id;
          continue;
        }
        const rendered = (entry.model ?? []).map(renderMessage).filter((line) => line !== null);
        const cost = estimateTokens(rendered.join("\n\n").length);
        if (tokens > 0 && tokens + cost > LEARN_JOB_BUDGET_TOKENS) {
          truncated = true;
          break;
        }
        tokens += cost;
        lines.push(...rendered);
        through[row.session] = entry.id;
      }
      if (lines.length > 0) {
        index++;
        sections.push(`## Conversation ${index}\n\n${lines.join("\n\n")}`);
      }
    }
    return { sections, through, tokens, truncated };
  };

  const startLearning = async (job: LearningJob): Promise<void> => {
    if (ledger.jobSession(`learn:${job.id}`)) return;
    const input = await buildLearningInput();
    if (input.sections.length === 0) {
      for (const [session, through] of Object.entries(input.through)) {
        ledger.setConsolidatedThrough(session, through);
      }
      log("learn_skipped", { reason: "nothing_unconsolidated" });
      const { state: next, next: successor } = completeJob(learningState());
      ledger.putValue(JOB_KEY, next);
      if (successor) await startLearning(successor);
      return;
    }
    ledger.putValue(`learn-plan:${job.id}`, { through: input.through, truncated: input.truncated });
    const agents = await host.agents();
    const session = await host.createSession(agents.learner);
    ledger.addJobSession(`learn:${job.id}`, session);
    log("learn_started", {
      reason: job.reason,
      input_tokens: input.tokens,
      truncated: input.truncated,
      queue_age_ms: now() - job.requestedAt,
    });
    await track(
      { operationId: `learn:${job.id}`, kind: "learn", session, createdAt: now() },
      learnerPrompt(input.sections),
    );
  };

  const learn = async (reason: LearnReason, conversationId?: string): Promise<void> => {
    const current = learningState();
    const { state, startNow, coalesced } = requestJob(current, {
      id: crypto.randomUUID(),
      reason,
      conversationId,
      requestedAt: now(),
    });
    ledger.putValue(JOB_KEY, state);
    if (state.active) {
      logJobQueued({ job: state.active, coalesced, successorPending: state.queued !== null });
    }
    if (startNow && state.active) await startLearning(state.active);
  };

  let starting: Promise<void> | undefined;
  const begin = async (): Promise<void> => {
    const pi = await host.pi();
    unsubscribe?.();
    unsubscribe = pi.subscribeCommits(onCommit);
    for (const op of ledger.operations()) {
      if (op.kind !== "chat") continue;
      const row = ledger.chatBySession(op.session);
      if (row) startTyping(row);
    }
    await host.scheduleCheck(now());
  };
  const started = (): Promise<void> => {
    starting ??= begin().catch((err) => {
      starting = undefined;
      throw err;
    });
    return starting;
  };

  return {
    start: started,

    async submit({ chat, conversationId, text, operationId }) {
      await started();
      const row = await ensureChat(chat, conversationId);
      startTyping(row);
      log("turn_started", {
        chat_id: chat.chatId,
        topic_id: chat.topicId,
        clerk_user_id: deps.clerkUserId,
      });
      await track({ operationId, kind: "chat", session: row.session, createdAt: now() }, text);
    },

    async reset(chat) {
      await started();
      const row = ledger.chat(chat);
      if (row) await host.reset(row.session);
    },

    async runJob(job) {
      await started();
      const operationId = `job:${job.jobId}`;
      let session = ledger.jobSession(operationId);
      if (!session) {
        const agents = await host.agents();
        session = await host.createSession(agents[job.kind]);
        ledger.addJobSession(operationId, session);
      }
      await track({ operationId, kind: "job", session, createdAt: now() }, job.prompt);
      return host.wait(session, operationId);
    },

    learn: async (reason, conversationId) => {
      await started();
      await learn(reason, conversationId);
    },
    check: async () => {
      await started();
      return check();
    },
    chatFor: (session) => ledger.chatBySession(session),
    sessionOf: (conversationId) => String(conversationId),
  };
};
