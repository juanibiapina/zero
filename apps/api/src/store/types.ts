// Storage ports for the meta-agent system. The agents and the turn
// orchestrator depend only on these interfaces, never on do-orm or the DO.
// Two adapters implement them: `DbStore` (do-orm over DO SQLite, prod) and
// `MemoryStore` (in-memory, tests). See store/store-contract.test.ts.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

// Topic listing metadata (no body).
export interface TopicMeta {
  name: string;
  description: string;
  summary: string;
  lastActiveAt: string;
  messageCount: number;
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
  updateTopicBody(name: string, body: string): void;
  getTopicsWithBodies(names: string[]): Topic[];
  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void;
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
