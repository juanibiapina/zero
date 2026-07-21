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

  it("real adapter topics are never system", () => {
    const s = makeStore();
    s.createTopic("weather", "");
    expect(s.getTopic("weather")?.system).toBe(false);
    expect(s.listTopics()[0]?.system).toBe(false);
  });

  it("deleteTopic removes the topic", () => {
    const s = makeStore();
    s.createTopic("gone", "");
    s.deleteTopic("gone");
    expect(s.getTopic("gone")).toBeNull();
  });

  it("deleteTopic throws for unknown topic", () => {
    expect(() => makeStore().deleteTopic("nope")).toThrow();
  });

  it("deleteTopic leaves inbound links dangling and bodies untouched", () => {
    const s = makeStore();
    s.createTopic("trip", "");
    s.createTopic("flights", "");
    s.saveTopic("trip", { body: "book [[flights]]", description: "", summary: "" });
    s.deleteTopic("flights");
    // The source body keeps its [[flights]] token.
    expect(s.getTopic("trip")?.body).toBe("book [[flights]]");
    // The link is still an outbound row from trip (now dangling).
    expect(s.getOutboundLinks("trip")).toEqual(["flights"]);
    // Recreating the target re-resolves the dangling link.
    s.createTopic("flights", "");
    expect(s.getBacklinks("flights").map((t) => t.name)).toEqual(["trip"]);
  });

  it("deleteTopic drops the topic's own outbound links", () => {
    const s = makeStore();
    s.createTopic("trip", "");
    s.createTopic("flights", "");
    s.saveTopic("trip", { body: "book [[flights]]", description: "", summary: "" });
    s.deleteTopic("trip");
    expect(s.getBacklinks("flights")).toEqual([]);
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

describe("Store contract: pinned topics", () => {
  it("topics start unpinned", () => {
    const s = makeStore();
    s.createTopic("a", "");
    expect(s.getTopic("a")?.pinned).toBe(false);
    expect(s.getPinnedTopics()).toEqual([]);
  });

  it("setPinned pins a topic and getPinnedTopics returns its full body", () => {
    const s = makeStore();
    s.createTopic("User", "identity");
    s.updateTopicBody("User", "name: Alice");
    s.setPinned("User", true);
    expect(s.getTopic("User")?.pinned).toBe(true);
    const pinned = s.getPinnedTopics();
    expect(pinned.map((t) => t.name)).toEqual(["User"]);
    expect(pinned[0].body).toBe("name: Alice");
  });

  it("setPinned false unpins", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.setPinned("a", true);
    s.setPinned("a", false);
    expect(s.getPinnedTopics()).toEqual([]);
  });

  it("listTopics reports the pinned flag", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.createTopic("b", "");
    s.setPinned("a", true);
    const byName = Object.fromEntries(
      s.listTopics().map((t) => [t.name, t.pinned]),
    );
    expect(byName).toEqual({ a: true, b: false });
  });

  it("pinned survives a saveTopic rename", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.setPinned("a", true);
    s.saveTopic("a", { body: "x", description: "", summary: "" }, "b");
    expect(s.getPinnedTopics().map((t) => t.name)).toEqual(["b"]);
  });
});

describe("Store contract: topic links", () => {
  const save = (s: Store, name: string, body: string) =>
    s.saveTopic(name, { body, description: "", summary: "" });

  it("derives outbound links from the body", () => {
    const s = makeStore();
    s.createTopic("a", "");
    save(s, "a", "see [[b]] and [[c]]");
    expect(s.getOutboundLinks("a").sort()).toEqual(["b", "c"]);
  });

  it("re-derives outbound links when the body changes", () => {
    const s = makeStore();
    s.createTopic("a", "");
    save(s, "a", "[[b]] [[c]]");
    save(s, "a", "only [[b]] now");
    expect(s.getOutboundLinks("a")).toEqual(["b"]);
  });

  it("tracks backlinks even when the target does not exist yet", () => {
    const s = makeStore();
    s.createTopic("a", "");
    save(s, "a", "points at [[b]]");
    // b does not exist: the link is dangling but still a backlink of b.
    expect(s.getBacklinks("b").map((t) => t.name)).toEqual(["a"]);
    s.createTopic("b", "");
    expect(s.getBacklinks("b").map((t) => t.name)).toEqual(["a"]);
  });

  it("rename rewrites `[[old]]` tokens in other bodies and keeps backlinks", () => {
    const s = makeStore();
    s.createTopic("a", "");
    s.createTopic("japan", "");
    save(s, "a", "trip: [[japan]] near [[japan bar]]");
    s.saveTopic("japan", { body: "", description: "", summary: "" }, "japan 2026");
    expect(s.getTopic("a")?.body).toBe("trip: [[japan 2026]] near [[japan bar]]");
    expect(s.getBacklinks("japan 2026").map((t) => t.name)).toEqual(["a"]);
    expect(s.getBacklinks("japan")).toEqual([]);
  });

  it("drops link rows when a link is removed from the body", () => {
    const s = makeStore();
    s.createTopic("a", "");
    save(s, "a", "[[b]]");
    save(s, "a", "no more links");
    expect(s.getOutboundLinks("a")).toEqual([]);
    expect(s.getBacklinks("b")).toEqual([]);
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
    const ts = "2026-01-01T00:00:00.000Z";
    expect(s.getConversationHistory(id, 10)).toEqual([
      { role: "user", content: "m1", createdAt: ts },
      { role: "assistant", content: "m2", createdAt: ts },
      { role: "user", content: "m3", createdAt: ts },
    ]);
    expect(s.getConversationHistory(id, 2)).toEqual([
      { role: "assistant", content: "m2", createdAt: ts },
      { role: "user", content: "m3", createdAt: ts },
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

  it("resetConversation drops attachments in the thread (FK-safe)", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.putAttachment({
      id: "att_reset",
      conversationId: id,
      r2Key: "attachments/user_1/xyz",
      filename: "cat.jpg",
      mimeType: "image/jpeg",
    });
    // Must not throw a FOREIGN KEY constraint error when the thread has attachments.
    s.resetConversation(1, 0);
    expect(s.getAttachment("att_reset")).toBeNull();
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

describe("Store contract: attachments", () => {
  it("putAttachment then getAttachment round-trips the row", () => {
    const s = makeStore();
    const conv = s.getOrCreateConversation(1, 0);
    s.putAttachment({
      id: "att_1",
      conversationId: conv,
      r2Key: "attachments/user_1/abc",
      filename: "cat.jpg",
      mimeType: "image/jpeg",
    });
    expect(s.getAttachment("att_1")).toEqual({
      id: "att_1",
      conversationId: conv,
      r2Key: "attachments/user_1/abc",
      filename: "cat.jpg",
      mimeType: "image/jpeg",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("getAttachment returns null for an unknown id", () => {
    expect(makeStore().getAttachment("nope")).toBeNull();
  });
});
