// do-orm Store adapter over DO SQLite. Runs inside UserDO; the agents and the
// turn orchestrator address it through the Store interface. Column names match
// the do-orm schema keys (camelCase).

import { and, desc, eq, type Database } from "do-orm";
import {
  attachments,
  conversations,
  messages,
  processedUpdates,
  telegramLink,
  topics,
  topicLinks,
  userSettings,
} from "../UserDO/db/schema";
import { extractLinks, rewriteLinks } from "./links";
import type {
  Attachment,
  Message,
  Role,
  Store,
  Thread,
  Topic,
  TopicMeta,
  UserSettings,
} from "./types";

// The persisted user_settings row shape (do-orm schema keys).
interface SettingsRow {
  id: number;
  onboardingSeen: number;
  googleOnboardingStatus: string | null;
  createdAt: string | null;
  timezone: string | null;
}

export class DbStore implements Store {
  constructor(private db: Database) {}

  private nowIso(): string {
    return new Date().toISOString();
  }

  // --- topics ---

  listTopics(): TopicMeta[] {
    return this.db
      .all(topics, { orderBy: desc("lastActiveAt") })
      .map((t) => ({
        name: t.name,
        description: t.description,
        lastActiveAt: t.lastActiveAt,
        messageCount: t.messageCount,
        pinned: !!t.pinned,
        system: false,
      }));
  }

  getTopic(name: string): Topic | null {
    const t = this.db.get(topics, { where: eq("name", name) });
    return t ? toTopic(t) : null;
  }

  // Re-derive a topic's outbound link rows from its body. Resolves each
  // `[[Name]]` to the target topic's id when one exists (else null: a dangling
  // link). Called on every body write so rows never drift from the text.
  private syncOutboundLinks(sourceId: number, body: string): void {
    this.db.delete(topicLinks, { where: eq("sourceId", sourceId) });
    for (const target of extractLinks(body)) {
      const t = this.db.get(topics, { where: eq("name", target) });
      this.db.insert(topicLinks, {
        sourceId,
        targetName: target,
        targetId: t ? t.id : null,
      });
    }
  }

  // Re-derive every topic's outbound link rows from its current body. Used once
  // after migration 0022, which folded legacy summaries into bodies: the folded
  // text can carry [[Name]] tokens that no link row covers. Idempotent, so a
  // repeated run is harmless.
  rebuildAllLinks(): void {
    for (const t of this.db.all(topics)) this.syncOutboundLinks(t.id, t.body);
  }

  getOutboundLinks(name: string): string[] {
    const t = this.db.get(topics, { where: eq("name", name) });
    if (!t) return [];
    return this.db
      .all(topicLinks, { where: eq("sourceId", t.id) })
      .map((l) => l.targetName);
  }

  getBacklinks(name: string): TopicMeta[] {
    const rows = this.db.all(topicLinks, { where: eq("targetName", name) });
    const seen = new Set<number>();
    const out: TopicMeta[] = [];
    for (const r of rows) {
      if (seen.has(r.sourceId)) continue;
      seen.add(r.sourceId);
      const t = this.db.get(topics, { where: eq("id", r.sourceId) });
      if (t) {
        out.push({
          name: t.name,
          description: t.description,
          lastActiveAt: t.lastActiveAt,
          messageCount: t.messageCount,
          pinned: !!t.pinned,
          system: false,
        });
      }
    }
    return out;
  }

  setPinned(name: string, pinned: boolean): void {
    this.db.update(
      topics,
      { pinned: pinned ? 1 : 0 },
      { where: eq("name", name) },
    );
  }

  getPinnedTopics(): Topic[] {
    return this.db
      .all(topics, { where: eq("pinned", 1) })
      .map((t) => toTopic(t));
  }

  createTopic(name: string, description: string): void {
    const now = this.nowIso();
    this.db.insert(topics, {
      name,
      description,
      body: "",
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    });
    // Resolve any dangling links that pointed at this name before it existed.
    const created = this.db.get(topics, { where: eq("name", name) });
    if (created) {
      this.db.update(
        topicLinks,
        { targetId: created.id },
        { where: eq("targetName", name) },
      );
    }
  }

  deleteTopic(name: string): void {
    const t = this.db.get(topics, { where: eq("name", name) });
    if (!t) throw new Error(`topic not found: ${name}`);
    // Null out inbound links so no row references the deleted id (FK safety);
    // their [[Name]] tokens stay in the source bodies, so the links become
    // dangling and re-resolve if a topic of this name is recreated.
    this.db.update(
      topicLinks,
      { targetId: null },
      { where: eq("targetId", t.id) },
    );
    // Drop this topic's own outbound rows, then the topic row itself.
    this.db.delete(topicLinks, { where: eq("sourceId", t.id) });
    this.db.delete(topics, { where: eq("id", t.id) });
  }

  updateTopicBody(name: string, body: string): void {
    this.db.update(
      topics,
      { body, lastActiveAt: this.nowIso() },
      { where: eq("name", name) },
    );
    const t = this.db.get(topics, { where: eq("name", name) });
    if (t) this.syncOutboundLinks(t.id, body);
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    const out: Topic[] = [];
    for (const name of names) {
      const t = this.db.get(topics, { where: eq("name", name) });
      if (t) out.push(toTopic(t));
    }
    return out;
  }

  saveTopic(
    name: string,
    patch: { body: string; description: string },
    newName?: string,
  ): void {
    const existing = this.db.get(topics, { where: eq("name", name) });
    if (!existing) throw new Error(`topic not found: ${name}`);
    const rename = newName && newName !== name;
    if (rename) {
      const clash = this.db.get(topics, { where: eq("name", newName) });
      if (clash) throw new Error(`topic exists: ${newName}`);
    }
    this.db.update(
      topics,
      {
        body: patch.body,
        description: patch.description,
        lastActiveAt: this.nowIso(),
        messageCount: existing.messageCount + 1,
        ...(rename ? { name: newName } : {}),
      },
      { where: eq("id", existing.id) },
    );

    if (rename && newName) {
      // Links that already targeted the new name (dangling before now) resolve
      // to this topic.
      this.db.update(
        topicLinks,
        { targetId: existing.id },
        { where: eq("targetName", newName) },
      );
      // Rewrite `[[name]]` -> `[[newName]]` in every other body and re-derive
      // their rows, so bodies and rows move together.
      for (const other of this.db.all(topics)) {
        if (other.id === existing.id) continue;
        const rewritten = rewriteLinks(other.body, name, newName);
        if (rewritten !== other.body) {
          this.db.update(
            topics,
            { body: rewritten },
            { where: eq("id", other.id) },
          );
          this.syncOutboundLinks(other.id, rewritten);
        }
      }
    }
    this.syncOutboundLinks(existing.id, patch.body);
  }

  // --- conversations ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    const existing = this.db.get(conversations, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.insert(conversations, {
      id,
      chatId,
      topicId,
      createdAt: this.nowIso(),
    });
    return id;
  }

  storeMessage(conversationId: string, role: Role, content: string): void {
    this.db.insert(messages, {
      conversationId,
      role,
      content,
      createdAt: this.nowIso(),
    });
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    const rows = this.db.all(messages, {
      where: eq("conversationId", conversationId),
      orderBy: desc("id"),
      limit,
    });
    return rows
      .reverse()
      .map((m) => ({
        role: m.role as Role,
        content: m.content,
        createdAt: m.createdAt,
      }));
  }

  resetConversation(chatId: number, topicId: number): void {
    const conv = this.db.get(conversations, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (!conv) return;
    // Delete FK children (messages, attachments) before the conversation row,
    // else SQLite rejects the parent delete with a FOREIGN KEY constraint error.
    this.db.delete(messages, { where: eq("conversationId", conv.id) });
    this.db.delete(attachments, { where: eq("conversationId", conv.id) });
    this.db.delete(conversations, { where: eq("id", conv.id) });
  }

  findThreadsAwaitingReply(): Thread[] {
    const out: Thread[] = [];
    for (const c of this.db.all(conversations)) {
      const tail = this.db.get(messages, {
        where: eq("conversationId", c.id),
        orderBy: desc("id"),
      });
      if (tail && tail.role === "user") {
        out.push({ id: c.id, chatId: c.chatId, topicId: c.topicId });
      }
    }
    return out;
  }

  // --- attachments ---

  putAttachment(a: {
    id: string;
    conversationId: string;
    r2Key: string;
    filename: string;
    mimeType: string;
  }): void {
    this.db.insert(attachments, {
      id: a.id,
      conversationId: a.conversationId,
      r2Key: a.r2Key,
      filename: a.filename,
      mimeType: a.mimeType,
      createdAt: this.nowIso(),
    });
  }

  getAttachment(id: string): Attachment | null {
    const a = this.db.get(attachments, { where: eq("id", id) });
    return a
      ? {
          id: a.id,
          conversationId: a.conversationId,
          r2Key: a.r2Key,
          filename: a.filename,
          mimeType: a.mimeType,
          createdAt: a.createdAt,
        }
      : null;
  }

  // --- settings ---

  // Get the single settings row, updating the given columns if it exists or
  // inserting it with defaults + those columns if it does not. Returns the
  // persisted row so callers report the value actually stored (never a second
  // clock read). Shared by getSettings/updateSettings/setGoogleOnboardingStatus.
  private upsertSettings(
    columns: Partial<{
      onboardingSeen: number;
      googleOnboardingStatus: string;
      timezone: string;
    }>,
  ): SettingsRow {
    const existing = this.db.get(userSettings);
    if (existing) {
      if (Object.keys(columns).length > 0) {
        this.db.update(userSettings, columns, { where: eq("id", existing.id) });
      }
      // Re-read so callers see the persisted post-update state.
      return this.db.get(userSettings)! as SettingsRow;
    }
    this.db.insert(userSettings, {
      onboardingSeen: 0,
      createdAt: this.nowIso(),
      ...columns,
    });
    return this.db.get(userSettings)! as SettingsRow;
  }

  getSettings(): UserSettings {
    const row = this.db.get(userSettings);
    if (!row) {
      // Seed the row and report the persisted values (createdAt is the one the
      // insert wrote, not a fresh clock read).
      const seeded = this.upsertSettings({});
      return {
        onboardingSeen: !!seeded.onboardingSeen,
        googleOnboardingStatus: seeded.googleOnboardingStatus ?? null,
        createdAt: seeded.createdAt ?? null,
        timezone: seeded.timezone ?? null,
        isNewUser: true,
      };
    }
    return {
      onboardingSeen: !!row.onboardingSeen,
      googleOnboardingStatus: row.googleOnboardingStatus ?? null,
      createdAt: row.createdAt ?? null,
      timezone: row.timezone ?? null,
      isNewUser: false,
    };
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
    const columns: Partial<{ onboardingSeen: number; timezone: string }> = {};
    if (patch.onboardingSeen !== undefined) {
      columns.onboardingSeen = patch.onboardingSeen ? 1 : 0;
    }
    if (patch.timezone !== undefined) columns.timezone = patch.timezone;
    this.upsertSettings(columns);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.upsertSettings({ googleOnboardingStatus: status });
  }

  // --- telegram link ---

  getTelegramId(): string | null {
    const row = this.db.get(telegramLink);
    return row?.telegramId ?? null;
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    const existing = this.db.get(telegramLink);
    const previous = existing?.telegramId ?? null;
    if (existing) {
      this.db.update(
        telegramLink,
        { telegramId },
        { where: eq("id", existing.id) },
      );
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

  // --- webhook idempotency ---

  markProcessed(updateId: string): boolean {
    const existing = this.db.get(processedUpdates, {
      where: eq("updateId", updateId),
    });
    if (existing) return false;
    this.db.insert(processedUpdates, {
      updateId,
      createdAt: this.nowIso(),
    });
    return true;
  }
}

function toTopic(t: {
  name: string;
  description: string;
  body: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  pinned: number;
}): Topic {
  return {
    name: t.name,
    description: t.description,
    body: t.body,
    createdAt: t.createdAt,
    lastActiveAt: t.lastActiveAt,
    messageCount: t.messageCount,
    pinned: !!t.pinned,
    system: false,
  };
}
