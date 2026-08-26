import { DurableObject } from "cloudflare:workers";
import { createDb, type Database } from "do-orm";
import { migrate } from "do-orm";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import { sendMessage } from "../telegram/send-message";
import { DbStore } from "../store/db";
import { DbCaptureStore, type Capture } from "../store/captures";
import {
  SystemTopicStore,
  systemTopicsFingerprint,
} from "../store/system-topics";
import { KnowledgeConflictError } from "../store/types";
import type {
  LearningMessage,
  Store,
  Topic,
  TopicMeta,
} from "../store/types";
import type { TopicWriteResult } from "../learning/types";
import { InputFile } from "grammy";
import { createBot } from "../telegram/bot";
import { createR2FileBlobs } from "../files/r2";
import { createUserFileStore } from "../files/store";
import { renderFileMarker } from "../files/marker";
import { composeMailNoteText, composeTurnText, composeWakeNoteText, FIRST_CONTACT_NOTE, SCHEDULE_NOTE } from "./turn-text";
import type { FileBlobStore } from "../files/types";
import { TelegramFileSendError } from "../tools/files";
import { createModel, createModelFactory } from "../agents/model";
import { createBraveSearch } from "../websearch/brave";
import { selectBraveKey } from "../websearch/brave-key";
import { createTavilyFetcher } from "../pagefetch/tavily";
import { createCloudflareImageResizer } from "../images/cloudflare";
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
import { notifyDiscord } from "../discord";
import { getScheduleDO } from "../ScheduleDO/stub";
import {
  requestLearnSafely,
  requestMailWatchSafely,
  requestReminderSafely,
  requestWakeSafely,
  touchScheduleSafely,
  WAKE_INACTIVE_MS,
} from "../do/schedule";
import { fireDueSchedules } from "../do/schedules";
import { MAIL_WATCH_INTERVAL_MS, runMailWatch } from "../do/mail-watch";
import { runWake } from "../do/wake";
import { createScheduleBook } from "../schedules/book";
import { createMailWatchBook } from "../mail-watch/book";
import { nextRun } from "../schedules/recurrence";
import type { Env } from "../types";
import { USER_TOPIC, USER_TOPIC_DESCRIPTION } from "../user-topic";
import { log } from "../log";

// How often the typing loop re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;

// Marks the one-time link reconciliation that follows migration 0022.
const LINKS_REBUILT_KEY = "topicLinksRebuiltV22";

// Turn a versioned topic write into data that survives an RPC hop.
const toWriteResult = (apply: () => number): TopicWriteResult => {
  try {
    return { version: apply() };
  } catch (err) {
    if (err instanceof KnowledgeConflictError)
      return { conflict: { expected: err.expected, current: err.current } };
    return { failed: err instanceof Error ? err.message : String(err) };
  }
};

export class UserDO extends DurableObject<Env> {
  private db: Database;
  // Wrapped in SystemTopicStore so the read-only system topics (Zero,
  // Changelog) are overlaid on every read and blocked from writes. See
  // store/system-topics.ts.
  private store: Store;
  // File bytes in R2. Metadata rows live in this user's SQLite store.
  private fileBlobs: FileBlobStore;
  // The parallel todo app's GTD capture Inbox. Separate from `store` on purpose.
  private captures: DbCaptureStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    const dbStore = new DbStore(this.db);
    this.store = new SystemTopicStore(dbStore);
    this.fileBlobs = createR2FileBlobs(env.FILES);
    this.captures = new DbCaptureStore(this.db);

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

  // --- Captures (parallel todo app's GTD Inbox) ---

  addCapture(text: string): Capture {
    return this.captures.add(text);
  }

  listInbox(): Capture[] {
    return this.captures.list();
  }

  processCapture(id: string): Capture | null {
    return this.captures.process(id);
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
    files?: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
    // Set by /start: enqueue only when this is the user's first contact. A
    // later /start carries nothing to answer, so it must not run a turn.
    firstContactOnly?: boolean;
  }): Promise<boolean> {
    await this.ctx.storage.put("clerkUserId", input.clerkUserId);
    const files = createUserFileStore({
      clerkUserId: input.clerkUserId,
      records: this.store,
      blobs: this.fileBlobs,
    });
    const markers: string[] = [];
    for (const incoming of input.files ?? []) {
      const file = await files.save(incoming);
      markers.push(renderFileMarker(file));
      log("file_imported", {
        source: "telegram",
        byte_count: file.byteSize ?? incoming.bytes.length,
        mime_major: file.mimeType.split("/")[0],
      });
    }
    // Save is deterministic, so duplicate webhooks may repeat it safely. Claim
    // the update only after saving, then queue the message once.
    if (!this.store.markProcessed(input.updateId)) return false;
    // Strictly after markProcessed: the claim is one-shot, so taking it before
    // the dedupe gate would burn it on a duplicate webhook delivery whose
    // update is then dropped, and the introduction would never be sent.
    const firstContact = this.store.claimFirstContact();
    if (firstContact) log("first_contact_claimed", { clerk_user_id: input.clerkUserId });
    if (input.firstContactOnly && !firstContact) return false;
    const conversationId = this.store.getOrCreateConversation(input.chatId, input.topicId);
    const text = composeTurnText({
      ...(firstContact ? { note: FIRST_CONTACT_NOTE } : {}),
      text: input.text,
      markers,
    });
    // The message enters the durable queue, not the transcript. A turn injects
    // it at a safe point, so a message arriving while the agent is mid-run is
    // never spliced into a request the model is already answering.
    this.store.enqueuePendingMessage(conversationId, text);
    // The user is active now. The mail poll reads this to decide whether an
    // account is still worth polling every hour.
    this.store.updateSettings({ lastActiveAt: new Date().toISOString() });
    // Always arm the alarm when a new message arrives: a new message means the
    // user is active and the turn should run now. Setting the alarm to Date.now()
    // overrides any stale backoff that was scheduled further in the future, and
    // is a no-op relative to an alarm that is already due. This also recovers
    // from phantom alarms (getAlarm() returns non-null but the alarm never fires)
    // which can happen after a DO migration during a deploy.
    await this.ctx.storage.setAlarm(Date.now());
    // The conversation is active again: push its idle-learning deadline out to
    // now + 1h. After the durable enqueue, never after the turn — an LLM failure
    // must not make an active conversation look idle. Best-effort: a schedule
    // problem must not reject the user's message.
    await touchScheduleSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      conversationId,
    );
    // Ordinary activity heals a lost arm: if a create could not reach the
    // schedule, or a deadline was dropped, the next message puts it back.
    await requestReminderSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      this.store.earliestScheduleDueAt(),
    );
    // Same healing for the mail poll, which is also how a user who was away
    // for over a week starts being polled again.
    if (this.store.listMailThreads().length > 0) {
      await this.armMailWatch(input.clerkUserId);
    }
    // Push the wake deadline a week out. Armed unconditionally — every user,
    // mail or not, should be woken after a week of silence. Ordinary activity
    // keeps moving it out, so a talking user never fires, and this is the only
    // arm point: it also heals a lost deadline.
    await requestWakeSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      Date.now() + WAKE_INACTIVE_MS,
    );
    return true;
  }

  // The /start command. Runs the normal enqueue path with no user text, so
  // Zero introduces itself; returns false when this user has already been
  // introduced, and the caller sends a plain ack instead of running a turn.
  async startConversation(
    clerkUserId: string,
    chatId: number,
    topicId: number,
    updateId: string,
  ): Promise<boolean> {
    return this.enqueueTurn({
      updateId,
      clerkUserId,
      chatId,
      topicId,
      text: "",
      firstContactOnly: true,
    });
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
      reportError: (err) =>
        reportError(this.env, err, {
          site: "admin_task",
          clerk_user_id: task.clerkUserId,
        }),
    });
  }

  // Run Google onboarding, if it is queued. Called by ScheduleDO, same shape as
  // runQueuedAdminTask.
  async runQueuedOnboarding(): Promise<void> {
    if (this.store.getSettings().googleOnboardingStatus !== "queued") return;
    await this.runOnboarding();
  }

  // Fire every schedule that has come due. Called by ScheduleDO when the single
  // reminder deadline it holds for this user comes due.
  //
  // No model runs here: each due schedule's prompt goes into the conversation's
  // pending queue and the turn happens on this DO's own alarm, like any other
  // message. The enqueue comes BEFORE the record is advanced, so a reset in
  // between fires a schedule twice rather than never — for a reminder the
  // duplicate is the better failure.
  async runDueSchedules(): Promise<void> {
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    const fired = fireDueSchedules({
      store: this.store,
      now: Date.now(),
      nextRun,
      composeText: (prompt) =>
        composeTurnText({ note: SCHEDULE_NOTE, text: prompt }),
    });
    if (fired > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
    // Re-arm for whatever is now earliest, including the occurrence just
    // scheduled by an advance.
    if (clerkUserId) {
      await requestReminderSafely(
        getScheduleDO(this.env, clerkUserId),
        clerkUserId,
        this.store.earliestScheduleDueAt(),
      );
    }
  }

  // The hourly "did anyone reply?" pass. Called by ScheduleDO when this user's
  // single mailwatch deadline comes due.
  //
  // No model runs here: a reply queues a pending message and the turn happens
  // on this DO's own alarm, like any other message. The pass re-arms itself for
  // an hour's time unless it decided this user is not worth polling (nothing
  // watched, away for a week, Google not connected), in which case their next
  // message arms it again.
  async checkTrackedMail(): Promise<void> {
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (!clerkUserId) return;
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);
    const outcome = await runMailWatch({
      store: this.store,
      mail: google.mail,
      now: Date.now(),
      composeText: composeMailNoteText,
    });
    if (outcome.status === "checked" && outcome.notified > 0) {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
    }
    if (outcome.status !== "disarmed") await this.armMailWatch(clerkUserId);
  }

  // Hold this user's mail poll an hour out, best-effort.
  private async armMailWatch(clerkUserId: string): Promise<void> {
    await requestMailWatchSafely(
      getScheduleDO(this.env, clerkUserId),
      clerkUserId,
      Date.now() + MAIL_WATCH_INTERVAL_MS,
    );
  }

  // Re-engage a user who has gone quiet for about a week. Reached by the `wake`
  // deadline and by the admin backfill; the `wokeAt` marker makes it self-dedupe
  // regardless of trigger, so one message is sent per sleep episode. Does NOT
  // re-arm the wake deadline: the user's next message re-arms it. See
  // docs/wake-sleepers.md.
  async wakeSleeper(): Promise<void> {
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (!clerkUserId) return;
    const outcome = runWake({
      store: this.store,
      now: Date.now(),
      composeText: composeWakeNoteText,
    });
    // A wake queued a pending message: run it on our own alarm, like a mail hit.
    if (outcome.status === "woken" && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
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
      clerkUserId,
      topicName: USER_TOPIC,
      description: USER_TOPIC_DESCRIPTION,
      runAgent: (topicName) =>
        runOnboardingAgent({ model, store: this.store, google, topicName }),
      setStatus: (status) => this.store.setGoogleOnboardingStatus(status),
      // Same channel as the signup notice: onboarding is a rare per-user event,
      // so its volume is on the order of signups.
      notify: (message) =>
        notifyDiscord(this.env.DISCORD_SIGNUP_WEBHOOK_URL, message),
      reportError: (err) =>
        reportError(this.env, err, {
          site: "onboarding",
          clerk_user_id: clerkUserId,
        }),
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
    const conversationId = this.store.getOrCreateConversation(chatId, topicId);
    const makeModel = await createModelFactory(
      this.env,
      clerkUserId,
      undefined,
      { conversationId, chatId, topicId },
    );
    const settings = this.store.getSettings();
    // Canary routing: flagged users search on the paid Brave key, everyone else
    // on the free one. The cohort tags every Brave log line so paid spend is
    // countable per cohort (see docs/plans/brave-paid-canary.md).
    const braveKey = selectBraveKey({
      paid: settings.braveKeyPaid,
      freeKey: this.env.BRAVE_API_KEY,
      paidKey: this.env.BRAVE_API_KEY_PAID,
    });
    const search = createBraveSearch(braveKey.apiKey, { cohort: braveKey.cohort });
    const fetcher = createTavilyFetcher(this.env.TAVILY_API_KEY);
    const resizer = createCloudflareImageResizer(this.env.IMAGES);
    // Memoized Google token provider: the first Google tool call mints a token
    // via Clerk and caches the promise for the turn; turns that never touch
    // Google make zero Clerk calls. A ~1h token outlives any turn.
    const getToken = memoizeTokenProvider(() =>
      getGoogleAccessToken(this.env, clerkUserId),
    );
    const google = createGoogleWorkspace(getToken);
    const timezone = settings.timezone ?? undefined;
    const country = settings.country ?? undefined;
    const setTimezone = (tz: string) =>
      this.store.updateSettings({ timezone: tz });
    const setCountry = (value: string) =>
      this.store.updateSettings({ country: value });
    const send = (text: string) => sendMessage(this.env, chatId, topicId, text);
    const files = createUserFileStore({
      clerkUserId,
      records: this.store,
      blobs: this.fileBlobs,
    });
    const sendFile = async (
      file: { filename: string; mimeType: string },
      bytes: Uint8Array,
    ) => {
      try {
        await createBot(this.env).api.sendDocument(
          chatId,
          new InputFile(bytes, file.filename),
          { ...(topicId && { message_thread_id: topicId }) },
        );
        log("file_sent", {
          byte_count: bytes.length,
          mime_major: file.mimeType.split("/")[0],
        });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "error_code" in error
          ? Number(error.error_code)
          : 0;
        if (status) throw new TelegramFileSendError(status, error instanceof Error ? error.message : String(error));
        throw error;
      }
    };

    // Bound to this conversation: a schedule speaks in the thread it was
    // created in.
    const schedules = createScheduleBook({
      store: this.store,
      conversationId,
    });
    // Bound to this conversation too: a reply is announced in the chat the
    // thread was watched from.
    const mailWatch = createMailWatchBook({
      store: this.store,
      conversationId,
    });
    // Watching a thread is what arms the hourly poll; re-arming here also
    // heals a deadline that was lost.
    const onWatchChanged = () => {
      void this.armMailWatch(clerkUserId);
    };
    // Re-arm the user's timer after a create or cancel, best-effort and off the
    // reply path.
    const onScheduleChanged = () => {
      void requestReminderSafely(
        getScheduleDO(this.env, clerkUserId),
        clerkUserId,
        this.store.earliestScheduleDueAt(),
      );
    };

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
        files,
        sendFile,
        resizer,
        schedules,
        onScheduleChanged,
        mailWatch,
        onWatchChanged,
        chatId,
        topicId,
        clerkUserId,
        timezone,
        setTimezone,
        country,
        setCountry,
        reportError: (err, context, options) =>
          reportError(this.env, err, context, options),
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

  // --- Learning RPC (the remote half of the learning port) ---
  //
  // A Durable Object cannot read another's SQLite, so LearningDO reaches this
  // data over RPC. These methods are a flat mirror of learning/types.ts, since
  // an RPC boundary carries data and not objects with methods. Topic writes
  // return a result instead of throwing, because a thrown
  // KnowledgeConflictError would arrive as a plain Error and lose which versions
  // collided; learning/remote-port.ts rebuilds it on the far side.

  learnBeginJob(jobId: string): number {
    return this.store.beginLearningJob(jobId);
  }

  learnListMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): LearningMessage[] {
    return this.store.listUnconsolidatedMessages(input);
  }

  learnCompleteJob(jobId: string, throughMessageId: number): void {
    this.store.completeLearningJob(jobId, throughMessageId);
  }

  learnGetCompactionWindow(
    conversationId: string,
    limit: number,
  ): { summary: string | null; messages: LearningMessage[]; hasMore: boolean } {
    const window = this.store.getCompactionWindow(conversationId, limit);
    return {
      summary: window.summary,
      messages: window.messages.map((m) => ({ ...m, conversationId })),
      hasMore: window.hasMore,
    };
  }

  learnCompactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): void {
    this.store.compactConversation(conversationId, input);
  }

  learnKnowledgeVersion(): number {
    return this.store.getKnowledgeVersion();
  }

  learnListTopics(): TopicMeta[] {
    return this.store.listTopics();
  }

  learnGetTopic(name: string): Topic | null {
    return this.store.getTopic(name);
  }

  learnGetOutboundLinks(name: string): string[] {
    return this.store.getOutboundLinks(name);
  }

  learnGetBacklinks(name: string): TopicMeta[] {
    return this.store.getBacklinks(name);
  }

  learnCreateTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.createTopic(input));
  }

  learnUpdateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.updateTopicBody(input));
  }

  learnUpdateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.updateTopicMetadata(input));
  }

  learnDeleteTopic(input: {
    expectedVersion: number;
    name: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.deleteTopic(input));
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
    return this.store.unlinkTelegram();
  }

  async deleteAllFiles(): Promise<void> {
    const clerkUserId = await this.ctx.storage.get<string>("clerkUserId");
    if (!clerkUserId) return;
    await createUserFileStore({
      clerkUserId,
      records: this.store,
      blobs: this.fileBlobs,
    }).deleteAll();
  }

  // Erase this user. Everything: topics, conversations, messages, files,
  // schedules, settings, the Telegram link row, the admin task.
  //
  // `clerkUserId` is a parameter, not the stored one, because the R2 sweep is
  // the one step that reaches a store this wipe cannot: `clerkUserId` in
  // storage is written by enqueueTurn, and reading it here would silently skip
  // the sweep for a user whose DO never ran a turn. The caller has the verified
  // id — it is this object's own name.
  //
  // Order matters twice over: the R2 objects are addressed by rows in SQLite,
  // so they go first; and NOTHING is written afterwards. `deleteAll()` on a
  // SQLite-backed class removes the whole private database, schema included,
  // which deallocates the object's storage. Re-running migrations here would
  // immediately re-allocate it, so the instance is left holding a schema-less
  // database and the caller drops it with reset() below.
  async deleteAllData(clerkUserId: string): Promise<void> {
    await createUserFileStore({
      clerkUserId,
      records: this.store,
      blobs: this.fileBlobs,
    }).deleteAll();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Forcibly reset this instance, so the emptied object is not left in memory
  // with a schema-less database. The next request to this id constructs a fresh
  // object and migrates from scratch, exactly like a brand-new user.
  //
  // This never returns: abort raises an error the caller sees as a rejected
  // RPC. do/purge.ts expects that and treats it as success.
  reset(): void {
    this.ctx.abort("user data deleted");
  }

  getSettings(): {
    onboardingSeen: boolean;
    googleOnboardingStatus: string | null;
    createdAt: string | null;
    timezone: string | null;
    country: string | null;
    braveKeyPaid: boolean;
    isNewUser: boolean;
  } {
    return this.store.getSettings();
  }

  // Flip this user's paid-Brave-key canary flag. Admin-only entry point (see
  // routes/admin.ts); the next turn routes search on the selected key.
  setBravePaid(paid: boolean): void {
    this.store.updateSettings({ braveKeyPaid: paid });
    log("brave_plan_set", { paid });
  }

  updateSettings(patch: {
    onboardingSeen?: boolean;
    timezone?: string;
    country?: string;
  }): void {
    this.store.updateSettings(patch);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.store.setGoogleOnboardingStatus(status);
  }
}
