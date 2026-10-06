import { DurableObject } from "cloudflare:workers";
import { createDb, type Database } from "do-orm";
import { migrate } from "do-orm";
import { migrations } from "./db/migrations";
import { DbStore } from "../store/db";
import {
  SystemTopicStore,
  systemTopicsFingerprint,
} from "../store/system-topics";
import type { Store, Topic, TopicMeta, Thread } from "../store/types";
import { createR2FileBlobs } from "../files/r2";
import { createUserFileStore } from "../files/store";
import { renderFileMarker } from "../files/marker";
import type { FileBlobStore, FileListInput, FilePage, StoredFile } from "../files/types";
import {
  composeMailNoteText,
  composeTurnText,
  composeWakeNoteText,
  FIRST_CONTACT_NOTE,
  SCHEDULE_NOTE,
} from "./turn-text";
import { formatTimestamp } from "../agents/format-timestamp";
import { createGoogleWorkspace } from "../google/rest";
import { getGoogleAccessToken, memoizeTokenProvider } from "../google-token";
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
import type { CreateScheduleResult, Schedule } from "../schedules/types";
import type { WatchResult, WatchedThread } from "../mail-watch/types";
import type { Env } from "../types";
import { USER_TOPIC, USER_TOPIC_DESCRIPTION } from "../user-topic";
import { log } from "../log";
import { getAssistantDO } from "../AssistantDO/stub";
import type { RequestContext } from "../assistant/harness";
import type { LegacyConversation } from "../assistant/legacy-import";
import {
  toWriteResult,
  type TopicWriteResult,
  type UserSettingsView,
} from "../assistant/user-data";

const LINKS_REBUILT_KEY = "topicLinksRebuiltV22";
const LAST_CONVERSATION_KEY = "lastConversationId";
const ONBOARDING_RUN_KEY = "onboardingRunId";
const handoffKey = (updateId: string) => `handoff:${updateId}`;

const onboardingPrompt = (topicName: string): string =>
  `Scan the user's Gmail to learn who they are, then record durable ` +
  `identity facts (name first) into the topic "${topicName}" with ` +
  `append_topic. The topic already exists and is pinned; fill its body.`;

export class UserDO extends DurableObject<Env> {
  private db: Database;
  private store: Store;
  private fileBlobs: FileBlobStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    const dbStore = new DbStore(this.db);
    this.store = new SystemTopicStore(dbStore);
    this.fileBlobs = createR2FileBlobs(env.FILES);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
      if (!(await ctx.storage.get(LINKS_REBUILT_KEY))) {
        dbStore.rebuildAllLinks();
        await ctx.storage.put(LINKS_REBUILT_KEY, true);
      }
      dbStore.syncSystemTopicsFingerprint(systemTopicsFingerprint());
    });
  }

  private async clerkUserId(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("clerkUserId");
  }

  private files(clerkUserId: string) {
    return createUserFileStore({ clerkUserId, records: this.store, blobs: this.fileBlobs });
  }

  // Hand one message to the assistant for the conversation it belongs to.
  // The operation id makes the hand-off safe to repeat.
  private async submitToAssistant(
    clerkUserId: string,
    conversationId: string,
    text: string,
    operationId: string,
  ): Promise<void> {
    const thread = this.store.getConversationThread(conversationId);
    if (!thread) {
      log("assistant_submit_skipped", { reason: "no_conversation" });
      return;
    }
    await getAssistantDO(this.env, clerkUserId).submit({
      chat: { chatId: thread.chatId, topicId: thread.topicId },
      conversationId,
      text,
      operationId,
    });
  }

  private stampText(text: string): string {
    const timezone = this.store.getSettings().timezone ?? "UTC";
    return `[${formatTimestamp(new Date().toISOString(), timezone)}] ${text}`;
  }

  // --- Conversations ---

  async resetConversation(chatId: number, topicId: number): Promise<void> {
    this.store.resetConversation(chatId, topicId);
    const clerkUserId = await this.clerkUserId();
    if (clerkUserId) await getAssistantDO(this.env, clerkUserId).reset({ chatId, topicId });
  }

  // --- Hand-off to the assistant ---

  // Dedupe the webhook update, save its files, and hand the message to
  // AssistantDO. Every step before the hand-off is repeatable, and the update is
  // marked processed only after the assistant has the message, so a failure
  // anywhere is retried into the same submission.
  async enqueueTurn(input: {
    updateId: string;
    clerkUserId: string;
    chatId: number;
    topicId: number;
    text: string;
    files?: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
    firstContactOnly?: boolean;
  }): Promise<boolean> {
    if (this.store.isProcessed(input.updateId)) return false;
    await this.ctx.storage.put("clerkUserId", input.clerkUserId);
    const files = this.files(input.clerkUserId);
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

    let text = await this.ctx.storage.get<string>(handoffKey(input.updateId));
    if (text === undefined) {
      const firstContact = this.store.claimFirstContact();
      if (firstContact) log("first_contact_claimed", { clerk_user_id: input.clerkUserId });
      if (input.firstContactOnly && !firstContact) {
        this.store.markProcessed(input.updateId);
        return false;
      }
      text = this.stampText(
        composeTurnText({
          ...(firstContact ? { note: FIRST_CONTACT_NOTE } : {}),
          text: input.text,
          markers,
        }),
      );
      await this.ctx.storage.put(handoffKey(input.updateId), text);
    }

    const conversationId = this.store.getOrCreateConversation(input.chatId, input.topicId);
    await getAssistantDO(this.env, input.clerkUserId).submit({
      chat: { chatId: input.chatId, topicId: input.topicId },
      conversationId,
      text,
      operationId: `tg:${input.updateId}`,
    });
    this.store.markProcessed(input.updateId);
    await this.ctx.storage.delete(handoffKey(input.updateId));
    await this.ctx.storage.put(LAST_CONVERSATION_KEY, conversationId);

    this.store.updateSettings({ lastActiveAt: new Date().toISOString() });
    await touchScheduleSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      conversationId,
    );
    await requestReminderSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      this.store.earliestScheduleDueAt(),
    );
    if (this.store.listMailThreads().length > 0) {
      await this.armMailWatch(input.clerkUserId);
    }
    await requestWakeSafely(
      getScheduleDO(this.env, input.clerkUserId),
      input.clerkUserId,
      Date.now() + WAKE_INACTIVE_MS,
    );
    return true;
  }

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

  // A turn alarm left over from before the assistant moved out: hand anything
  // it was owed to AssistantDO.
  override async alarm(): Promise<void> {
    const clerkUserId = await this.clerkUserId();
    if (clerkUserId) await getAssistantDO(this.env, clerkUserId).importLegacy();
  }

  // --- Admin tasks and onboarding ---

  async queueAdminTask(input: { clerkUserId: string; prompt: string }): Promise<boolean> {
    const queued = await queueAdminTask(this.ctx.storage, {
      ...input,
      id: crypto.randomUUID(),
      status: "queued",
    });
    if (queued) {
      await getScheduleDO(this.env, input.clerkUserId).requestJob(input.clerkUserId, "admin_task");
    }
    return queued;
  }

  async getAdminTaskStatus(): Promise<AdminTaskStatus | null> {
    const task = await this.ctx.storage.get<AdminTask>(ADMIN_TASK_KEY);
    return task ? toAdminTaskStatus(task) : null;
  }

  async runQueuedAdminTask(): Promise<void> {
    const task = await this.ctx.storage.get<AdminTask>(ADMIN_TASK_KEY);
    if (task?.status !== "queued") return;
    await runAdminTask({
      task,
      runAgent: async (prompt) => {
        const result = await getAssistantDO(this.env, task.clerkUserId).runJob({
          kind: "admin",
          jobId: `admin:${task.id ?? "legacy"}`,
          prompt,
        });
        if (result.status !== "done") {
          throw new Error(`admin task ended ${result.status}: ${result.reason ?? ""}`);
        }
        return result.text ?? "";
      },
      setTask: (terminalTask) => this.ctx.storage.put(ADMIN_TASK_KEY, terminalTask),
      reportError: (err) =>
        reportError(this.env, err, { site: "admin_task", clerk_user_id: task.clerkUserId }),
    });
  }

  async runQueuedOnboarding(): Promise<void> {
    if (this.store.getSettings().googleOnboardingStatus !== "queued") return;
    const clerkUserId = (await this.clerkUserId()) ?? "unknown";
    let runId = await this.ctx.storage.get<string>(ONBOARDING_RUN_KEY);
    if (!runId) {
      runId = crypto.randomUUID();
      await this.ctx.storage.put(ONBOARDING_RUN_KEY, runId);
    }
    const jobId = `onboarding:${runId}`;
    await runOnboarding({
      store: this.store,
      clerkUserId,
      topicName: USER_TOPIC,
      description: USER_TOPIC_DESCRIPTION,
      runAgent: async (topicName) => {
        const result = await getAssistantDO(this.env, clerkUserId).runJob({
          kind: "onboarding",
          jobId,
          prompt: onboardingPrompt(topicName),
        });
        if (result.status !== "done") {
          throw new Error(`onboarding ended ${result.status}: ${result.reason ?? ""}`);
        }
      },
      setStatus: (status) => this.store.setGoogleOnboardingStatus(status),
      notify: (message) => notifyDiscord(this.env.DISCORD_SIGNUP_WEBHOOK_URL, message),
      reportError: (err) =>
        reportError(this.env, err, { site: "onboarding", clerk_user_id: clerkUserId }),
    });
  }

  async queueOnboarding(clerkUserId: string, force = false): Promise<void> {
    if (!force && this.store.getSettings().googleOnboardingStatus !== null) return;
    await this.ctx.storage.put("clerkUserId", clerkUserId);
    await this.ctx.storage.put(ONBOARDING_RUN_KEY, crypto.randomUUID());
    this.store.setGoogleOnboardingStatus("queued");
    await getScheduleDO(this.env, clerkUserId).requestJob(clerkUserId, "onboarding");
  }

  // --- Deadlines that become messages ---

  async runDueSchedules(): Promise<void> {
    const clerkUserId = await this.clerkUserId();
    if (!clerkUserId) return;
    await fireDueSchedules({
      store: this.store,
      now: Date.now(),
      nextRun,
      composeText: (prompt) => this.stampText(composeTurnText({ note: SCHEDULE_NOTE, text: prompt })),
      submit: (conversationId, text, operationId) =>
        this.submitToAssistant(clerkUserId, conversationId, text, operationId),
    });
    await requestReminderSafely(
      getScheduleDO(this.env, clerkUserId),
      clerkUserId,
      this.store.earliestScheduleDueAt(),
    );
  }

  async checkTrackedMail(): Promise<void> {
    const clerkUserId = await this.clerkUserId();
    if (!clerkUserId) return;
    const getToken = memoizeTokenProvider(() => getGoogleAccessToken(this.env, clerkUserId));
    const google = createGoogleWorkspace(getToken);
    const outcome = await runMailWatch({
      store: this.store,
      mail: google.mail,
      now: Date.now(),
      composeText: (threadId) => this.stampText(composeMailNoteText(threadId)),
      submit: (conversationId, text, operationId) =>
        this.submitToAssistant(clerkUserId, conversationId, text, operationId),
    });
    if (outcome.status !== "disarmed") await this.armMailWatch(clerkUserId);
  }

  private async armMailWatch(clerkUserId: string): Promise<void> {
    await requestMailWatchSafely(
      getScheduleDO(this.env, clerkUserId),
      clerkUserId,
      Date.now() + MAIL_WATCH_INTERVAL_MS,
    );
  }

  private async lastConversation(): Promise<Thread | null> {
    const id = await this.ctx.storage.get<string>(LAST_CONVERSATION_KEY);
    return (id ? this.store.getConversationThread(id) : null) ?? this.store.getMostRecentConversation();
  }

  async wakeSleeper(): Promise<void> {
    const clerkUserId = await this.clerkUserId();
    if (!clerkUserId) return;
    await runWake({
      store: this.store,
      conversation: await this.lastConversation(),
      now: Date.now(),
      composeText: () => this.stampText(composeWakeNoteText()),
      submit: (conversationId, text, operationId) =>
        this.submitToAssistant(clerkUserId, conversationId, text, operationId),
    });
  }

  // --- The assistant's view of this user's data (see assistant/user-data.ts) ---

  agentRequestContext(): RequestContext {
    const settings = this.store.getSettings();
    return {
      knowledgeVersion: this.store.getKnowledgeVersion(),
      pinned: this.store.getPinnedTopics(),
      timezone: settings.timezone ?? "UTC",
      ...(settings.country ? { country: settings.country } : {}),
    };
  }

  agentSettings(): UserSettingsView {
    const settings = this.store.getSettings();
    return {
      timezone: settings.timezone,
      country: settings.country,
      braveKeyPaid: settings.braveKeyPaid,
    };
  }

  agentSetTimezone(timezone: string): void {
    this.store.updateSettings({ timezone });
  }

  agentSetCountry(country: string): void {
    this.store.updateSettings({ country });
  }

  agentKnowledgeVersion(): number {
    return this.store.getKnowledgeVersion();
  }

  agentListTopics(): TopicMeta[] {
    return this.store.listTopics();
  }

  agentGetTopic(name: string): Topic | null {
    return this.store.getTopic(name);
  }

  agentGetOutboundLinks(name: string): string[] {
    return this.store.getOutboundLinks(name);
  }

  agentGetBacklinks(name: string): TopicMeta[] {
    return this.store.getBacklinks(name);
  }

  agentCreateTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.createTopic(input));
  }

  agentUpdateTopicBody(input: { expectedVersion: number; name: string; body: string }): TopicWriteResult {
    return toWriteResult(() => this.store.updateTopicBody(input));
  }

  agentUpdateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): TopicWriteResult {
    return toWriteResult(() => this.store.updateTopicMetadata(input));
  }

  agentDeleteTopic(input: { expectedVersion: number; name: string }): TopicWriteResult {
    return toWriteResult(() => this.store.deleteTopic(input));
  }

  private async rearmReminder(): Promise<void> {
    const clerkUserId = await this.clerkUserId();
    if (!clerkUserId) return;
    await requestReminderSafely(
      getScheduleDO(this.env, clerkUserId),
      clerkUserId,
      this.store.earliestScheduleDueAt(),
    );
  }

  async agentCreateSchedule(
    conversationId: string,
    input: { prompt: string; pattern: string; timezone: string },
  ): Promise<CreateScheduleResult> {
    const result = createScheduleBook({ store: this.store, conversationId }).create(input);
    if ("schedule" in result) await this.rearmReminder();
    return result;
  }

  agentListSchedules(conversationId: string): Schedule[] {
    return createScheduleBook({ store: this.store, conversationId }).list();
  }

  async agentCancelSchedule(conversationId: string, id: string): Promise<boolean> {
    const cancelled = createScheduleBook({ store: this.store, conversationId }).cancel(id);
    if (cancelled) await this.rearmReminder();
    return cancelled;
  }

  async agentWatchThread(conversationId: string, threadId: string): Promise<WatchResult> {
    const result = createMailWatchBook({ store: this.store, conversationId }).watch(threadId);
    const clerkUserId = await this.clerkUserId();
    if ("thread" in result && clerkUserId) await this.armMailWatch(clerkUserId);
    return result;
  }

  agentListWatchedThreads(conversationId: string): WatchedThread[] {
    return createMailWatchBook({ store: this.store, conversationId }).list();
  }

  agentStopWatching(conversationId: string, threadId: string): boolean {
    return createMailWatchBook({ store: this.store, conversationId }).stop(threadId);
  }

  async agentSaveFile(input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredFile> {
    const clerkUserId = (await this.clerkUserId()) ?? "unknown";
    return this.files(clerkUserId).save(input);
  }

  async agentGetFile(id: string): Promise<StoredFile | null> {
    return this.files((await this.clerkUserId()) ?? "unknown").get(id);
  }

  async agentReadFile(id: string): Promise<Uint8Array | null> {
    return this.files((await this.clerkUserId()) ?? "unknown").read(id);
  }

  async agentListFiles(input: FileListInput): Promise<FilePage> {
    return this.files((await this.clerkUserId()) ?? "unknown").list(input);
  }

  async agentDeleteFile(id: string): Promise<boolean> {
    return this.files((await this.clerkUserId()) ?? "unknown").delete(id);
  }

  agentExportLegacy(): LegacyConversation[] {
    const timezone = this.store.getSettings().timezone ?? "UTC";
    return this.store.exportLegacyConversations().map((conversation) => ({
      ...conversation,
      timezone,
    }));
  }

  // --- Telegram link / settings RPC ---

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
    const clerkUserId = await this.clerkUserId();
    if (!clerkUserId) return;
    await this.files(clerkUserId).deleteAll();
  }

  // Erase this user. `clerkUserId` is a parameter because the R2 sweep must
  // reach files even when this object never stored the id. Nothing is written
  // after deleteAll(); the caller drops the instance with reset().
  async deleteAllData(clerkUserId: string): Promise<void> {
    await this.files(clerkUserId).deleteAll();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

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

  setBravePaid(paid: boolean): void {
    this.store.updateSettings({ braveKeyPaid: paid });
    log("brave_plan_set", { paid });
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string; country?: string }): void {
    this.store.updateSettings(patch);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.store.setGoogleOnboardingStatus(status);
  }
}
