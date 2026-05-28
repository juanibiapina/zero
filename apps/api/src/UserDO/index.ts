import { DurableObject } from "cloudflare:workers";
import { createDb, eq, and, type Database } from "do-orm";
import { migrate } from "do-orm";
import { telegramLink, sessions, mountConfigs } from "./db/schema";
import { migrations } from "./db/migrations";
import type { Env } from "../types";

export interface S3MountConfig {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
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

  lookupSessionById(sessionId: string): { chatId: number; topicId: number } | null {
    const row = this.db.get(sessions, { where: eq("sessionId", sessionId) });
    if (!row) return null;
    return { chatId: row.chatId, topicId: row.topicId };
  }

  recordSession(chatId: number, topicId: number, sessionId: string): void {
    // Remove any existing session for this topic
    const existing = this.db.get(sessions, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (existing) {
      this.db.delete(sessions, { where: eq("id", existing.id) });
    }
    this.db.insert(sessions, { chatId, topicId, sessionId });
  }

  forgetSession(sessionId: string): void {
    this.db.delete(sessions, { where: eq("sessionId", sessionId) });
  }

  getMountConfig(scope: string): S3MountConfig | null {
    const row = this.db.get(mountConfigs, { where: eq("scope", scope) });
    if (!row) return null;
    return {
      endpoint: row.endpoint,
      bucket: row.bucket,
      prefix: row.prefix,
      accessKeyId: row.accessKeyId,
      secretAccessKey: row.secretAccessKey,
    };
  }

  setMountConfig(scope: string, config: S3MountConfig): void {
    const existing = this.db.get(mountConfigs, { where: eq("scope", scope) });
    if (existing) {
      this.db.update(mountConfigs, { ...config }, { where: eq("id", existing.id) });
    } else {
      this.db.insert(mountConfigs, { scope, ...config });
    }
  }

  deleteMountConfig(scope: string): void {
    this.db.delete(mountConfigs, { where: eq("scope", scope) });
  }
}
