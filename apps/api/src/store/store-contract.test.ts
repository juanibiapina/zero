// Contract tests for the Store port. Run against MemoryStore here; the same
// suite can be pointed at DbStore under a Workers test pool later. Because the
// agents and orchestrator are tested on MemoryStore, this suite is what makes
// those tests trustworthy.

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import type { Store } from "./types";

const makeStore = (): Store => new MemoryStore(() => "2026-01-01T00:00:00.000Z");

describe("Store contract: topics", () => {
  it("createTopic then getTopic returns the topic", () => {
    const s = makeStore();
    s.createTopic("weather", "climate notes");
    expect(s.getTopic("weather")).toMatchObject({
      name: "weather",
      description: "climate notes",
      summary: "",
      body: "",
      messageCount: 0,
    });
  });

  it("getTopic returns null for unknown topic", () => {
    expect(makeStore().getTopic("nope")).toBeNull();
  });

  it("listTopics returns metadata without requiring bodies", () => {
    const s = makeStore();
    s.createTopic("a", "first");
    s.createTopic("b", "second");
    const names = s.listTopics().map((t) => t.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("updateTopicBody sets the body", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.updateTopicBody("a", "hello");
    expect(s.getTopic("a")?.body).toBe("hello");
  });

  it("getTopicsWithBodies returns bodies for known names, skips unknown", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.updateTopicBody("a", "body-a");
    const got = s.getTopicsWithBodies(["a", "missing"]);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe("body-a");
  });

  it("saveTopic updates body/description/summary and bumps messageCount", () => {
    const s = makeStore();
    s.createTopic("a", "old");
    s.saveTopic("a", { body: "B", description: "new", summary: "S" });
    expect(s.getTopic("a")).toMatchObject({
      body: "B",
      description: "new",
      summary: "S",
      messageCount: 1,
    });
  });

  it("saveTopic renames when newName is given", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.saveTopic("a", { body: "", description: "", summary: "" }, "b");
    expect(s.getTopic("a")).toBeNull();
    expect(s.getTopic("b")).not.toBeNull();
  });

  it("saveTopic rejects rename onto an existing name", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.createTopic("b", "");
    expect(() =>
      s.saveTopic("a", { body: "", description: "", summary: "" }, "b"),
    ).toThrow();
  });
});

describe("Store contract: conversations", () => {
  it("getOrCreateConversation is stable per (chatId, topicId)", () => {
    const s = makeStore();
    const id1 = s.getOrCreateConversation(1, 0);
    const id2 = s.getOrCreateConversation(1, 0);
    expect(id1).toBe(id2);
    const id3 = s.getOrCreateConversation(1, 5);
    expect(id3).not.toBe(id1);
  });

  it("stores and returns history in order, bounded by limit", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "m1");
    s.storeMessage(id, "assistant", "m2");
    s.storeMessage(id, "user", "m3");
    expect(s.getConversationHistory(id, 10)).toEqual([
      { role: "user", content: "m1" },
      { role: "assistant", content: "m2" },
      { role: "user", content: "m3" },
    ]);
    expect(s.getConversationHistory(id, 2)).toEqual([
      { role: "assistant", content: "m2" },
      { role: "user", content: "m3" },
    ]);
  });

  it("resetConversation drops the thread and its messages", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "m1");
    s.resetConversation(1, 0);
    const newId = s.getOrCreateConversation(1, 0);
    expect(newId).not.toBe(id);
    expect(s.getConversationHistory(newId, 10)).toEqual([]);
  });

  it("findThreadsAwaitingReply returns threads whose tail is a user message", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    const b = s.getOrCreateConversation(2, 0);
    s.storeMessage(a, "user", "hi");
    s.storeMessage(b, "user", "hi");
    s.storeMessage(b, "assistant", "hello");
    const waiting = s.findThreadsAwaitingReply().map((t) => t.id);
    expect(waiting).toEqual([a]);
  });

  it("markBusy / clearBusy do not throw and leave history intact", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "hi");
    s.markBusy(id);
    s.clearBusy(id);
    expect(s.getConversationHistory(id, 10)).toHaveLength(1);
  });
});
