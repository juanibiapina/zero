// do-orm Store adapter over DO SQLite. Runs inside UserDO; the agents and the
// turn orchestrator address it through the Store interface. Column names match
// the do-orm schema keys (camelCase).

import { and, asc, desc, eq, gt, type Database } from "do-orm";
import {
  attachments,
  conversations,
  deliveries,
  externalCalls,
  knowledge,
  messages,
  pendingMessages,
  processedUpdates,
  telegramLink,
  topics,
  topicLinks,
  userSettings,
} from "../UserDO/db/schema";
import { extractLinks, rewriteLinks } from "./links";
import {
  conversationHasWork,
  decodeContent,
  defaultKind,
  encodeContent,
} from "./messages";
import { KnowledgeConflictError } from "./types";
import type {
  Attachment,
  ConversationContext,
  ExternalCallClaim,
  Message,
  MessageContent,
  MessageKind,
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

  setPinned(input: {
    expectedVersion: number;
    name: string;
    pinned: boolean;
  }): number {
    this.requireVersion(input.expectedVersion);
    this.db.update(
      topics,
      { pinned: input.pinned ? 1 : 0 },
      { where: eq("name", input.name) },
    );
    return this.bumpVersion();
  }

  getPinnedTopics(): Topic[] {
    return this.db
      .all(topics, { where: eq("pinned", 1) })
      .map((t) => toTopic(t));
  }

  createTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): number {
    this.requireVersion(input.expectedVersion);
    if (this.db.get(topics, { where: eq("name", input.name) })) {
      throw new Error(`topic exists: ${input.name}`);
    }
    const now = this.nowIso();
    this.db.insert(topics, {
      name: input.name,
      description: input.description,
      body: input.body,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    });
    const created = this.db.get(topics, { where: eq("name", input.name) })!;
    // Resolve any dangling links that pointed at this name before it existed.
    this.db.update(
      topicLinks,
      { targetId: created.id },
      { where: eq("targetName", input.name) },
    );
    // A topic is created complete, so its own outbound links exist from the
    // first write.
    this.syncOutboundLinks(created.id, input.body);
    return this.bumpVersion();
  }

  deleteTopic(input: { expectedVersion: number; name: string }): number {
    this.requireVersion(input.expectedVersion);
    const t = this.db.get(topics, { where: eq("name", input.name) });
    if (!t) throw new Error(`topic not found: ${input.name}`);
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
    return this.bumpVersion();
  }

  updateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): number {
    this.requireVersion(input.expectedVersion);
    const existing = this.db.get(topics, { where: eq("name", input.name) });
    if (!existing) throw new Error(`topic not found: ${input.name}`);
    this.db.update(
      topics,
      {
        body: input.body,
        lastActiveAt: this.nowIso(),
        messageCount: existing.messageCount + 1,
      },
      { where: eq("id", existing.id) },
    );
    this.syncOutboundLinks(existing.id, input.body);
    return this.bumpVersion();
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    const out: Topic[] = [];
    for (const name of names) {
      const t = this.db.get(topics, { where: eq("name", name) });
      if (t) out.push(toTopic(t));
    }
    return out;
  }

  updateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): number {
    this.requireVersion(input.expectedVersion);
    const { name, newName } = input;
    const existing = this.db.get(topics, { where: eq("name", name) });
    if (!existing) throw new Error(`topic not found: ${name}`);
    const rename = Boolean(newName && newName !== name);
    if (rename && this.db.get(topics, { where: eq("name", newName!) })) {
      throw new Error(`topic exists: ${newName}`);
    }
    this.db.update(
      topics,
      {
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
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
    return this.bumpVersion();
  }

  // --- knowledge version ---

  private knowledgeRow(): { id: number; version: number; systemFingerprint: string | null } {
    const row = this.db.get(knowledge);
    if (row) return row;
    this.db.insert(knowledge, { id: 1, version: 1 });
    return this.db.get(knowledge)!;
  }

  getKnowledgeVersion(): number {
    return this.knowledgeRow().version;
  }

  private requireVersion(expected: number): void {
    const current = this.getKnowledgeVersion();
    if (current !== expected) throw new KnowledgeConflictError(expected, current);
  }

  private bumpVersion(): number {
    const row = this.knowledgeRow();
    const next = row.version + 1;
    this.db.update(knowledge, { version: next }, { where: eq("id", row.id) });
    return next;
  }

  syncSystemTopicsFingerprint(fingerprint: string): number {
    const row = this.knowledgeRow();
    if (row.systemFingerprint === fingerprint) return row.version;
    const next = row.version + 1;
    this.db.update(
      knowledge,
      { version: next, systemFingerprint: fingerprint },
      { where: eq("id", row.id) },
    );
    return next;
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

  storeMessage(
    conversationId: string,
    role: Role,
    content: MessageContent,
    options?: { kind?: MessageKind; stopReason?: string | null },
  ): number {
    const row = this.db.insertReturning(
      messages,
      {
        conversationId,
        role,
        content: encodeContent(content),
        kind: options?.kind ?? defaultKind(role),
        stopReason:
          options?.stopReason !== undefined
            ? options.stopReason
            : role === "assistant"
              ? "end_turn"
              : null,
        createdAt: this.nowIso(),
      },
      ["id"],
    );
    return row.id;
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    const rows = this.db.all(messages, {
      where: eq("conversationId", conversationId),
      orderBy: desc("id"),
      limit,
    });
    return rows.reverse().map(toMessage);
  }

  getConversationContext(
    conversationId: string,
    limit: number,
  ): ConversationContext {
    const conv = this.db.get(conversations, {
      where: eq("id", conversationId),
    });
    const boundary = conv?.compactedThroughMessageId ?? null;
    const rows = this.db.all(messages, {
      where:
        boundary === null
          ? eq("conversationId", conversationId)
          : and(eq("conversationId", conversationId), gt("id", boundary)),
      orderBy: desc("id"),
      limit,
    });
    return {
      summary: conv?.summary ?? null,
      messages: rows.reverse().map(toMessage),
    };
  }

  compactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): void {
    this.db.update(
      conversations,
      {
        compactedThroughMessageId: input.throughMessageId,
        summary: input.summary,
      },
      { where: eq("id", conversationId) },
    );
  }

  resetConversation(chatId: number, topicId: number): void {
    const conv = this.db.get(conversations, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (!conv) return;
    // Delete FK children before the conversation row, else SQLite rejects the
    // parent delete with a FOREIGN KEY constraint error. Deliveries hang off
    // messages, so they go first of all.
    for (const m of this.db.all(messages, {
      where: eq("conversationId", conv.id),
    })) {
      this.db.delete(deliveries, { where: eq("messageId", m.id) });
    }
    this.db.delete(messages, { where: eq("conversationId", conv.id) });
    this.db.delete(pendingMessages, { where: eq("conversationId", conv.id) });
    this.db.delete(attachments, { where: eq("conversationId", conv.id) });
    this.db.delete(conversations, { where: eq("id", conv.id) });
  }

  // --- pending queue ---

  enqueuePendingMessage(conversationId: string, content: string): void {
    this.db.insert(pendingMessages, {
      conversationId,
      content,
      createdAt: this.nowIso(),
    });
  }

  // Queued, not-yet-injected rows in arrival order. The `injectedAt IS NULL`
  // filter is applied here rather than in SQL: do-orm's `eq` renders `= ?`,
  // which never matches NULL.
  private pendingRows(conversationId: string) {
    return this.db
      .all(pendingMessages, {
        where: eq("conversationId", conversationId),
        orderBy: asc("id"),
      })
      .filter((p) => p.injectedAt === null);
  }

  drainPendingMessages(conversationId: string): Message[] {
    return this.db.transaction(() => {
      const out: Message[] = [];
      for (const row of this.pendingRows(conversationId)) {
        const id = this.storeMessage(conversationId, "user", row.content);
        this.db.update(
          pendingMessages,
          { injectedAt: this.nowIso() },
          { where: eq("id", row.id) },
        );
        out.push({
          id,
          role: "user",
          kind: "user_message",
          content: [{ type: "text", text: row.content }],
          stopReason: null,
          createdAt: row.createdAt,
        });
      }
      return out;
    });
  }

  // --- delivery claims ---

  claimDelivery(messageId: number, blockIndex: number): boolean {
    return this.db.transaction(() => {
      const existing = this.db.get(deliveries, {
        where: and(eq("messageId", messageId), eq("blockIndex", blockIndex)),
      });
      if (existing) return false;
      this.db.insert(deliveries, {
        messageId,
        blockIndex,
        claimedAt: this.nowIso(),
      });
      return true;
    });
  }

  // --- external calls ---

  beginExternalCall(toolUseId: string, tool: string): ExternalCallClaim {
    return this.db.transaction(() => {
      const existing = this.db.get(externalCalls, {
        where: eq("toolUseId", toolUseId),
      });
      if (existing) {
        return existing.status === "completed"
          ? { status: "completed" as const, result: existing.result ?? "" }
          : { status: "in_flight" as const };
      }
      this.db.insert(externalCalls, {
        toolUseId,
        tool,
        status: "started",
        startedAt: this.nowIso(),
      });
      return { status: "claimed" as const };
    });
  }

  completeExternalCall(toolUseId: string, result: string): void {
    this.db.update(
      externalCalls,
      { status: "completed", result, completedAt: this.nowIso() },
      { where: eq("toolUseId", toolUseId) },
    );
  }

  findConversationsWithWork(): Thread[] {
    const out: Thread[] = [];
    for (const c of this.db.all(conversations)) {
      const tail = this.db.get(messages, {
        where: eq("conversationId", c.id),
        orderBy: desc("id"),
      });
      const hasWork = conversationHasWork({
        pendingCount: this.pendingRows(c.id).length,
        tail: tail
          ? { kind: tail.kind as MessageKind, stopReason: tail.stopReason }
          : undefined,
      });
      if (hasWork) out.push({ id: c.id, chatId: c.chatId, topicId: c.topicId });
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

function toMessage(m: {
  id: number;
  role: string;
  kind: string;
  content: string;
  stopReason: string | null;
  createdAt: string;
}): Message {
  return {
    id: m.id,
    role: m.role as Role,
    kind: m.kind as MessageKind,
    content: decodeContent(m.content),
    stopReason: m.stopReason,
    createdAt: m.createdAt,
  };
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
