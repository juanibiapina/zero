// Storage ports for the meta-agent system. The agents and the turn
// orchestrator depend only on these interfaces, never on do-orm or the DO.
// Two adapters implement them: `DbStore` (do-orm over DO SQLite, prod) and
// `MemoryStore` (in-memory, tests). See store/store-contract.test.ts.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  // ISO-8601 creation time; used to render each message's relative age.
  createdAt: string;
}

// Topic listing metadata (no body).
export interface TopicMeta {
  name: string;
  description: string;
  summary: string;
  lastActiveAt: string;
  messageCount: number;
  // Pinned topics are always surfaced in the interface agent's prompt.
  pinned: boolean;
  // System topics are read-only reference documents bundled with the Worker
  // (see store/system-topics.ts). They live in no user's SQLite; the
  // SystemTopicStore decorator overlays them onto reads and rejects writes.
  // Real DB adapters always return false; only the decorator sets it true.
  system: boolean;
}

// Full topic including the knowledge document body.
export interface Topic extends TopicMeta {
  body: string;
  createdAt: string;
}

// A conversation thread awaiting processing.
export interface Thread {
  id: string;
  chatId: number;
  topicId: number;
}

export interface TopicStore {
  listTopics(): TopicMeta[];
  getTopic(name: string): Topic | null;
  createTopic(name: string, description: string): void;
  // Delete a topic. Its own outbound link rows go; inbound links from other
  // bodies become dangling (their [[Name]] tokens are left untouched). Throws
  // if the topic does not exist.
  deleteTopic(name: string): void;
  updateTopicBody(name: string, body: string): void;
  getTopicsWithBodies(names: string[]): Topic[];
  // Pin or unpin a topic. Pinned topics are always rendered into the interface
  // agent's prompt. Pinning survives a saveTopic rename.
  setPinned(name: string, pinned: boolean): void;
  // Full bodies of every pinned topic, for prompt surfacing.
  getPinnedTopics(): Topic[];
  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void;
  // Target names this topic links to via `[[Name]]` (distinct, includes
  // dangling links whose target does not exist yet).
  getOutboundLinks(name: string): string[];
  // Topics whose body links to `name` (its back-references).
  getBacklinks(name: string): TopicMeta[];
}

export interface ConversationStore {
  getOrCreateConversation(chatId: number, topicId: number): string;
  storeMessage(conversationId: string, role: Role, content: string): void;
  getConversationHistory(conversationId: string, limit: number): Message[];
  resetConversation(chatId: number, topicId: number): void;
  markBusy(conversationId: string): void;
  clearBusy(conversationId: string): void;
  findThreadsAwaitingReply(): Thread[];
}

export type Store = TopicStore & ConversationStore;
