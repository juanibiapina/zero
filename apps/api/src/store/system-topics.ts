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

Zero is a personal assistant you talk to over Telegram. It remembers what
matters to you as a set of living topic documents and uses them to help across
your messages, mail, calendar, and research.

## How Zero communicates

- Replies as it works: a short acknowledgement first, then the answer, so you
  see progress instead of waiting in silence.
- Keeps messages concise and conversational.
- Records durable facts as it learns them, so you rarely repeat yourself.
- Researches on its own initiative when a subject is worth checking, and cites
  sources.
- Never sends mail or creates a calendar event without showing you the exact
  content first and getting your confirmation.

## What Zero can do

- Remember people, projects, trips, events, gear, goals, and other recurring
  subjects, and connect them.
- Read and send your Gmail, and read and write your Google Calendar.
- Research topics on the web and keep the findings, with sources.

Ask Zero what is new to hear about its latest features (see the Changelog topic).`;

// The bundled system topics. Order is the list_topics/pinned render order.
export const SYSTEM_TOPICS: SystemTopicDef[] = [
  {
    name: "Zero",
    description:
      "Zero itself: what it is, how it communicates, and what it can do. The assistant's own identity.",
    summary: "Zero's identity, communication style, and capabilities.",
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
