// In-memory Store adapter. Used by unit tests to exercise the agents and the
// turn orchestrator without a Durable Object. Mirrors DbStore semantics; the
// shared contract test (store-contract.test.ts) runs against both.

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
  ConversationStore,
  ExternalCallClaim,
  LearningMessage,
  MailThreadRecord,
  Message,
  MessageContent,
  MessageKind,
  Role,
  ScheduleRecord,
  Store,
  Thread,
  Topic,
  TopicMeta,
  UserSettings,
} from "./types";
import { extractLinks, rewriteLinks } from "./links";

// The persisted settings row, mirroring DbStore's user_settings columns.
interface SettingsRow {
  onboardingSeen: number;
  googleOnboardingStatus: string | null;
  createdAt: string;
  timezone: string | null;
  country: string | null;
  firstContactAt: string | null;
  mailHistoryId: string | null;
  lastActiveAt: string | null;
}

interface ConvRow {
  id: string;
  chatId: number;
  topicId: number;
  compactedThroughMessageId: number | null;
  summary: string | null;
  deliveredThroughMessageId: number | null;
}

interface MsgRow {
  id: number;
  conversationId: string;
  role: Role;
  kind: MessageKind;
  // Encoded exactly as the SQLite adapter stores it: JSON content blocks.
  content: string;
  stopReason: string | null;
  responseId: string | null;
  consolidatedAt: string | null;
  createdAt: string;
}

interface PendingRow {
  id: number;
  conversationId: string;
  content: string;
  createdAt: string;
  injectedAt: string | null;
}

const toMessage = (m: MsgRow): Message => ({
  id: m.id,
  role: m.role,
  kind: m.kind,
  content: decodeContent(m.content),
  stopReason: m.stopReason,
  responseId: m.responseId,
  createdAt: m.createdAt,
});

export class MemoryStore implements Store {
  private topics = new Map<string, Topic>();
  // One entry per (source topic name -> target name) link. Kept in sync with
  // topic bodies by syncOutboundLinks on every write.
  private links: { source: string; target: string }[] = [];
  private convs: ConvRow[] = [];
  private msgs: MsgRow[] = [];
  private pending: PendingRow[] = [];
  // Claimed delivery keys, `${messageId}:${blockIndex}`.
  private claimed = new Set<string>();
  // Learning jobs by id, mirroring the learning_jobs table.
  private jobs = new Map<
    string,
    { highWaterMessageId: number; completed: boolean }
  >();
  // External-call claims by tool_use id, mirroring the external_calls table.
  private external = new Map<
    string,
    { tool: string; status: string; result: string | null }
  >();
  private files = new Map<string, StoredFileRecord>();
  // Schedule rows in creation order, mirroring the schedules table.
  private schedules: ScheduleRecord[] = [];
  // Watched Gmail threads, mirroring the mail_threads table.
  private mailThreads: MailThreadRecord[] = [];
  private settingsRow: SettingsRow | null = null;
  private telegramId: string | null = null;
  private processed = new Set<string>();
  private nextMsgId = 1;
  private nextPendingId = 1;
  private version = 1;
  private systemFingerprint: string | null = null;
  private now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  // --- topics ---

  listTopics(): TopicMeta[] {
    return [...this.topics.values()].map((t) => ({
      name: t.name,
      description: t.description,
      lastActiveAt: t.lastActiveAt,
      messageCount: t.messageCount,
      pinned: t.pinned,
      system: false,
    }));
  }

  getTopic(name: string): Topic | null {
    const t = this.topics.get(name);
    return t ? { ...t } : null;
  }

  private syncOutboundLinks(source: string, body: string): void {
    this.links = this.links.filter((l) => l.source !== source);
    for (const target of extractLinks(body)) {
      this.links.push({ source, target });
    }
  }

  getOutboundLinks(name: string): string[] {
    return this.links.filter((l) => l.source === name).map((l) => l.target);
  }

  getBacklinks(name: string): TopicMeta[] {
    const sources = new Set(
      this.links.filter((l) => l.target === name).map((l) => l.source),
    );
    const out: TopicMeta[] = [];
    for (const s of sources) {
      const t = this.topics.get(s);
      if (t) {
        out.push({
          name: t.name,
          description: t.description,
          lastActiveAt: t.lastActiveAt,
          messageCount: t.messageCount,
          pinned: t.pinned,
          system: false,
        });
      }
    }
    return out;
  }

  createTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): number {
    this.requireVersion(input.expectedVersion);
    if (this.topics.has(input.name)) throw new Error(`topic exists: ${input.name}`);
    const now = this.now();
    this.topics.set(input.name, {
      name: input.name,
      description: input.description,
      body: input.body,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      pinned: false,
      system: false,
    });
    this.syncOutboundLinks(input.name, input.body);
    return this.bumpVersion();
  }

  deleteTopic(input: { expectedVersion: number; name: string }): number {
    this.requireVersion(input.expectedVersion);
    if (!this.topics.has(input.name))
      throw new Error(`topic not found: ${input.name}`);
    this.topics.delete(input.name);
    // Drop this topic's own outbound rows. Inbound rows (other bodies linking
    // to `name`) stay: their [[Name]] tokens remain in those bodies, so the
    // links become dangling, consistent with a not-yet-created target.
    this.links = this.links.filter((l) => l.source !== input.name);
    return this.bumpVersion();
  }

  setPinned(input: {
    expectedVersion: number;
    name: string;
    pinned: boolean;
  }): number {
    this.requireVersion(input.expectedVersion);
    const t = this.topics.get(input.name);
    if (!t) throw new Error(`topic not found: ${input.name}`);
    t.pinned = input.pinned;
    return this.bumpVersion();
  }

  getPinnedTopics(): Topic[] {
    return [...this.topics.values()]
      .filter((t) => t.pinned)
      .map((t) => ({ ...t }));
  }

  updateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): number {
    this.requireVersion(input.expectedVersion);
    const t = this.topics.get(input.name);
    if (!t) throw new Error(`topic not found: ${input.name}`);
    t.body = input.body;
    t.lastActiveAt = this.now();
    t.messageCount += 1;
    this.syncOutboundLinks(input.name, input.body);
    return this.bumpVersion();
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    const out: Topic[] = [];
    for (const name of names) {
      const t = this.topics.get(name);
      if (t) out.push({ ...t });
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
    const t = this.topics.get(name);
    if (!t) throw new Error(`topic not found: ${name}`);
    if (newName && newName !== name && this.topics.has(newName)) {
      throw new Error(`topic exists: ${newName}`);
    }
    if (input.description !== undefined) t.description = input.description;
    t.lastActiveAt = this.now();
    t.messageCount += 1;
    if (newName && newName !== name) {
      this.topics.delete(name);
      t.name = newName;
      this.topics.set(newName, t);
      // Repoint this topic's own outbound rows to its new source name.
      for (const l of this.links) if (l.source === name) l.source = newName;
      // Rewrite `[[name]]` -> `[[newName]]` in every other body and re-derive
      // their link rows, so bodies and rows move together.
      for (const other of this.topics.values()) {
        if (other.name === newName) continue;
        const rewritten = rewriteLinks(other.body, name, newName);
        if (rewritten !== other.body) {
          other.body = rewritten;
          this.syncOutboundLinks(other.name, rewritten);
        }
      }
    }
    return this.bumpVersion();
  }

  // --- knowledge version ---

  getKnowledgeVersion(): number {
    return this.version;
  }

  private requireVersion(expected: number): void {
    if (this.version !== expected)
      throw new KnowledgeConflictError(expected, this.version);
  }

  private bumpVersion(): number {
    this.version += 1;
    return this.version;
  }

  syncSystemTopicsFingerprint(fingerprint: string): number {
    if (this.systemFingerprint === fingerprint) return this.version;
    this.systemFingerprint = fingerprint;
    return this.bumpVersion();
  }

  // --- conversations ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    const existing = this.convs.find(
      (c) => c.chatId === chatId && c.topicId === topicId,
    );
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.convs.push({
      id,
      chatId,
      topicId,
      compactedThroughMessageId: null,
      summary: null,
      deliveredThroughMessageId: null,
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
    const id = this.nextMsgId++;
    this.msgs.push({
      id,
      conversationId,
      role,
      kind: options?.kind ?? defaultKind(role),
      // Stored encoded, exactly as DbStore does, so a test cannot pass on a
      // representation production never produces.
      content: encodeContent(content),
      stopReason:
        options?.stopReason !== undefined
          ? options.stopReason
          : role === "assistant"
            ? "end_turn"
            : null,
      responseId: options?.responseId ?? null,
      consolidatedAt: null,
      createdAt: this.now(),
    });
    return id;
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    return this.msgs
      .filter((m) => m.conversationId === conversationId)
      .slice(-limit)
      .map(toMessage);
  }

  getConversationContext(
    conversationId: string,
    limit: number,
  ): ConversationContext {
    const conv = this.convs.find((c) => c.id === conversationId);
    const boundary = conv?.compactedThroughMessageId ?? null;
    return {
      summary: conv?.summary ?? null,
      messages: trimOrphanToolResults(
        this.msgs
          .filter(
            (m) =>
              m.conversationId === conversationId &&
              (boundary === null || m.id > boundary),
          )
          .slice(-limit)
          .map(toMessage),
      ),
    };
  }

  getCompactionWindow(conversationId: string, limit: number): CompactionWindow {
    const conv = this.convs.find((c) => c.id === conversationId);
    const boundary = conv?.compactedThroughMessageId ?? null;
    const after = this.msgs.filter(
      (m) =>
        m.conversationId === conversationId &&
        (boundary === null || m.id > boundary),
    );
    return {
      summary: conv?.summary ?? null,
      messages: after.slice(0, limit).map(toMessage),
      hasMore: after.length > limit,
    };
  }

  compactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): void {
    const conv = this.convs.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.compactedThroughMessageId = input.throughMessageId;
    conv.summary = input.summary;
  }

  resetConversation(chatId: number, topicId: number): void {
    const conv = this.convs.find(
      (c) => c.chatId === chatId && c.topicId === topicId,
    );
    if (!conv) return;
    const dropped = new Set(
      this.msgs.filter((m) => m.conversationId === conv.id).map((m) => m.id),
    );
    this.msgs = this.msgs.filter((m) => m.conversationId !== conv.id);
    this.pending = this.pending.filter((p) => p.conversationId !== conv.id);
    this.claimed = new Set(
      [...this.claimed].filter((k) => !dropped.has(Number(k.split(":")[0]))),
    );
    // Schedules deliver into this thread and have no other one to speak in, so
    // a reset takes them with it (DbStore also needs this for FK ordering).
    this.schedules = this.schedules.filter((s) => s.conversationId !== conv.id);
    // Same for watched mail threads: a reply has nowhere to be announced.
    this.mailThreads = this.mailThreads.filter(
      (t) => t.conversationId !== conv.id,
    );
    this.convs = this.convs.filter((c) => c.id !== conv.id);
  }

  // --- pending queue ---

  enqueuePendingMessage(conversationId: string, content: string): void {
    this.pending.push({
      id: this.nextPendingId++,
      conversationId,
      content,
      createdAt: this.now(),
      injectedAt: null,
    });
  }

  drainPendingMessages(conversationId: string): Message[] {
    const out: Message[] = [];
    for (const row of this.pending) {
      if (row.conversationId !== conversationId || row.injectedAt !== null)
        continue;
      const id = this.storeMessage(conversationId, "user", row.content);
      row.injectedAt = this.now();
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
  }

  // --- delivery claims ---

  claimDelivery(messageId: number, blockIndex: number): boolean {
    const key = `${messageId}:${blockIndex}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  countUndeliveredBlocks(messageId: number): number {
    const row = this.msgs.find((m) => m.id === messageId);
    if (!row || row.role !== "assistant") return 0;
    const conv = this.convs.find((c) => c.id === row.conversationId);
    if ((conv?.deliveredThroughMessageId ?? 0) >= messageId) return 0;
    const claimed: number[] = [];
    for (const key of this.claimed) {
      const [id, index] = key.split(":");
      if (Number(id) === messageId) claimed.push(Number(index));
    }
    return unclaimedBlockIndexes(decodeContent(row.content), claimed).length;
  }

  markDeliveredThrough(conversationId: string, messageId: number): void {
    const conv = this.convs.find((c) => c.id === conversationId);
    if (conv) conv.deliveredThroughMessageId = messageId;
  }

  // --- learning jobs ---

  beginLearningJob(jobId: string): number {
    const existing = this.jobs.get(jobId);
    if (existing) return existing.highWaterMessageId;
    const highWaterMessageId = this.msgs[this.msgs.length - 1]?.id ?? 0;
    this.jobs.set(jobId, { highWaterMessageId, completed: false });
    return highWaterMessageId;
  }

  listUnconsolidatedMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): LearningMessage[] {
    const after = input.afterId ?? 0;
    return this.msgs
      .filter(
        (m) =>
          m.id > after &&
          m.id <= input.throughMessageId &&
          m.consolidatedAt === null,
      )
      .slice(0, input.limit)
      .map((m) => ({ ...toMessage(m), conversationId: m.conversationId }));
  }

  completeLearningJob(jobId: string, throughMessageId?: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.completed) return;
    const at = this.now();
    const through = Math.min(
      job.highWaterMessageId,
      throughMessageId ?? job.highWaterMessageId,
    );
    for (const m of this.msgs) {
      if (m.id <= through) m.consolidatedAt = at;
    }
    this.jobs.set(jobId, { ...job, completed: true });
  }

  // --- external calls ---

  beginExternalCall(toolUseId: string, tool: string): ExternalCallClaim {
    const existing = this.external.get(toolUseId);
    if (existing) {
      return existing.status === "completed"
        ? { status: "completed", result: existing.result ?? "" }
        : { status: "in_flight" };
    }
    this.external.set(toolUseId, { tool, status: "started", result: null });
    return { status: "claimed" };
  }

  completeExternalCall(toolUseId: string, result: string): void {
    const existing = this.external.get(toolUseId);
    this.external.set(toolUseId, {
      tool: existing?.tool ?? "",
      status: "completed",
      result,
    });
  }

  findConversationsWithWork(): Thread[] {
    const out: Thread[] = [];
    for (const c of this.convs) {
      const convMsgs = this.msgs.filter((m) => m.conversationId === c.id);
      const tail = convMsgs[convMsgs.length - 1];
      const pendingCount = this.pending.filter(
        (p) => p.conversationId === c.id && p.injectedAt === null,
      ).length;
      const hasWork = conversationHasWork({
        pendingCount,
        tail: tail ? { kind: tail.kind, stopReason: tail.stopReason } : undefined,
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
    const file = { ...input, createdAt: this.now() };
    this.files.set(file.id, file);
    return { ...file };
  }

  getFile(id: string): StoredFileRecord | null {
    const file = this.files.get(id);
    return file ? { ...file } : null;
  }

  listFiles(): StoredFileRecord[] {
    return [...this.files.values()].map((file) => ({ ...file }));
  }

  updateFileSize(id: string, byteSize: number): void {
    const file = this.files.get(id);
    if (file) this.files.set(id, { ...file, byteSize });
  }

  deleteFile(id: string): void {
    this.files.delete(id);
  }

  deleteAllFiles(): void {
    this.files.clear();
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
    const record: ScheduleRecord = {
      ...input,
      status: "active",
      createdAt: this.now(),
      lastFiredAt: null,
    };
    this.schedules.push(record);
    return { ...record };
  }

  listSchedules(conversationId?: string): ScheduleRecord[] {
    return this.schedules
      .filter(
        (s) =>
          s.status === "active" &&
          (conversationId === undefined || s.conversationId === conversationId),
      )
      .map((s) => ({ ...s }))
      .sort((a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity));
  }

  getSchedule(id: string): ScheduleRecord | null {
    const record = this.schedules.find((s) => s.id === id);
    return record ? { ...record } : null;
  }

  cancelSchedule(id: string): boolean {
    const record = this.schedules.find((s) => s.id === id);
    if (!record || record.status !== "active") return false;
    record.status = "cancelled";
    record.nextDueAt = null;
    return true;
  }

  listDueSchedules(now: number): ScheduleRecord[] {
    return this.listSchedules().filter(
      (s) => s.nextDueAt !== null && s.nextDueAt <= now,
    );
  }

  advanceSchedule(
    id: string,
    input: { nextDueAt: number; lastFiredAt: string },
  ): void {
    const record = this.schedules.find((s) => s.id === id);
    if (!record) return;
    record.nextDueAt = input.nextDueAt;
    record.lastFiredAt = input.lastFiredAt;
  }

  retireSchedule(id: string, input: { lastFiredAt: string }): void {
    const record = this.schedules.find((s) => s.id === id);
    if (!record) return;
    record.status = "done";
    record.nextDueAt = null;
    record.lastFiredAt = input.lastFiredAt;
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
    const existing = this.mailThreads.find((t) => t.threadId === input.threadId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.status = "active";
      return { ...existing };
    }
    const record: MailThreadRecord = {
      threadId: input.threadId,
      conversationId: input.conversationId,
      status: "active",
      createdAt: this.now(),
      lastNotifiedAt: null,
    };
    this.mailThreads.push(record);
    return { ...record };
  }

  untrackMailThread(threadId: string): boolean {
    const record = this.mailThreads.find((t) => t.threadId === threadId);
    if (!record || record.status !== "active") return false;
    record.status = "stopped";
    return true;
  }

  listMailThreads(conversationId?: string): MailThreadRecord[] {
    return this.mailThreads
      .filter(
        (t) =>
          t.status === "active" &&
          (conversationId === undefined || t.conversationId === conversationId),
      )
      .map((t) => ({ ...t }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markMailThreadsNotified(threadIds: string[], notifiedAt: string): void {
    for (const record of this.mailThreads) {
      if (threadIds.includes(record.threadId)) record.lastNotifiedAt = notifiedAt;
    }
  }

  // --- settings ---

  // Update the given columns on the settings row, seeding it with defaults if
  // absent. Returns the persisted row so getSettings reports the stored
  // createdAt (byte-aligned with DbStore's re-read-after-write).
  private upsertSettings(
    columns: Partial<{
      onboardingSeen: number;
      googleOnboardingStatus: string;
      timezone: string;
      country: string;
      firstContactAt: string;
      mailHistoryId: string;
      lastActiveAt: string;
    }>,
  ): SettingsRow {
    if (this.settingsRow) {
      if (columns.onboardingSeen !== undefined) {
        this.settingsRow.onboardingSeen = columns.onboardingSeen;
      }
      if (columns.googleOnboardingStatus !== undefined) {
        this.settingsRow.googleOnboardingStatus = columns.googleOnboardingStatus;
      }
      if (columns.timezone !== undefined) {
        this.settingsRow.timezone = columns.timezone;
      }
      if (columns.country !== undefined) {
        this.settingsRow.country = columns.country;
      }
      if (columns.firstContactAt !== undefined) {
        this.settingsRow.firstContactAt = columns.firstContactAt;
      }
      if (columns.mailHistoryId !== undefined) {
        this.settingsRow.mailHistoryId = columns.mailHistoryId;
      }
      if (columns.lastActiveAt !== undefined) {
        this.settingsRow.lastActiveAt = columns.lastActiveAt;
      }
      return this.settingsRow;
    }
    this.settingsRow = {
      onboardingSeen: columns.onboardingSeen ?? 0,
      googleOnboardingStatus: columns.googleOnboardingStatus ?? null,
      createdAt: this.now(),
      timezone: columns.timezone ?? null,
      country: columns.country ?? null,
      firstContactAt: columns.firstContactAt ?? null,
      mailHistoryId: columns.mailHistoryId ?? null,
      lastActiveAt: columns.lastActiveAt ?? null,
    };
    return this.settingsRow;
  }

  getSettings(): UserSettings {
    if (!this.settingsRow) {
      const seeded = this.upsertSettings({});
      return {
        onboardingSeen: !!seeded.onboardingSeen,
        googleOnboardingStatus: seeded.googleOnboardingStatus ?? null,
        createdAt: seeded.createdAt ?? null,
        timezone: seeded.timezone ?? null,
        country: seeded.country ?? null,
        mailHistoryId: seeded.mailHistoryId ?? null,
        lastActiveAt: seeded.lastActiveAt ?? null,
        isNewUser: true,
      };
    }
    return {
      onboardingSeen: !!this.settingsRow.onboardingSeen,
      googleOnboardingStatus: this.settingsRow.googleOnboardingStatus ?? null,
      createdAt: this.settingsRow.createdAt ?? null,
      timezone: this.settingsRow.timezone ?? null,
      country: this.settingsRow.country ?? null,
      mailHistoryId: this.settingsRow.mailHistoryId ?? null,
      lastActiveAt: this.settingsRow.lastActiveAt ?? null,
      isNewUser: false,
    };
  }

  updateSettings(patch: {
    onboardingSeen?: boolean;
    timezone?: string;
    country?: string;
    mailHistoryId?: string;
    lastActiveAt?: string;
  }): void {
    const columns: Partial<{
      onboardingSeen: number;
      timezone: string;
      country: string;
      mailHistoryId: string;
      lastActiveAt: string;
    }> = {};
    if (patch.onboardingSeen !== undefined) {
      columns.onboardingSeen = patch.onboardingSeen ? 1 : 0;
    }
    if (patch.timezone !== undefined) columns.timezone = patch.timezone;
    if (patch.country !== undefined) columns.country = patch.country;
    if (patch.mailHistoryId !== undefined) columns.mailHistoryId = patch.mailHistoryId;
    if (patch.lastActiveAt !== undefined) columns.lastActiveAt = patch.lastActiveAt;
    this.upsertSettings(columns);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.upsertSettings({ googleOnboardingStatus: status });
  }

  claimFirstContact(): boolean {
    if (this.settingsRow?.firstContactAt) return false;
    this.upsertSettings({ firstContactAt: this.now() });
    return true;
  }

  // --- telegram link ---

  getTelegramId(): string | null {
    return this.telegramId;
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    const previous = this.telegramId;
    this.telegramId = telegramId;
    return { previous };
  }

  unlinkTelegram(): { removed: string | null } {
    const removed = this.telegramId;
    this.telegramId = null;
    return { removed };
  }

  // --- webhook idempotency ---

  markProcessed(updateId: string): boolean {
    if (this.processed.has(updateId)) return false;
    this.processed.add(updateId);
    return true;
  }
}

// Re-exported for tests importing a ConversationStore-only view.
export type { ConversationStore };
