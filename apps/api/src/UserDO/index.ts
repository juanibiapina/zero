import { DurableObject } from "cloudflare:workers";
import { createDb, eq, and, gt, asc, type Database } from "do-orm";
import { migrate } from "do-orm";
import { telegramLink, sessions, messages, userSettings, processedUpdates } from "./db/schema";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import { DbStore } from "../store/db";
import type { Message, Role, Thread, Topic, TopicMeta } from "../store/types";
import type { Env } from "../types";

// How often the alarm re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;

enum SessionStatus {
  Idle = "idle",
  Active = "active",
}


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
  lookupSessionByTopic(chatId: number, topicId: number): string | null {
    const row = this.db.get(sessions, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    return row?.sessionId ?? null;
  }

  lookupSessionById(sessionId: string): { type: string; chatId: number; topicId: number; name?: string } | null {
    const row = this.db.get(sessions, { where: eq("sessionId", sessionId) });
    if (!row) return null;
    return { type: row.type, chatId: row.chatId, topicId: row.topicId, ...(row.name ? { name: row.name } : {}) };
  }

  createWebuiSession(sessionId: string, name?: string): void {
    this.db.insert(sessions, {
      type: "webui",
      chatId: 0,
      topicId: 0,
      sessionId,
      status: SessionStatus.Idle,
      updatedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
    });
  }

  listSessions(): Array<{ sessionId: string; type: string; name: string | null; status: string; updatedAt: string | null }> {
    const rows = this.db.all(sessions, { orderBy: asc("id") });
    return rows.map((r) => ({
      sessionId: r.sessionId,
      type: r.type,
      name: r.name ?? null,
      status: r.status,
      updatedAt: r.updatedAt ?? null,
    }));
  }

  appendMessage(sessionId: string, role: "user" | "agent", text: string): void {
    this.db.insert(messages, { sessionId, role, text, createdAt: new Date().toISOString() });
    this.db.update(sessions, { updatedAt: new Date().toISOString() }, {
      where: eq("sessionId", sessionId),
    });
  }

  listMessages(sessionId: string, since?: number): { messages: Array<{ id: number; role: string; text: string; createdAt: string }>; status: string | null } {
    const where = since !== undefined
      ? and(eq("sessionId", sessionId), gt("id", since))
      : eq("sessionId", sessionId);
    const rows = this.db.all(messages, { where, orderBy: asc("id") });
    const session = this.db.get(sessions, { where: eq("sessionId", sessionId) });
    return {
      messages: rows.map((r) => ({ id: r.id as number, role: r.role, text: r.text, createdAt: r.createdAt })),
      status: session?.status ?? null,
    };
  }

  async markSessionActiveById(sessionId: string): Promise<void> {
    this.db.update(sessions, { status: SessionStatus.Active }, {
      where: eq("sessionId", sessionId),
    });
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TYPING_INTERVAL_MS);
    }
  }

  markSessionIdleById(sessionId: string): void {
    this.db.update(sessions, { status: SessionStatus.Idle }, {
      where: eq("sessionId", sessionId),
    });
  }

  recordSession(chatId: number, topicId: number, sessionId: string): void {
    // Remove any existing session for this topic
    const existing = this.db.get(sessions, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (existing) {
      this.db.delete(sessions, { where: eq("id", existing.id) });
    }
    this.db.insert(sessions, { type: "telegram", chatId, topicId, sessionId, status: SessionStatus.Idle });
  }

  recordTaskSession(sessionId: string, name?: string): void {
    this.db.insert(sessions, { type: "task", chatId: 0, topicId: 0, sessionId, status: SessionStatus.Idle, ...(name ? { name } : {}) });
  }

  forgetSession(sessionId: string): void {
    this.db.delete(sessions, { where: eq("sessionId", sessionId) });
  }

  async markSessionActive(chatId: number, topicId: number): Promise<void> {
    this.db.update(sessions, { status: SessionStatus.Active }, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    await sendChatAction(this.env, chatId, topicId).catch(() => {});
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TYPING_INTERVAL_MS);
    }
  }

  markSessionIdle(chatId: number, topicId: number): void {
    this.db.update(sessions, { status: SessionStatus.Idle }, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
  }

  // Re-send the typing action for every active session, then re-arm while
  // any remain. Self-cancels once all sessions are idle.
  override async alarm(): Promise<void> {
    const active = this.db.all(sessions, { where: eq("status", SessionStatus.Active) });
    const telegramActive = active.filter((s) => s.type === "telegram");
    await Promise.all(
      telegramActive.map((s) => sendChatAction(this.env, s.chatId, s.topicId).catch(() => {})),
    );
    if (telegramActive.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + TYPING_INTERVAL_MS);
    }
  }


  getSettings(): { onboardingSeen: boolean; googleOnboardingStatus: string | null; createdAt: string | null; isNewUser: boolean } {
    const row = this.db.get(userSettings);
    if (!row) {
      const createdAt = new Date().toISOString();
      this.db.insert(userSettings, { onboardingSeen: 0, createdAt });
      return { onboardingSeen: false, googleOnboardingStatus: null, createdAt, isNewUser: true };
    }
    return { onboardingSeen: !!row.onboardingSeen, googleOnboardingStatus: row.googleOnboardingStatus ?? null, createdAt: row.createdAt ?? null, isNewUser: false };
  }

  updateSettings(patch: { onboardingSeen?: boolean }): void {
    const existing = this.db.get(userSettings);
    if (existing) {
      const updates: Record<string, number> = {};
      if (patch.onboardingSeen !== undefined) updates.onboardingSeen = patch.onboardingSeen ? 1 : 0;
      this.db.update(userSettings, updates, { where: eq("id", existing.id) });
    } else {
      this.db.insert(userSettings, {
        onboardingSeen: patch.onboardingSeen ? 1 : 0,
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
