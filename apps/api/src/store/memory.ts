// In-memory Store adapter. Used by unit tests to exercise the agents and the
// turn orchestrator without a Durable Object. Mirrors DbStore semantics; the
// shared contract test (store-contract.test.ts) runs against both.

import type {
  ConversationStore,
  Message,
  Role,
  Store,
  Thread,
  Topic,
  TopicMeta,
} from "./types";

interface ConvRow {
  id: string;
  chatId: number;
  topicId: number;
  busySince: string | null;
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
  private convs: ConvRow[] = [];
  private msgs: MsgRow[] = [];
  private nextMsgId = 1;
  private now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  // --- topics ---

  listTopics(): TopicMeta[] {
    return [...this.topics.values()].map((t) => ({
      name: t.name,
      description: t.description,
      summary: t.summary,
      lastActiveAt: t.lastActiveAt,
      messageCount: t.messageCount,
    }));
  }

  getTopic(name: string): Topic | null {
    const t = this.topics.get(name);
    return t ? { ...t } : null;
  }

  createTopic(name: string, description: string): void {
    if (this.topics.has(name)) throw new Error(`topic exists: ${name}`);
    const now = this.now();
    this.topics.set(name, {
      name,
      description,
      summary: "",
      body: "",
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    });
  }

  updateTopicBody(name: string, body: string): void {
    const t = this.topics.get(name);
    if (!t) throw new Error(`topic not found: ${name}`);
    t.body = body;
    t.lastActiveAt = this.now();
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    const out: Topic[] = [];
    for (const name of names) {
      const t = this.topics.get(name);
      if (t) out.push({ ...t });
    }
    return out;
  }

  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void {
    const t = this.topics.get(name);
    if (!t) throw new Error(`topic not found: ${name}`);
    if (newName && newName !== name && this.topics.has(newName)) {
      throw new Error(`topic exists: ${newName}`);
    }
    t.body = patch.body;
    t.description = patch.description;
    t.summary = patch.summary;
    t.lastActiveAt = this.now();
    t.messageCount += 1;
    if (newName && newName !== name) {
      this.topics.delete(name);
      t.name = newName;
      this.topics.set(newName, t);
    }
  }

  // --- conversations ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    const existing = this.convs.find(
      (c) => c.chatId === chatId && c.topicId === topicId,
    );
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.convs.push({ id, chatId, topicId, busySince: null });
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
    this.convs = this.convs.filter((c) => c.id !== conv.id);
  }

  markBusy(conversationId: string): void {
    const c = this.convs.find((x) => x.id === conversationId);
    if (c) c.busySince = this.now();
  }

  clearBusy(conversationId: string): void {
    const c = this.convs.find((x) => x.id === conversationId);
    if (c) c.busySince = null;
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
}

// Re-exported for tests importing a ConversationStore-only view.
export type { ConversationStore };
