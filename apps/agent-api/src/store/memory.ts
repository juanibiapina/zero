// In-memory Store adapter. Used by unit tests to exercise the agents and the
// turn orchestrator without a Durable Object. Mirrors DbStore semantics; the
// shared contract test (store-contract.test.ts) runs against both.

import { KnowledgeConflictError } from "./types";
import type {
  Attachment,
  ConversationStore,
  Message,
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
}

interface MsgRow {
  id: number;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export class MemoryStore implements Store {
  private topics = new Map<string, Topic>();
  // One entry per (source topic name -> target name) link. Kept in sync with
  // topic bodies by syncOutboundLinks on every write.
  private links: { source: string; target: string }[] = [];
  private convs: ConvRow[] = [];
  private msgs: MsgRow[] = [];
  private attachments = new Map<string, Attachment>();
  private settingsRow: SettingsRow | null = null;
  private telegramId: string | null = null;
  private processed = new Set<string>();
  private nextMsgId = 1;
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
    this.convs.push({ id, chatId, topicId });
    return id;
  }

  storeMessage(conversationId: string, role: Role, content: string): void {
    this.msgs.push({
      id: this.nextMsgId++,
      conversationId,
      role,
      content,
      createdAt: this.now(),
    });
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    return this.msgs
      .filter((m) => m.conversationId === conversationId)
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }));
  }

  resetConversation(chatId: number, topicId: number): void {
    const conv = this.convs.find(
      (c) => c.chatId === chatId && c.topicId === topicId,
    );
    if (!conv) return;
    this.msgs = this.msgs.filter((m) => m.conversationId !== conv.id);
    for (const [id, a] of this.attachments) {
      if (a.conversationId === conv.id) this.attachments.delete(id);
    }
    this.convs = this.convs.filter((c) => c.id !== conv.id);
  }

  findThreadsAwaitingReply(): Thread[] {
    const out: Thread[] = [];
    for (const c of this.convs) {
      const convMsgs = this.msgs.filter((m) => m.conversationId === c.id);
      const tail = convMsgs[convMsgs.length - 1];
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
