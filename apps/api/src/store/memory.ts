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
import { extractLinks, rewriteLinks } from "./links";

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
  // One entry per (source topic name -> target name) link. Kept in sync with
  // topic bodies by syncOutboundLinks on every write.
  private links: { source: string; target: string }[] = [];
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
          summary: t.summary,
          lastActiveAt: t.lastActiveAt,
          messageCount: t.messageCount,
          pinned: t.pinned,
          system: false,
        });
      }
    }
    return out;
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
      pinned: false,
      system: false,
    });
  }

  deleteTopic(name: string): void {
    if (!this.topics.has(name)) throw new Error(`topic not found: ${name}`);
    this.topics.delete(name);
    // Drop this topic's own outbound rows. Inbound rows (other bodies linking
    // to `name`) stay: their [[Name]] tokens remain in those bodies, so the
    // links become dangling, consistent with a not-yet-created target.
    this.links = this.links.filter((l) => l.source !== name);
  }

  setPinned(name: string, pinned: boolean): void {
    const t = this.topics.get(name);
    if (!t) throw new Error(`topic not found: ${name}`);
    t.pinned = pinned;
  }

  getPinnedTopics(): Topic[] {
    return [...this.topics.values()]
      .filter((t) => t.pinned)
      .map((t) => ({ ...t }));
  }

  updateTopicBody(name: string, body: string): void {
    const t = this.topics.get(name);
    if (!t) throw new Error(`topic not found: ${name}`);
    t.body = body;
    t.lastActiveAt = this.now();
    this.syncOutboundLinks(name, body);
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
    const rename = Boolean(newName && newName !== name);
    if (rename && newName) {
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
    this.syncOutboundLinks(rename && newName ? newName : name, patch.body);
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
