// do-orm Store adapter over DO SQLite. Runs inside UserDO; the agents and the
// turn orchestrator address it through the Store interface. Column names match
// the do-orm schema keys (camelCase).

import { and, desc, eq, type Database } from "do-orm";
import {
  conversations,
  messages,
  topics,
} from "../UserDO/db/schema";
import type {
  Message,
  Role,
  Store,
  Thread,
  Topic,
  TopicMeta,
} from "./types";

export class DbStore implements Store {
  constructor(private db: Database) {}

  private nowIso(): string {
    return new Date().toISOString();
  }

  // --- topics ---

  listTopics(): TopicMeta[] {
    return this.db
      .all(topics, { orderBy: desc("lastActiveAt") })
      .map((t) => ({
        name: t.name,
        description: t.description,
        summary: t.summary,
        lastActiveAt: t.lastActiveAt,
        messageCount: t.messageCount,
      }));
  }

  getTopic(name: string): Topic | null {
    const t = this.db.get(topics, { where: eq("name", name) });
    return t ? toTopic(t) : null;
  }

  createTopic(name: string, description: string): void {
    const now = this.nowIso();
    this.db.insert(topics, {
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
    this.db.update(
      topics,
      { body, lastActiveAt: this.nowIso() },
      { where: eq("name", name) },
    );
  }

  getTopicsWithBodies(names: string[]): Topic[] {
    const out: Topic[] = [];
    for (const name of names) {
      const t = this.db.get(topics, { where: eq("name", name) });
      if (t) out.push(toTopic(t));
    }
    return out;
  }

  saveTopic(
    name: string,
    patch: { body: string; description: string; summary: string },
    newName?: string,
  ): void {
    const existing = this.db.get(topics, { where: eq("name", name) });
    if (!existing) throw new Error(`topic not found: ${name}`);
    const rename = newName && newName !== name;
    if (rename) {
      const clash = this.db.get(topics, { where: eq("name", newName) });
      if (clash) throw new Error(`topic exists: ${newName}`);
    }
    this.db.update(
      topics,
      {
        body: patch.body,
        description: patch.description,
        summary: patch.summary,
        lastActiveAt: this.nowIso(),
        messageCount: existing.messageCount + 1,
        ...(rename ? { name: newName } : {}),
      },
      { where: eq("id", existing.id) },
    );
  }

  // --- conversations ---

  getOrCreateConversation(chatId: number, topicId: number): string {
    const existing = this.db.get(conversations, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.insert(conversations, {
      id,
      chatId,
      topicId,
      createdAt: this.nowIso(),
    });
    return id;
  }

  storeMessage(conversationId: string, role: Role, content: string): void {
    this.db.insert(messages, {
      conversationId,
      role,
      content,
      createdAt: this.nowIso(),
    });
  }

  getConversationHistory(conversationId: string, limit: number): Message[] {
    const rows = this.db.all(messages, {
      where: eq("conversationId", conversationId),
      orderBy: desc("id"),
      limit,
    });
    return rows
      .reverse()
      .map((m) => ({ role: m.role as Role, content: m.content }));
  }

  resetConversation(chatId: number, topicId: number): void {
    const conv = this.db.get(conversations, {
      where: and(eq("chatId", chatId), eq("topicId", topicId)),
    });
    if (!conv) return;
    this.db.delete(messages, { where: eq("conversationId", conv.id) });
    this.db.delete(conversations, { where: eq("id", conv.id) });
  }

  markBusy(conversationId: string): void {
    this.db.update(
      conversations,
      { busySince: this.nowIso() },
      { where: eq("id", conversationId) },
    );
  }

  clearBusy(conversationId: string): void {
    this.db.update(
      conversations,
      { busySince: null },
      { where: eq("id", conversationId) },
    );
  }

  findThreadsAwaitingReply(): Thread[] {
    const out: Thread[] = [];
    for (const c of this.db.all(conversations)) {
      const tail = this.db.get(messages, {
        where: eq("conversationId", c.id),
        orderBy: desc("id"),
      });
      if (tail && tail.role === "user") {
        out.push({ id: c.id, chatId: c.chatId, topicId: c.topicId });
      }
    }
    return out;
  }
}

function toTopic(t: {
  name: string;
  description: string;
  summary: string;
  body: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}): Topic {
  return {
    name: t.name,
    description: t.description,
    summary: t.summary,
    body: t.body,
    createdAt: t.createdAt,
    lastActiveAt: t.lastActiveAt,
    messageCount: t.messageCount,
  };
}
