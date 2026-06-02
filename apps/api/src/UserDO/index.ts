import { DurableObject } from "cloudflare:workers";
import { createDb, eq, and, type Database } from "do-orm";
import { migrate } from "do-orm";
import { telegramLink, sessions, userSettings } from "./db/schema";
import { migrations } from "./db/migrations";
import { sendChatAction } from "../telegram/chat-action";
import type { Env } from "../types";

// How often the alarm re-sends the Telegram "typing" action. Telegram's action expires after ~5s.
const TYPING_INTERVAL_MS = 4000;

enum SessionStatus {
  Idle = "idle",
  Active = "active",
}


export class UserDO extends DurableObject<Env> {
  private db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
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

  lookupSessionById(sessionId: string): { type: string; chatId: number; topicId: number } | null {
    const row = this.db.get(sessions, { where: eq("sessionId", sessionId) });
    if (!row) return null;
    return { type: row.type, chatId: row.chatId, topicId: row.topicId };
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

  recordTaskSession(sessionId: string): void {
    this.db.insert(sessions, { type: "task", chatId: 0, topicId: 0, sessionId, status: SessionStatus.Idle });
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
    await Promise.all(
      active.map((s) => sendChatAction(this.env, s.chatId, s.topicId).catch(() => {})),
    );
    if (active.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + TYPING_INTERVAL_MS);
    }
  }


  getSettings(): { onboardingSeen: boolean } {
    const row = this.db.get(userSettings);
    return { onboardingSeen: !!row?.onboardingSeen };
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
      });
    }
  }
}
