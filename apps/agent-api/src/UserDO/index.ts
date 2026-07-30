import { DurableObject } from "cloudflare:workers";
import { createDb, type Database } from "do-orm";
import { migrate } from "do-orm";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import { sendMessage } from "../telegram/send-message";
import { DbStore } from "../store/db";
import {
  SystemTopicStore,
  systemTopicsFingerprint,
} from "../store/system-topics";
import type { Store } from "../store/types";
import { createR2Attachments } from "../attachments/r2";
import type { AttachmentStore } from "../attachments/types";
import { createModel, createModelFactory } from "../agents/model";
import { createBraveSearch } from "../websearch/brave";
import { createTavilyFetcher } from "../pagefetch/tavily";
import { createGoogleWorkspace } from "../google/rest";
import { getGoogleAccessToken, memoizeTokenProvider } from "../google-token";
import { runTurn as orchestrateTurn } from "../agents/orchestrator";
import { runOnboardingAgent } from "../agents/onboarding";
import { runAdminTaskAgent } from "../agents/admin-task";
import { runAlarmTurns } from "../do/alarm";
import {
  ADMIN_TASK_KEY,
  queueAdminTask,
  runAdminTask,
  toAdminTaskStatus,
  type AdminTask,
  type AdminTaskStatus,
} from "../do/admin-task";
import { reportError } from "../reporting/zero-errors";
import { runOnboarding } from "../do/onboarding";
import { getScheduleDO } from "../ScheduleDO/stub";
import { requestLearnSafely, touchScheduleSafely } from "../do/schedule";
import type { Env } from "../types";

// How often the typing loop re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;

// The stable pinned topic seeded by Google onboarding. The name never changes;
// the user's actual name is a fact recorded in the body (see docs/onboarding.md).
// Marks the one-time link reconciliation that follows migration 0022.
const LINKS_REBUILT_KEY = "topicLinksRebuiltV22";

const USER_TOPIC = "User";
const USER_TOPIC_DESCRIPTION =
  "Durable facts about the user: name, location, role, languages, key relationships.";


export class UserDO extends DurableObject<Env> {
  private db: Database;
  // Wrapped in SystemTopicStore so the read-only system topics (Zero,
  // Changelog) are overlaid on every read and blocked from writes. See
  // store/system-topics.ts.
  private store: Store;
  // Attachment bytes (R2). Metadata rows live in `store`; bytes live here.
  private attachments: AttachmentStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    const dbStore = new DbStore(this.db);
    this.store = new SystemTopicStore(dbStore);
    this.attachments = createR2Attachments(env.ATTACHMENTS);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
      // Migration 0022 folded legacy topic summaries into bodies, so link rows
      // derived from those bodies can be missing a [[Name]] the folded text
      // introduced. SQL cannot parse the tokens; re-derive them once here.
      if (!(await ctx.storage.get(LINKS_REBUILT_KEY))) {
        dbStore.rebuildAllLinks();
        await ctx.storage.put(LINKS_REBUILT_KEY, true);
      }
      // Bundled system topics live in no user's SQLite, so a build that changes
      // their text must still invalidate persisted reads of them. This bumps
      // the knowledge version once per content change, never per boot.
      dbStore.syncSystemTopicsFingerprint(systemTopicsFingerprint());
    });
  }

  // --- Conversations and messages ---

  resetConversation(chatId: number, topicId: number): void {
    this.store.resetConversation(chatId, topicId);
  }

  // --- Turn execution (DO alarm) ---

  // Cheap, synchronous-ish enqueue: dedupe the webhook update, store the user
  // message, and arm the alarm. No LLM work here (the webhook waitUntil caps at
  // ~30s); the turn runs in alarm() with a much larger budget.
  async enqueueTurn(input: {
    updateId: string;
    clerkUserId: string;
    chatId: number;
    topicId: number;
    text: string;
    // Attachment metadata rows to persist for this turn. Bytes are already in
    // R2 (the webhook put them); the message text carries their markers.
    attachments?: Array<{
      id: string;
      r2Key: string;
      filename: string;
      mimeType: string;
    }>;
  }): Promise<void> {
    if (!this.store.markProcessed(input.updateId)) return;
    await this.ctx.storage.put("clerkUserId", input.clerkUserId);
    const conversationId = this.store.getOrCreateConversation(
      input.chatId,
      input.topicId,
    );
    for (const a of input.attachments ?? []) {
      this.store.putAttachment({ ...a, conversationId });
    }
    // The message enters the durable queue, not the transcript. A turn injects
    // it at a safe point, so a message arriving while the agent is mid-run is
    // never spliced into a request the model is already answering.
    this.store.enqueuePendingMessage(conversationId, input.text);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
    // The conversation is active again: push its idle-learning deadline out to
    // now + 1h. After the durable enqueue, never after the turn — an LLM failure
    // must not make an active conversation look idle. Best-effort: a schedule
    // problem must not reject the user's message.
    await touchScheduleSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      conversationId,
    );
  }

  // Queue one admin-authored task. A queued task is a conflict; a terminal
  // task is intentionally replaceable for manual retries after a partial run.
  async queueAdminTask(input: {
    clerkUserId: string;
    prompt: string;
  }): Promise<boolean> {
    const queued = await queueAdminTask(this.ctx.storage, {
      ...input,
      status: "queued",
    });
    if (queued) {
      await getScheduleDO(this.env, input.clerkUserId).requestJob(
        input.clerkUserId,
        "admin_task",
      );
    }
    return queued;
  }

  // Never expose the queued prompt through an RPC response.
  async getAdminTaskStatus(): Promise<AdminTaskStatus | null> {
    const task = await this.ctx.storage.get<AdminTask>(ADMIN_TASK_KEY);
    return task ? toAdminTaskStatus(task) : null;
  }

  // The turn runner, and nothing else. A DO has exactly one alarm, so anything
  // else that shared it eventually delayed a reply: on 2026-07-29 an admin task
  // and onboarding sat in front of a queued user message for a quarter of an
  // hour. Those deadlines now live in ScheduleDO, which calls
  // runQueuedAdminTask / runQueuedOnboarding below.
  //
  // A concurrent enqueueTurn arms a fresh alarm (this handler cleared the old
  // one on entry), so messages that arrive mid-run are picked up on the next
  // fire. On a catchable failure runAlarmTurns self-reschedules with backoff
  // while any thread still awaits reply, and returns normally (never rethrows,
  // which would discard the reschedule). See do/alarm.ts.
  override async alarm(): Promise<void> {
    await runAlarmTurns({
      storage: this.ctx.storage,
      findConversationsWithWork: () => this.store.findConversationsWithWork(),
      runTurn: (chatId, topicId) => this.runTurn(chatId, topicId),
      reportError: (err) => reportError(this.env, err, { site: "alarm_turn" }),
    });
  }

  // Run the queued admin task, if there is one. Called by ScheduleDO when the
  // deadline it holds for this job comes due. A no-op when nothing is queued, so
  // a duplicate dispatch cannot re-run a finished task.
  async runQueuedAdminTask(): Promise<void> {
    const task = await this.ctx.storage.get<AdminTask>(ADMIN_TASK_KEY);
    if (task?.status !== "queued") return;
    await runAdminTask({
      task,
      runAgent: async (prompt) => {
        const model = await createModel(this.env, task.clerkUserId, "admin_task");
        return runAdminTaskAgent({ model, store: this.store, prompt });
      },
      setTask: (terminalTask) =>
        this.ctx.storage.put(ADMIN_TASK_KEY, terminalTask),
    });
  }

  // Run Google onboarding, if it is queued. Called by ScheduleDO, same shape as
  // runQueuedAdminTask.
  async runQueuedOnboarding(): Promise<void> {
    if (this.store.getSettings().googleOnboardingStatus !== "queued") return;
    await this.runOnboarding();
  }

  // Queue Google onboarding: set status `queued` and arm the alarm. Idempotent
  // by default — once the status leaves `null` (queued/done/failed) this
  // no-ops, so the web app's fire-once effect onboards a user at most once.
  // `force` bypasses the guard to re-run for an already-onboarded user
  // (re-running is idempotent: it re-authors the same pinned topic). Called by
  // POST /api/onboarding/google.
  async queueOnboarding(clerkUserId: string, force = false): Promise<void> {
    if (!force && this.store.getSettings().googleOnboardingStatus !== null)
      return;
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    this.store.setGoogleOnboardingStatus("queued");
    await getScheduleDO(this.env, clerkUserId).requestJob(
      clerkUserId,
      "onboarding",
    );
  }

  // Run the one-shot Gmail onboarding scan. Builds the per-user model and
  // memoized Google token, then delegates the topic-seeding + status state
  // machine to do/onboarding.ts (kept there so it is testable without a DO).
  private async runOnboarding(): Promise<void> {
    const clerkUserId =
      (await this.ctx.storage.get<string>("clerkUserId")) ?? "unknown";
    const model = await createModel(this.env, clerkUserId, "onboarding");
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);

    await runOnboarding({
      store: this.store,
      topicName: USER_TOPIC,
      description: USER_TOPIC_DESCRIPTION,
      runAgent: (topicName) =>
        runOnboardingAgent({ model, store: this.store, google, topicName }),
      setStatus: (status) => this.store.setGoogleOnboardingStatus(status),
    });
  }

  // Run one thread end to end inside the DO: local typing loop, model creation
  // (per-user gateway tagging), then the runtime-agnostic orchestrator. The
  // typing loop is a self-rescheduling setTimeout, not the DO alarm timer, so
  // the alarm stays dedicated to turn scheduling. The orchestrator stops the
  // loop the moment the reply is sent (before the writer phase), so "typing"
  // never lingers through internal topic consolidation.
  private async runTurn(chatId: number, topicId: number): Promise<void> {
    const clerkUserId =
      (await this.ctx.storage.get<string>("clerkUserId")) ?? "unknown";
    const makeModel = await createModelFactory(this.env, clerkUserId);
    const search = createBraveSearch(this.env.BRAVE_API_KEY);
    const fetcher = createTavilyFetcher(this.env.TAVILY_API_KEY);
    // Memoized Google token provider: the first Google tool call mints a token
    // via Clerk and caches the promise for the turn; turns that never touch
    // Google make zero Clerk calls. A ~1h token outlives any turn.
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);
    const timezone = this.store.getSettings().timezone ?? undefined;
    const setTimezone = (tz: string) =>
      this.store.updateSettings({ timezone: tz });
    const send = (text: string) => sendMessage(this.env, chatId, topicId, text);

    let timer: ReturnType<typeof setTimeout> | undefined;
    // stopTyping cancels the pending refresh so no tick reschedules. Idempotent:
    // the orchestrator calls it the moment the reply is sent (before the writer
    // runs and on the failure path), and the finally calls it again as a safety
    // net so a refresh never outlives the turn even on an early return.
    const stopTyping = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const tick = () => {
      void sendChatAction(this.env, chatId, topicId).catch(() => {});
      timer = setTimeout(tick, TYPING_INTERVAL_MS);
    };
    tick();
    try {
      await orchestrateTurn({
        store: this.store,
        makeModel,
        send,
        stopTyping,
        search,
        fetcher,
        google,
        attachments: this.attachments,
        chatId,
        topicId,
        clerkUserId,
        timezone,
        setTimezone,
        // A conversation that has grown past the threshold asks for learning
        // now instead of waiting to go idle, which is what covers the
        // always-active user. Fire-and-forget and best-effort: the reply must
        // not wait on a scheduling round trip.
        onContextTooLarge: (conversationId) => {
          void requestLearnSafely(
            getScheduleDO(this.env, clerkUserId),
            clerkUserId,
            "size",
            conversationId,
          );
        },
      });
    } finally {
      stopTyping();
    }
  }

  // --- Telegram link / settings RPC (delegate to the Store) ---
  // These stay public: routes/user-settings.ts and routes/admin.ts call them.

  getTelegramId(): string | null {
    return this.store.getTelegramId();
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    return this.store.linkTelegram(telegramId);
  }

  async unlinkTelegram(): Promise<{ removed: string | null }> {
    const { removed } = this.store.unlinkTelegram();
    if (!removed) return { removed: null };
    // Purge the user's stored images: unlinking is an account teardown path, so
    // their photos leave with their data. clerkUserId is set on first enqueue,
    // which is also the only path that creates attachments, so a null here means
    // nothing to purge.
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (clerkUserId) await this.attachments.deleteAllForUser(clerkUserId);
    return { removed };
  }

  getSettings(): {
    onboardingSeen: boolean;
    googleOnboardingStatus: string | null;
    createdAt: string | null;
    timezone: string | null;
    isNewUser: boolean;
  } {
    return this.store.getSettings();
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
    this.store.updateSettings(patch);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.store.setGoogleOnboardingStatus(status);
  }
}
