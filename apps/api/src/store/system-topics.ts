// System topics: read-only reference documents bundled with the Worker, the
// same for every user and versioned with the code. They live in no user's
// SQLite. The SystemTopicStore decorator overlays them onto every read and
// rejects any write to them, so read-only is enforced structurally at the store
// boundary (not by a prompt or a soft tool check).
//
// Updating a system topic is a source edit + deploy: change the Zero body below
// or the repo CHANGELOG.md and every user sees the new content immediately, with
// no migration and no per-user seeding.

import changelogMarkdown from "../../../../CHANGELOG.md";
import { extractLinks } from "./links";
import type {
  ConversationStore,
  Message,
  Role,
  Store,
  Thread,
  Topic,
  TopicMeta,
} from "./types";

// A bundled system topic. `pinned` topics are always rendered into the
// interface agent's prompt (Zero, the assistant's own identity); unpinned ones
// are discoverable via list_topics and read on demand (Changelog).
export interface SystemTopicDef {
  name: string;
  description: string;
  summary: string;
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
    summary: "Zero's identity.",
    body: ZERO_BODY,
    pinned: true,
  },
  {
    name: "Changelog",
    description: "Zero's changelog and newly shipped features.",
    summary: "Recent user-facing changes and new features in Zero.",
    body: changelogMarkdown,
    pinned: false,
  },
];

const SYSTEM_BY_NAME = new Map(SYSTEM_TOPICS.map((t) => [t.name, t]));

// Fixed timestamps for the virtual rows: system topics have no per-user history.
const SYSTEM_TIME = "1970-01-01T00:00:00.000Z";

const toTopic = (def: SystemTopicDef): Topic => ({
  name: def.name,
  description: def.description,
  summary: def.summary,
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

  createTopic(name: string, description: string): void {
    if (this.isSystem(name)) readOnly(name);
    this.inner.createTopic(name, description);
  }

  deleteTopic(name: string): void {
    if (this.isSystem(name)) readOnly(name);
    this.inner.deleteTopic(name);
  }

  updateTopicBody(name: string, body: string): void {
    if (this.isSystem(name)) readOnly(name);
    this.inner.updateTopicBody(name, body);
  }

  setPinned(name: string, pinned: boolean): void {
    if (this.isSystem(name)) readOnly(name);
    this.inner.setPinned(name, pinned);
  }

  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void {
    if (this.isSystem(name)) readOnly(name);
    if (newName && this.isSystem(newName)) readOnly(newName);
    this.inner.saveTopic(name, patch, newName);
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

  markBusy(conversationId: string): void {
    this.inner.markBusy(conversationId);
  }

  clearBusy(conversationId: string): void {
    this.inner.clearBusy(conversationId);
  }

  findThreadsAwaitingReply(): Thread[] {
    return this.inner.findThreadsAwaitingReply();
  }
}

// Re-exported for tests that only need a ConversationStore view.
export type { ConversationStore };
