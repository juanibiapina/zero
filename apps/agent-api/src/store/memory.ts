// In-memory Store adapter. Used by unit tests to exercise the agents and the
// turn orchestrator without a Durable Object. Mirrors DbStore semantics; the
// shared contract test (store-contract.test.ts) runs against both.

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
  ConversationStore,
  ExternalCallClaim,
  LearningMessage,
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
import { extractLinks, rewriteLinks } from "./links";

// The persisted settings row, mirroring DbStore's user_settings columns.
interface SettingsRow {
  onboardingSeen: number;
  googleOnboardingStatus: string | null;
  createdAt: string;
  timezone: string | null;
}

interface ConvRow {
  id: string;
  chatId: number;
  topicId: number;
  compactedThroughMessageId: number | null;
  summary: string | null;
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
  private attachments = new Map<string, Attachment>();
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
      messages: this.msgs
        .filter(
          (m) =>
            m.conversationId === conversationId &&
            (boundary === null || m.id > boundary),
        )
        .slice(-limit)
        .map(toMessage),
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
    for (const [id, a] of this.attachments) {
      if (a.conversationId === conv.id) this.attachments.delete(id);
    }
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

  completeLearningJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.completed) return;
    const at = this.now();
    for (const m of this.msgs) {
      if (m.id <= job.highWaterMessageId) m.consolidatedAt = at;
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
    this.attachments.set(a.id, { ...a, createdAt: this.now() });
  }

  getAttachment(id: string): Attachment | null {
    const a = this.attachments.get(id);
    return a ? { ...a } : null;
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
      return this.settingsRow;
    }
    this.settingsRow = {
      onboardingSeen: columns.onboardingSeen ?? 0,
      googleOnboardingStatus: columns.googleOnboardingStatus ?? null,
      createdAt: this.now(),
      timezone: columns.timezone ?? null,
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
        isNewUser: true,
      };
    }
    return {
      onboardingSeen: !!this.settingsRow.onboardingSeen,
      googleOnboardingStatus: this.settingsRow.googleOnboardingStatus ?? null,
      createdAt: this.settingsRow.createdAt ?? null,
      timezone: this.settingsRow.timezone ?? null,
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
