// System topics: read-only reference documents bundled with the Worker, the
// same for every user and versioned with the code. They live in no user's
// SQLite. The SystemTopicStore decorator overlays them onto every read and
// rejects any write to them, so read-only is enforced structurally at the store
// boundary (not by a prompt or a soft tool check).
//
// Updating a system topic is a source edit + deploy: change the Zero body below
// or apps/agent-api/CHANGELOG.md and every user sees the new content
// immediately, with no migration and no per-user seeding.

import changelogMarkdown from "../../CHANGELOG.md";
import { extractLinks } from "./links";
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

// A bundled system topic. `pinned` topics are always rendered into the
// interface agent's prompt (Zero, the assistant's own identity); unpinned ones
// are discoverable via list_topics and read on demand (Changelog).
export interface SystemTopicDef {
  name: string;
  description: string;
  body: string;
  pinned: boolean;
}

const ZERO_BODY = `# Zero

This topic is about you. The notes below are instructions to you, the
assistant, describing your own identity. Read them as established facts about
yourself and stay in character.

You are Zero, a personal assistant. You talk to the user over Telegram and
remember what matters to them across conversations.

See [[Changelog]] for your recent user-facing changes and newly shipped
features.`;

// The bundled system topics. Order is the list_topics/pinned render order.
export const SYSTEM_TOPICS: SystemTopicDef[] = [
  {
    name: "Zero",
    description: "Your own identity: who you, the assistant, are.",
    body: ZERO_BODY,
    pinned: true,
  },
  {
    name: "Changelog",
    description: "Zero's changelog and newly shipped features.",
    body: changelogMarkdown,
    pinned: false,
  },
];

const SYSTEM_BY_NAME = new Map(SYSTEM_TOPICS.map((t) => [t.name, t]));

// Fingerprint of the bundled system-topic content. Derived from the text itself
// (never a hand-maintained constant, which drifts), so a Worker build that
// changes a body or description changes this string and the next UserDO
// initialization bumps the user's knowledge version once — making persisted
// reads of Zero/Changelog stale after a deploy.
export const systemTopicsFingerprint = (): string => {
  const material = JSON.stringify(
    SYSTEM_TOPICS.map((t) => [t.name, t.description, t.body, t.pinned]),
  );
  // FNV-1a, 32-bit. Not cryptographic: it only has to change when the text does.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${material.length.toString(36)}.${hash.toString(36)}`;
};

// Fixed timestamps for the virtual rows: system topics have no per-user history.
const SYSTEM_TIME = "1970-01-01T00:00:00.000Z";

const toTopic = (def: SystemTopicDef): Topic => ({
  name: def.name,
  description: def.description,
  body: def.body,
  createdAt: SYSTEM_TIME,
  lastActiveAt: SYSTEM_TIME,
  messageCount: 0,
  pinned: def.pinned,
  system: true,
});

const toMeta = (def: SystemTopicDef): TopicMeta => {
  const { body: _body, createdAt: _createdAt, ...meta } = toTopic(def);
  return meta;
};

const readOnly = (name: string): never => {
  throw new Error(`topic is read-only: ${name}`);
};

// Decorates a Store, overlaying the bundled system topics onto reads and
// rejecting writes to them. Conversation methods and all user-topic operations
// delegate to the wrapped store unchanged.
export class SystemTopicStore implements Store {
  constructor(private inner: Store) {}

  private isSystem(name: string): boolean {
    return SYSTEM_BY_NAME.has(name);
  }

  // --- topic reads (overlay system topics) ---

  listTopics(): TopicMeta[] {
    return [...this.inner.listTopics(), ...SYSTEM_TOPICS.map(toMeta)];
  }

  getTopic(name: string): Topic | null {
    const def = SYSTEM_BY_NAME.get(name);
    if (def) return toTopic(def);
    return this.inner.getTopic(name);
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    return names
      .map((name) => {
        const def = SYSTEM_BY_NAME.get(name);
        if (def) return toTopic(def);
        return this.inner.getTopicsWithBodies([name])[0] ?? null;
      })
      .filter((t): t is Topic => t !== null);
  }

  getPinnedTopics(): Topic[] {
    return [
      ...this.inner.getPinnedTopics(),
      ...SYSTEM_TOPICS.filter((t) => t.pinned).map(toTopic),
    ];
  }

  getOutboundLinks(name: string): string[] {
    const def = SYSTEM_BY_NAME.get(name);
    if (def) return extractLinks(def.body);
    return this.inner.getOutboundLinks(name);
  }

  // Backlinks are computed from other bodies' [[Name]] rows, which live in the
  // wrapped store, so a user topic linking [[Zero]] resolves without change.
  getBacklinks(name: string): TopicMeta[] {
    return this.inner.getBacklinks(name);
  }

  // --- topic writes (reject system topics, else delegate) ---

  createTopic(input: {
    expectedVersion: number;
    name: string;
    description: string;
    body: string;
  }): number {
    if (this.isSystem(input.name)) readOnly(input.name);
    return this.inner.createTopic(input);
  }

  deleteTopic(input: { expectedVersion: number; name: string }): number {
    if (this.isSystem(input.name)) readOnly(input.name);
    return this.inner.deleteTopic(input);
  }

  updateTopicBody(input: {
    expectedVersion: number;
    name: string;
    body: string;
  }): number {
    if (this.isSystem(input.name)) readOnly(input.name);
    return this.inner.updateTopicBody(input);
  }

  setPinned(input: {
    expectedVersion: number;
    name: string;
    pinned: boolean;
  }): number {
    if (this.isSystem(input.name)) readOnly(input.name);
    return this.inner.setPinned(input);
  }

  updateTopicMetadata(input: {
    expectedVersion: number;
    name: string;
    description?: string;
    newName?: string;
  }): number {
    if (this.isSystem(input.name)) readOnly(input.name);
    if (input.newName && this.isSystem(input.newName)) readOnly(input.newName);
    return this.inner.updateTopicMetadata(input);
  }

  // --- knowledge version (delegate verbatim) ---

  getKnowledgeVersion(): number {
    return this.inner.getKnowledgeVersion();
  }

  syncSystemTopicsFingerprint(fingerprint: string): number {
    return this.inner.syncSystemTopicsFingerprint(fingerprint);
  }

  // --- conversations (delegate verbatim) ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    return this.inner.getOrCreateConversation(chatId, topicId);
  }

  storeMessage(conversationId: string, role: Role, content: string): void {
    this.inner.storeMessage(conversationId, role, content);
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    return this.inner.getConversationHistory(conversationId, limit);
  }

  resetConversation(chatId: number, topicId: number): void {
    this.inner.resetConversation(chatId, topicId);
  }

  findThreadsAwaitingReply(): Thread[] {
    return this.inner.findThreadsAwaitingReply();
  }

  // --- attachments (delegate verbatim) ---

  putAttachment(attachment: {
    id: string;
    conversationId: string;
    r2Key: string;
    filename: string;
    mimeType: string;
  }): void {
    this.inner.putAttachment(attachment);
  }

  getAttachment(id: string): Attachment | null {
    return this.inner.getAttachment(id);
  }

  // --- settings / link / idempotency (delegate verbatim) ---

  getSettings(): UserSettings {
    return this.inner.getSettings();
  }

  updateSettings(patch: { onboardingSeen?: boolean; timezone?: string }): void {
    this.inner.updateSettings(patch);
  }

  setGoogleOnboardingStatus(status: string): void {
    this.inner.setGoogleOnboardingStatus(status);
  }

  getTelegramId(): string | null {
    return this.inner.getTelegramId();
  }

  linkTelegram(telegramId: string): { previous: string | null } {
    return this.inner.linkTelegram(telegramId);
  }

  unlinkTelegram(): { removed: string | null } {
    return this.inner.unlinkTelegram();
  }

  markProcessed(updateId: string): boolean {
    return this.inner.markProcessed(updateId);
  }
}

// Re-exported for tests that only need a ConversationStore view.
export type { ConversationStore };
