import { DurableObject } from "cloudflare:workers";
import { createDb, eq, type Database } from "do-orm";
import { migrate } from "do-orm";
import { telegramLink, userSettings, processedUpdates } from "./db/schema";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import { sendMessage } from "../telegram/send-message";
import { DbStore } from "../store/db";
import { createModel } from "../agents/model";
import { createBraveSearch } from "../websearch/brave";
import { runTurn as orchestrateTurn } from "../agents/orchestrator";
import { runAlarmTurns } from "../do/alarm";
import type { Message, Role, Thread, Topic, TopicMeta } from "../store/types";
import type { Env } from "../types";

// How often the typing loop re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;


export class UserDO extends DurableObject<Env> {
  private db: Database;
  private store: DbStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    this.store = new DbStore(this.db);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  // --- Topic model (delegated to the Store) ---

  listTopics(): TopicMeta[] {
    return this.store.listTopics();
  }

  getTopic(name: string): Topic | null {
    return this.store.getTopic(name);
  }

  createTopic(name: string, description: string): void {
    this.store.createTopic(name, description);
  }

  updateTopicBody(name: string, body: string): void {
    this.store.updateTopicBody(name, body);
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    return this.store.getTopicsWithBodies(names);
  }

  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void {
    this.store.saveTopic(name, patch, newName);
  }

  // --- Conversations and messages ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    return this.store.getOrCreateConversation(chatId, topicId);
  }

  storeMessage(conversationId: string, role: Role, content: string): void {
    this.store.storeMessage(conversationId, role, content);
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    return this.store.getConversationHistory(conversationId, limit);
  }

  resetConversation(chatId: number, topicId: number): void {
    this.store.resetConversation(chatId, topicId);
  }

  findThreadsAwaitingReply(): Thread[] {
    return this.store.findThreadsAwaitingReply();
  }

  // --- Webhook idempotency ---

  // Record an update id; returns true if newly seen, false if already processed.
  markProcessed(updateId: string): boolean {
    const existing = this.db.get(processedUpdates, {
      where: eq("updateId", updateId),
    });
    if (existing) return false;
    this.db.insert(processedUpdates, {
      updateId,
      createdAt: new Date().toISOString(),
    });
    return true;
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
  }): Promise<void> {
    if (!this.markProcessed(input.updateId)) return;
    await this.ctx.storage.put("clerkUserId", input.clerkUserId);
    const conversationId = this.store.getOrCreateConversation(
      input.chatId,
      input.topicId,
    );
    this.store.storeMessage(conversationId, "user", input.text);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  // The turn runner. Drains every thread whose tail is a user message. A
  // concurrent enqueueTurn arms a fresh alarm (this handler cleared the old
  // one on entry), so messages that arrive mid-run are picked up on the next
  // fire. On a catchable failure runAlarmTurns self-reschedules with backoff
  // while any thread still awaits reply, and returns normally (never rethrows,
  // which would discard the reschedule). See do/alarm.ts.
  override async alarm(): Promise<void> {
    await runAlarmTurns({
      storage: this.ctx.storage,
      findThreadsAwaitingReply: () => this.store.findThreadsAwaitingReply(),
      runTurn: (chatId, topicId) => this.runTurn(chatId, topicId),
    });
  }

  // Run one thread end to end inside the DO: local typing loop, model creation
  // (per-user gateway tagging), then the runtime-agnostic orchestrator. The
  // typing loop is a self-rescheduling setTimeout, not the DO alarm timer, so
  // the alarm stays dedicated to turn scheduling.
  async runTurn(chatId: number, topicId: number): Promise<void> {
    const clerkUserId =
      (await this.ctx.storage.get<string>("clerkUserId")) ?? "unknown";
    const model = await createModel(this.env, clerkUserId);
    const search = createBraveSearch(this.env.BRAVE_API_KEY);
    const timezone = this.getSettings().timezone ?? undefined;
    const setTimezone = (tz: string) => this.updateSettings({ timezone: tz });
    const send = (text: string) => sendMessage(this.env, chatId, topicId, text);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void sendChatAction(this.env, chatId, topicId).catch(() => {});
      timer = setTimeout(tick, TYPING_INTERVAL_MS);
    };
    tick();
    try {
      await orchestrateTurn({ store: this.store, model, send, search, chatId, topicId, clerkUserId, timezone, setTimezone });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getTelegramId(): string | null {
    const row = this.db.get(telegramLink);
    return row?.telegramId ?? null;
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    const existing = this.db.get(telegramLink);
    const previous = existing?.telegramId ?? null;

    if (existing) {
      this.db.update(telegramLink, { telegramId }, { where: eq("id", existing.id) });
    } else {
      this.db.insert(telegramLink, { telegramId });
    }

    return { previous };
  }

  unlinkTelegram(): { removed: string | null } {
    const existing = this.db.get(telegramLink);
    if (!existing) return { removed: null };

    this.db.delete(telegramLink, { where: eq("id", existing.id) });
    return { removed: existing.telegramId };
  }

  getSettings(): { onboardingSeen: boolean; googleOnboardingStatus: string | null; createdAt: string | null; timezone: string | null; isNewUser: boolean } {
    const row = this.db.get(userSettings);
    if (!row) {
      const createdAt = new Date().toISOString();
      this.db.insert(userSettings, { onboardingSeen: 0, createdAt });
      return { onboardingSeen: false, googleOnboardingStatus: null, createdAt, timezone: null, isNewUser: true };
    }
    return { onboardingSeen: !!row.onboardingSeen, googleOnboardingStatus: row.googleOnboardingStatus ?? null, createdAt: row.createdAt ?? null, timezone: row.timezone ?? null, isNewUser: false };
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
    const existing = this.db.get(userSettings);
    if (existing) {
      const updates: Record<string, number | string> = {};
      if (patch.onboardingSeen !== undefined) updates.onboardingSeen = patch.onboardingSeen ? 1 : 0;
      if (patch.timezone !== undefined) updates.timezone = patch.timezone;
      this.db.update(userSettings, updates, { where: eq("id", existing.id) });
    } else {
      this.db.insert(userSettings, {
        onboardingSeen: patch.onboardingSeen ? 1 : 0,
        timezone: patch.timezone,
        createdAt: new Date().toISOString(),
      });
    }
  }

  setGoogleOnboardingStatus(status: string): void {
    const existing = this.db.get(userSettings);
    if (existing) {
      this.db.update(userSettings, { googleOnboardingStatus: status }, { where: eq("id", existing.id) });
    } else {
      this.db.insert(userSettings, { onboardingSeen: 0, googleOnboardingStatus: status, createdAt: new Date().toISOString() });
    }
  }
}
