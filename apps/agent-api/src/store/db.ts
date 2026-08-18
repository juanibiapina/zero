// do-orm Store adapter over DO SQLite. Runs inside UserDO; the agents and the
// turn orchestrator address it through the Store interface. Column names match
// the do-orm schema keys (camelCase).

import { and, asc, desc, eq, gt, lte, type Database } from "do-orm";
import {
  files,
  conversations,
  deliveries,
  externalCalls,
  knowledge,
  learningJobs,
  mailThreads,
  messages,
  pendingMessages,
  processedUpdates,
  schedules,
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
  trimOrphanToolResults,
  unclaimedBlockIndexes,
} from "./messages";
import { KnowledgeConflictError } from "./types";
import type {
  CompactionWindow,
  StoredFileRecord,
  ConversationContext,
  ExternalCallClaim,
  LearningMessage,
  MailThreadRecord,
  MailThreadStatus,
  Message,
  MessageContent,
  MessageKind,
  Role,
  ScheduleRecord,
  ScheduleStatus,
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
  country: string | null;
  firstContactAt: string | null;
  mailHistoryId: string | null;
  lastActiveAt: string | null;
  wokeAt: string | null;
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
    options?: {
      kind?: MessageKind;
      stopReason?: string | null;
      responseId?: string | null;
    },
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
        responseId: options?.responseId ?? null,
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
      messages: trimOrphanToolResults(rows.reverse().map(toMessage)),
    };
  }

  getCompactionWindow(conversationId: string, limit: number): CompactionWindow {
    const conv = this.db.get(conversations, {
      where: eq("id", conversationId),
    });
    const boundary = conv?.compactedThroughMessageId ?? null;
    // One row beyond the window answers `hasMore` without a second query.
    const rows = this.db.all(messages, {
      where:
        boundary === null
          ? eq("conversationId", conversationId)
          : and(eq("conversationId", conversationId), gt("id", boundary)),
      orderBy: asc("id"),
      limit: limit + 1,
    });
    return {
      summary: conv?.summary ?? null,
      messages: rows.slice(0, limit).map(toMessage),
      hasMore: rows.length > limit,
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
    // Schedules reference the conversation they deliver to, so they go before
    // it too. Resetting a thread cancels what was scheduled in it: the record
    // has no other thread to speak in.
    this.db.delete(schedules, { where: eq("conversationId", conv.id) });
    // Watched mail threads are bound to this conversation the same way: a
    // reply has nowhere to be announced once the chat is gone.
    this.db.delete(mailThreads, { where: eq("conversationId", conv.id) });
    this.db.delete(conversations, { where: eq("id", conv.id) });
  }

  getMostRecentConversation(): Thread | null {
    const newest = this.db.get(messages, { orderBy: desc("id") });
    if (!newest) return null;
    const conv = this.db.get(conversations, {
      where: eq("id", newest.conversationId),
    });
    if (!conv) return null;
    return { id: conv.id, chatId: conv.chatId, topicId: conv.topicId };
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
          responseId: null,
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

  countUndeliveredBlocks(messageId: number): number {
    const row = this.db.get(messages, { where: eq("id", messageId) });
    if (!row || row.role !== "assistant") return 0;
    const conv = this.db.get(conversations, {
      where: eq("id", row.conversationId),
    });
    // Below the watermark the absence of a claim means "written before claims
    // existed", not "never sent".
    if ((conv?.deliveredThroughMessageId ?? 0) >= messageId) return 0;
    const claimed = this.db
      .all(deliveries, { where: eq("messageId", messageId) })
      .map((d) => d.blockIndex);
    return unclaimedBlockIndexes(decodeContent(row.content), claimed).length;
  }

  markDeliveredThrough(conversationId: string, messageId: number): void {
    this.db.update(
      conversations,
      { deliveredThroughMessageId: messageId },
      { where: eq("id", conversationId) },
    );
  }

  // --- learning jobs ---

  beginLearningJob(jobId: string): number {
    return this.db.transaction(() => {
      const existing = this.db.get(learningJobs, { where: eq("jobId", jobId) });
      // Re-attaching to a job must not widen its range: a restarted job keeps
      // the high-water mark its prompt was built from.
      if (existing) return existing.highWaterMessageId;
      const newest = this.db.get(messages, { orderBy: desc("id") });
      const highWaterMessageId = newest?.id ?? 0;
      this.db.insert(learningJobs, {
        jobId,
        highWaterMessageId,
        startedAt: this.nowIso(),
      });
      return highWaterMessageId;
    });
  }

  listUnconsolidatedMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): LearningMessage[] {
    const out: LearningMessage[] = [];
    let cursor = input.afterId ?? 0;
    // `consolidatedAt IS NULL` cannot be expressed by do-orm's `eq` (it renders
    // `= ?`, which never matches NULL), so scan in batches and filter here,
    // paging until the page is full or the range is exhausted.
    const batch = Math.max(input.limit, 1) * 2;
    while (out.length < input.limit) {
      const rows = this.db.all(messages, {
        where: and(gt("id", cursor), lte("id", input.throughMessageId)),
        orderBy: asc("id"),
        limit: batch,
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        if (row.consolidatedAt === null)
          out.push({ ...toMessage(row), conversationId: row.conversationId });
      }
      if (rows.length < batch) break;
    }
    return out.slice(0, input.limit);
  }

  completeLearningJob(jobId: string, throughMessageId?: number): void {
    this.db.transaction(() => {
      const job = this.db.get(learningJobs, { where: eq("jobId", jobId) });
      // Idempotent by job id: a repeated completion after a lost acknowledgement
      // must not stamp a wider range or run twice.
      if (!job || job.completedAt !== null) return;
      const at = this.nowIso();
      // Never wider than what the learner was shown. A job whose input was cut
      // short leaves the remainder unconsolidated for its successor; stamping
      // the whole frozen range would mark those rows learned forever.
      const through = Math.min(
        job.highWaterMessageId,
        throughMessageId ?? job.highWaterMessageId,
      );
      this.db.update(
        messages,
        { consolidatedAt: at },
        { where: lte("id", through) },
      );
      this.db.update(
        learningJobs,
        { completedAt: at },
        { where: eq("jobId", jobId) },
      );
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
        undeliveredCount: tail ? this.countUndeliveredBlocks(tail.id) : 0,
      });
      if (hasWork) out.push({ id: c.id, chatId: c.chatId, topicId: c.topicId });
    }
    return out;
  }

  // --- files ---

  putFile(input: {
    id: string;
    storageKey: string;
    filename: string;
    mimeType: string;
    byteSize: number | null;
  }): StoredFileRecord {
    const file = { ...input, createdAt: this.nowIso() };
    this.db.insert(files, file);
    return file;
  }

  getFile(id: string): StoredFileRecord | null {
    const file = this.db.get(files, { where: eq("id", id) });
    return file ? { ...file, byteSize: file.byteSize ?? null } : null;
  }

  listFiles(): StoredFileRecord[] {
    return this.db.all(files).map((file) => ({
      ...file,
      byteSize: file.byteSize ?? null,
    }));
  }

  updateFileSize(id: string, byteSize: number): void {
    this.db.update(files, { byteSize }, { where: eq("id", id) });
  }

  deleteFile(id: string): void {
    this.db.delete(files, { where: eq("id", id) });
  }

  deleteAllFiles(): void {
    for (const file of this.db.all(files)) {
      this.db.delete(files, { where: eq("id", file.id) });
    }
  }

  // --- schedules ---

  createSchedule(input: {
    id: string;
    conversationId: string;
    prompt: string;
    pattern: string;
    timezone: string;
    nextDueAt: number;
  }): ScheduleRecord {
    const row = {
      ...input,
      status: "active" as const,
      createdAt: this.nowIso(),
      lastFiredAt: null,
    };
    this.db.insert(schedules, row);
    return row;
  }

  listSchedules(conversationId?: string): ScheduleRecord[] {
    return this.db
      .all(schedules, {
        where:
          conversationId === undefined
            ? eq("status", "active")
            : and(eq("status", "active"), eq("conversationId", conversationId)),
      })
      .map(toSchedule)
      .sort(byDueAt);
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.db.get(schedules, { where: eq("id", id) });
    return row ? toSchedule(row) : null;
  }

  cancelSchedule(id: string): boolean {
    const row = this.db.get(schedules, { where: eq("id", id) });
    if (!row || row.status !== "active") return false;
    this.db.update(
      schedules,
      { status: "cancelled", nextDueAt: null },
      { where: eq("id", id) },
    );
    return true;
  }

  listDueSchedules(now: number): ScheduleRecord[] {
    return this.db
      .all(schedules, { where: and(eq("status", "active"), lte("nextDueAt", now)) })
      .map(toSchedule)
      .sort(byDueAt);
  }

  advanceSchedule(
    id: string,
    input: { nextDueAt: number; lastFiredAt: string },
  ): void {
    this.db.update(
      schedules,
      { nextDueAt: input.nextDueAt, lastFiredAt: input.lastFiredAt },
      { where: eq("id", id) },
    );
  }

  retireSchedule(id: string, input: { lastFiredAt: string }): void {
    this.db.update(
      schedules,
      { status: "done", nextDueAt: null, lastFiredAt: input.lastFiredAt },
      { where: eq("id", id) },
    );
  }

  earliestScheduleDueAt(): number | null {
    const due = this.listSchedules()
      .map((s) => s.nextDueAt)
      .filter((at): at is number => at !== null);
    return due.length === 0 ? null : Math.min(...due);
  }

  // --- watched mail threads ---

  trackMailThread(input: {
    threadId: string;
    conversationId: string;
  }): MailThreadRecord {
    const existing = this.db.get(mailThreads, {
      where: eq("threadId", input.threadId),
    });
    if (existing) {
      // Re-watching moves the thread to the conversation asking for it: "watch
      // this here" must always mean here, not wherever it was first seen.
      this.db.update(
        mailThreads,
        { conversationId: input.conversationId, status: "active" },
        { where: eq("threadId", input.threadId) },
      );
      return toMailThread(this.db.get(mailThreads, {
        where: eq("threadId", input.threadId),
      })!);
    }
    const row = {
      threadId: input.threadId,
      conversationId: input.conversationId,
      status: "active" as const,
      createdAt: this.nowIso(),
      lastNotifiedAt: null,
    };
    this.db.insert(mailThreads, row);
    return row;
  }

  untrackMailThread(threadId: string): boolean {
    const existing = this.db.get(mailThreads, { where: eq("threadId", threadId) });
    if (!existing || existing.status !== "active") return false;
    this.db.update(mailThreads, { status: "stopped" }, { where: eq("threadId", threadId) });
    return true;
  }

  listMailThreads(conversationId?: string): MailThreadRecord[] {
    const where =
      conversationId === undefined
        ? eq("status", "active")
        : and(eq("status", "active"), eq("conversationId", conversationId));
    return this.db
      .all(mailThreads, { where })
      .map(toMailThread)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markMailThreadsNotified(threadIds: string[], notifiedAt: string): void {
    for (const threadId of threadIds) {
      this.db.update(
        mailThreads,
        { lastNotifiedAt: notifiedAt },
        { where: eq("threadId", threadId) },
      );
    }
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
      country: string;
      firstContactAt: string;
      mailHistoryId: string;
      lastActiveAt: string;
      wokeAt: string;
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
        country: seeded.country ?? null,
        mailHistoryId: seeded.mailHistoryId ?? null,
        lastActiveAt: seeded.lastActiveAt ?? null,
        wokeAt: seeded.wokeAt ?? null,
        isNewUser: true,
      };
    }
    return {
      onboardingSeen: !!row.onboardingSeen,
      googleOnboardingStatus: row.googleOnboardingStatus ?? null,
      createdAt: row.createdAt ?? null,
      timezone: row.timezone ?? null,
      country: row.country ?? null,
      mailHistoryId: row.mailHistoryId ?? null,
      lastActiveAt: row.lastActiveAt ?? null,
      wokeAt: row.wokeAt ?? null,
      isNewUser: false,
    };
  }

  updateSettings(patch: {
    onboardingSeen?: boolean;
    timezone?: string;
    country?: string;
    mailHistoryId?: string;
    lastActiveAt?: string;
    wokeAt?: string;
  }): void {
    const columns: Partial<{
      onboardingSeen: number;
      timezone: string;
      country: string;
      mailHistoryId: string;
      lastActiveAt: string;
      wokeAt: string;
    }> = {};
    if (patch.onboardingSeen !== undefined) {
      columns.onboardingSeen = patch.onboardingSeen ? 1 : 0;
    }
    if (patch.timezone !== undefined) columns.timezone = patch.timezone;
    if (patch.country !== undefined) columns.country = patch.country;
    if (patch.mailHistoryId !== undefined) columns.mailHistoryId = patch.mailHistoryId;
    if (patch.lastActiveAt !== undefined) columns.lastActiveAt = patch.lastActiveAt;
    if (patch.wokeAt !== undefined) columns.wokeAt = patch.wokeAt;
    this.upsertSettings(columns);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.upsertSettings({ googleOnboardingStatus: status });
  }

  claimFirstContact(): boolean {
    const row = this.db.get(userSettings) as SettingsRow | undefined;
    if (row?.firstContactAt) return false;
    this.upsertSettings({ firstContactAt: this.nowIso() });
    return true;
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
  responseId?: string | null;
  createdAt: string;
}): Message {
  return {
    id: m.id,
    role: m.role as Role,
    kind: m.kind as MessageKind,
    content: decodeContent(m.content),
    stopReason: m.stopReason,
    responseId: m.responseId ?? null,
    createdAt: m.createdAt,
  };
}

function toSchedule(s: {
  id: string;
  conversationId: string;
  prompt: string;
  pattern: string;
  timezone: string;
  nextDueAt: number | null;
  status: string;
  createdAt: string;
  lastFiredAt: string | null;
}): ScheduleRecord {
  return {
    ...s,
    nextDueAt: s.nextDueAt ?? null,
    status: s.status as ScheduleStatus,
    lastFiredAt: s.lastFiredAt ?? null,
  };
}

function toMailThread(t: {
  threadId: string;
  conversationId: string;
  status: string;
  createdAt: string;
  lastNotifiedAt: string | null;
}): MailThreadRecord {
  return {
    ...t,
    status: t.status as MailThreadStatus,
    lastNotifiedAt: t.lastNotifiedAt ?? null,
  };
}

// Soonest first. A retired row has no due time and sorts last, though the two
// call sites only ever see active rows.
const byDueAt = (a: ScheduleRecord, b: ScheduleRecord): number =>
  (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity);

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
