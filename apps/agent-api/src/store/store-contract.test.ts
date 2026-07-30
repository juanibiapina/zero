// Contract tests for the Store port. Run against MemoryStore here; the same
// suite can be pointed at DbStore under a Workers test pool later. Because the
// agents and orchestrator are tested on MemoryStore, this suite is what makes
// those tests trustworthy.

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
import { messageText } from "./messages";
import type { ContentBlock } from "../agents/protocol";
import type { Store } from "./types";
import { pinTopic, removeTopic, renameTopic, seedTopic, setBody, setDescription } from "./test-support";

const makeStore = (): Store => new MemoryStore(() => "2026-01-01T00:00:00.000Z");

describe("Store contract: topics", () => {
  it("createTopic then getTopic returns the topic", () => {
    const s = makeStore();
    seedTopic(s, "weather", "climate notes");
    expect(s.getTopic("weather")).toMatchObject({
      name: "weather",
      description: "climate notes",
      body: "",
      messageCount: 0,
    });
  });

  it("getTopic returns null for unknown topic", () => {
    expect(makeStore().getTopic("nope")).toBeNull();
  });

  it("real adapter topics are never system", () => {
    const s = makeStore();
    seedTopic(s, "weather", "");
    expect(s.getTopic("weather")?.system).toBe(false);
    expect(s.listTopics()[0]?.system).toBe(false);
  });

  it("deleteTopic removes the topic", () => {
    const s = makeStore();
    seedTopic(s, "gone", "");
    removeTopic(s, "gone");
    expect(s.getTopic("gone")).toBeNull();
  });

  it("deleteTopic throws for unknown topic", () => {
    expect(() => removeTopic(makeStore(), "nope")).toThrow();
  });

  it("deleteTopic leaves inbound links dangling and bodies untouched", () => {
    const s = makeStore();
    seedTopic(s, "trip", "");
    seedTopic(s, "flights", "");
    setBody(s, "trip", "book [[flights]]");
    removeTopic(s, "flights");
    // The source body keeps its [[flights]] token.
    expect(s.getTopic("trip")?.body).toBe("book [[flights]]");
    // The link is still an outbound row from trip (now dangling).
    expect(s.getOutboundLinks("trip")).toEqual(["flights"]);
    // Recreating the target re-resolves the dangling link.
    seedTopic(s, "flights", "");
    expect(s.getBacklinks("flights").map((t) => t.name)).toEqual(["trip"]);
  });

  it("deleteTopic drops the topic's own outbound links", () => {
    const s = makeStore();
    seedTopic(s, "trip", "");
    seedTopic(s, "flights", "");
    setBody(s, "trip", "book [[flights]]");
    removeTopic(s, "trip");
    expect(s.getBacklinks("flights")).toEqual([]);
  });

  it("listTopics returns metadata without requiring bodies", () => {
    const s = makeStore();
    seedTopic(s, "a", "first");
    seedTopic(s, "b", "second");
    const names = s.listTopics().map((t) => t.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("updateTopicBody sets the body", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    setBody(s, "a", "hello");
    expect(s.getTopic("a")?.body).toBe("hello");
  });

  it("getTopicsWithBodies returns bodies for known names, skips unknown", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    setBody(s, "a", "body-a");
    const got = s.getTopicsWithBodies(["a", "missing"]);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe("body-a");
  });

  it("updateTopicBody replaces the body and bumps messageCount", () => {
    const s = makeStore();
    seedTopic(s, "a", "old");
    setBody(s, "a", "B");
    expect(s.getTopic("a")).toMatchObject({
      body: "B",
      description: "old",
      messageCount: 1,
    });
  });

  it("updateTopicMetadata changes the description without touching the body", () => {
    const s = makeStore();
    seedTopic(s, "a", "old", "kept");
    setDescription(s, "a", "new");
    expect(s.getTopic("a")).toMatchObject({ body: "kept", description: "new" });
  });

  it("updateTopicMetadata renames when newName is given", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    renameTopic(s, "a", "b");
    expect(s.getTopic("a")).toBeNull();
    expect(s.getTopic("b")).not.toBeNull();
  });

  it("updateTopicMetadata rejects rename onto an existing name", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    seedTopic(s, "b", "");
    expect(() => renameTopic(s, "a", "b")).toThrow();
  });

  it("createTopic rejects an existing name", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    expect(() => seedTopic(s, "a", "")).toThrow(/exists/);
  });

  it("createTopic derives links from the body it was created with", () => {
    const s = makeStore();
    seedTopic(s, "a", "", "see [[b]]");
    expect(s.getOutboundLinks("a")).toEqual(["b"]);
  });
});

describe("Store contract: pinned topics", () => {
  it("topics start unpinned", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    expect(s.getTopic("a")?.pinned).toBe(false);
    expect(s.getPinnedTopics()).toEqual([]);
  });

  it("setPinned pins a topic and getPinnedTopics returns its full body", () => {
    const s = makeStore();
    seedTopic(s, "User", "identity");
    setBody(s, "User", "name: Alice");
    pinTopic(s, "User", true);
    expect(s.getTopic("User")?.pinned).toBe(true);
    const pinned = s.getPinnedTopics();
    expect(pinned.map((t) => t.name)).toEqual(["User"]);
    expect(pinned[0].body).toBe("name: Alice");
  });

  it("setPinned false unpins", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    pinTopic(s, "a", true);
    pinTopic(s, "a", false);
    expect(s.getPinnedTopics()).toEqual([]);
  });

  it("listTopics reports the pinned flag", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    seedTopic(s, "b", "");
    pinTopic(s, "a", true);
    const byName = Object.fromEntries(
      s.listTopics().map((t) => [t.name, t.pinned]),
    );
    expect(byName).toEqual({ a: true, b: false });
  });

  it("pinned survives a rename", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    pinTopic(s, "a", true);
    renameTopic(s, "a", "b");
    expect(s.getPinnedTopics().map((t) => t.name)).toEqual(["b"]);
  });
});

describe("Store contract: topic links", () => {
  const save = (s: Store, name: string, body: string) => setBody(s, name, body);

  it("derives outbound links from the body", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    save(s, "a", "see [[b]] and [[c]]");
    expect(s.getOutboundLinks("a").sort()).toEqual(["b", "c"]);
  });

  it("re-derives outbound links when the body changes", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    save(s, "a", "[[b]] [[c]]");
    save(s, "a", "only [[b]] now");
    expect(s.getOutboundLinks("a")).toEqual(["b"]);
  });

  it("tracks backlinks even when the target does not exist yet", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    save(s, "a", "points at [[b]]");
    // b does not exist: the link is dangling but still a backlink of b.
    expect(s.getBacklinks("b").map((t) => t.name)).toEqual(["a"]);
    seedTopic(s, "b", "");
    expect(s.getBacklinks("b").map((t) => t.name)).toEqual(["a"]);
  });

  it("rename rewrites `[[old]]` tokens in other bodies and keeps backlinks", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
    seedTopic(s, "japan", "");
    save(s, "a", "trip: [[japan]] near [[japan bar]]");
    renameTopic(s, "japan", "japan 2026");
    expect(s.getTopic("a")?.body).toBe("trip: [[japan 2026]] near [[japan bar]]");
    expect(s.getBacklinks("japan 2026").map((t) => t.name)).toEqual(["a"]);
    expect(s.getBacklinks("japan")).toEqual([]);
  });

  it("drops link rows when a link is removed from the body", () => {
    const s = makeStore();
    seedTopic(s, "a", "");
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
    expect(
      s.getConversationHistory(id, 10).map((m) => messageText(m.content)),
    ).toEqual(["m1", "m2", "m3"]);
    expect(
      s.getConversationHistory(id, 2).map((m) => messageText(m.content)),
    ).toEqual(["m2", "m3"]);
    expect(s.getConversationHistory(id, 10)[0]).toMatchObject({
      role: "user",
      kind: "user_message",
      stopReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns the whole log and no summary before any compaction", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "m1");
    s.storeMessage(id, "assistant", "m2");
    const context = s.getConversationContext(id, 10);
    expect(context.summary).toBeNull();
    expect(context.messages.map((m) => messageText(m.content))).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("renders summary plus the messages after the compaction boundary", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "m1");
    const boundary = s.storeMessage(id, "assistant", "m2");
    s.storeMessage(id, "user", "m3");
    s.compactConversation(id, {
      throughMessageId: boundary,
      summary: "they talked about m1 and m2",
    });
    const context = s.getConversationContext(id, 10);
    expect(context.summary).toBe("they talked about m1 and m2");
    expect(context.messages.map((m) => messageText(m.content))).toEqual(["m3"]);
  });

  it("keeps every compacted message in raw storage", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const boundary = s.storeMessage(id, "user", "m1");
    s.storeMessage(id, "assistant", "m2");
    s.compactConversation(id, { throughMessageId: boundary, summary: "s" });
    expect(
      s.getConversationHistory(id, 10).map((m) => messageText(m.content)),
    ).toEqual(["m1", "m2"]);
  });

  it("bounds the context by limit, newest last", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "m1");
    s.storeMessage(id, "assistant", "m2");
    s.storeMessage(id, "user", "m3");
    expect(
      s.getConversationContext(id, 2).messages.map((m) => messageText(m.content)),
    ).toEqual(["m2", "m3"]);
  });

  it("pages the compaction window forward from the boundary", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const ids = [
      s.storeMessage(id, "user", "m1"),
      s.storeMessage(id, "assistant", "m2"),
      s.storeMessage(id, "user", "m3"),
      s.storeMessage(id, "assistant", "m4"),
    ];

    // The oldest rows, not the newest: a boundary set from this window can only
    // skip rows the window contained.
    const first = s.getCompactionWindow(id, 2);
    expect(first.messages.map((m) => m.id)).toEqual([ids[0], ids[1]]);
    expect(first.hasMore).toBe(true);

    s.compactConversation(id, { throughMessageId: ids[1], summary: "so far" });
    const second = s.getCompactionWindow(id, 2);
    expect(second.messages.map((m) => m.id)).toEqual([ids[2], ids[3]]);
    expect(second.summary).toBe("so far");
    expect(second.hasMore).toBe(false);
  });

  it("drops a leading tool result whose call fell outside the window", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "assistant", "calling", { stopReason: "tool_use" });
    s.storeMessage(
      id,
      "user",
      [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      { kind: "tool_result" },
    );
    s.storeMessage(id, "user", "hi");

    // Truncating to the newest 2 rows would open the context on the result.
    expect(
      s.getConversationContext(id, 2).messages.map((m) => m.kind),
    ).toEqual(["user_message"]);
  });

  it("stores a plain string as a single text block", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "hi");
    expect(s.getConversationHistory(id, 10)[0].content).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("round-trips mixed text and tool_use blocks byte-identically", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const content: ContentBlock[] = [
      { type: "text", text: "let me look" },
      { type: "tool_use", id: "tu_1", name: "get_topic", input: { name: "a" } },
    ];
    s.storeMessage(id, "assistant", content, { stopReason: "tool_use" });
    const [row] = s.getConversationHistory(id, 10);
    expect(row.content).toEqual(content);
    expect(row).toMatchObject({
      kind: "assistant_message",
      stopReason: "tool_use",
    });
  });

  it("records tool results as user-role rows of kind tool_result", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(
      id,
      "user",
      [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      { kind: "tool_result" },
    );
    expect(s.getConversationHistory(id, 10)[0]).toMatchObject({
      role: "user",
      kind: "tool_result",
    });
  });

  it("storeMessage returns the row id, and ids are distinct", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const first = s.storeMessage(id, "user", "m1");
    const second = s.storeMessage(id, "assistant", "m2");
    expect(second).not.toBe(first);
    expect(s.getConversationHistory(id, 10).map((m) => m.id)).toEqual([
      first,
      second,
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

});

describe("Store contract: conversations with work", () => {
  const withWork = (s: Store) => s.findConversationsWithWork().map((t) => t.id);

  it("a user message at the tail needs a model response", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    const b = s.getOrCreateConversation(2, 0);
    s.storeMessage(a, "user", "hi");
    s.storeMessage(b, "user", "hi");
    s.claimDelivery(s.storeMessage(b, "assistant", "hello"), 0);
    expect(withWork(s)).toEqual([a]);
  });

  it("a tool result at the tail needs a model response", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "assistant", "thinking", { stopReason: "tool_use" });
    s.storeMessage(
      a,
      "user",
      [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      { kind: "tool_result" },
    );
    expect(withWork(s)).toEqual([a]);
  });

  it("an assistant response that stopped for tool_use is unfinished", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "assistant", "calling a tool", { stopReason: "tool_use" });
    expect(withWork(s)).toEqual([a]);
  });

  it("an assistant response with no recorded stop reason is unfinished", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "assistant", "half a reply", { stopReason: null });
    expect(withWork(s)).toEqual([a]);
  });

  it("a terminal assistant response with an empty queue is idle", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "user", "hi");
    s.claimDelivery(s.storeMessage(a, "assistant", "hello"), 0);
    expect(withWork(s)).toEqual([]);
  });

  it("a terminal assistant response nobody delivered is still work", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "user", "hi");
    s.storeMessage(a, "assistant", "hello");
    expect(withWork(s)).toEqual([a]);
  });

  it("a partly delivered terminal response is work for its remaining block", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "user", "hi");
    const id = s.storeMessage(a, "assistant", [
      { type: "text", text: "one moment" },
      { type: "text", text: "here it is" },
    ]);
    s.claimDelivery(id, 0);
    expect(withWork(s)).toEqual([a]);
    s.claimDelivery(id, 1);
    expect(withWork(s)).toEqual([]);
  });

  it("a response with no text to send is idle without any claim", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "user", "hi");
    s.storeMessage(a, "assistant", [
      { type: "tool_use", id: "tu_1", name: "get_topic", input: {} },
    ]);
    expect(withWork(s)).toEqual([]);
  });

  it("a queued message is work even when the transcript is finished", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    s.storeMessage(a, "user", "hi");
    s.claimDelivery(s.storeMessage(a, "assistant", "hello"), 0);
    s.enqueuePendingMessage(a, "one more thing");
    expect(withWork(s)).toEqual([a]);
  });

  it("an empty conversation has no work", () => {
    const s = makeStore();
    s.getOrCreateConversation(1, 0);
    expect(withWork(s)).toEqual([]);
  });
});

describe("Store contract: pending message queue", () => {
  it("a queued message stays out of the transcript until drained", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.enqueuePendingMessage(id, "hi");
    expect(s.getConversationHistory(id, 10)).toEqual([]);
    s.drainPendingMessages(id);
    expect(
      s.getConversationHistory(id, 10).map((m) => messageText(m.content)),
    ).toEqual(["hi"]);
  });

  it("drains a burst into the transcript in arrival order", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.enqueuePendingMessage(id, "one");
    s.enqueuePendingMessage(id, "two");
    s.enqueuePendingMessage(id, "three");
    expect(s.drainPendingMessages(id).map((m) => messageText(m.content))).toEqual(
      ["one", "two", "three"],
    );
    expect(
      s.getConversationHistory(id, 10).map((m) => messageText(m.content)),
    ).toEqual(["one", "two", "three"]);
  });

  it("a second drain injects nothing (no duplicates)", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.enqueuePendingMessage(id, "hi");
    s.drainPendingMessages(id);
    expect(s.drainPendingMessages(id)).toEqual([]);
    expect(s.getConversationHistory(id, 10)).toHaveLength(1);
  });

  it("drains only the requested conversation", () => {
    const s = makeStore();
    const a = s.getOrCreateConversation(1, 0);
    const b = s.getOrCreateConversation(2, 0);
    s.enqueuePendingMessage(a, "for a");
    s.enqueuePendingMessage(b, "for b");
    s.drainPendingMessages(a);
    expect(s.getConversationHistory(b, 10)).toEqual([]);
    expect(s.findConversationsWithWork().map((t) => t.id)).toEqual([a, b]);
  });

  it("resetConversation discards queued messages", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.enqueuePendingMessage(id, "hi");
    s.resetConversation(1, 0);
    const fresh = s.getOrCreateConversation(1, 0);
    expect(s.drainPendingMessages(fresh)).toEqual([]);
  });
});

describe("Store contract: delivery claims", () => {
  it("claims a block once and refuses the second claim", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const messageId = s.storeMessage(id, "assistant", "hello");
    expect(s.claimDelivery(messageId, 0)).toBe(true);
    expect(s.claimDelivery(messageId, 0)).toBe(false);
  });

  it("claims each block of a message independently", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const messageId = s.storeMessage(id, "assistant", [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(s.claimDelivery(messageId, 0)).toBe(true);
    expect(s.claimDelivery(messageId, 1)).toBe(true);
    expect(s.claimDelivery(messageId, 1)).toBe(false);
  });
});

describe("Store contract: learning jobs", () => {
  it("freezes the high-water mark at job start and keeps it on re-attach", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "one");
    const second = s.storeMessage(id, "assistant", "two");

    expect(s.beginLearningJob("job_1")).toBe(second);
    // Messages that arrive after the job started belong to the next job.
    s.storeMessage(id, "user", "three");
    expect(s.beginLearningJob("job_1")).toBe(second);
  });

  it("pages unconsolidated messages in order up to the mark", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const ids = [
      s.storeMessage(id, "user", "one"),
      s.storeMessage(id, "assistant", "two"),
      s.storeMessage(id, "user", "three"),
    ];
    const high = s.beginLearningJob("job_1");
    s.storeMessage(id, "user", "after the mark");

    const first = s.listUnconsolidatedMessages({
      throughMessageId: high,
      limit: 2,
    });
    expect(first.map((m) => m.id)).toEqual([ids[0], ids[1]]);
    expect(first[0].conversationId).toBe(id);

    const next = s.listUnconsolidatedMessages({
      throughMessageId: high,
      afterId: first[first.length - 1].id,
      limit: 2,
    });
    expect(next.map((m) => m.id)).toEqual([ids[2]]);
  });

  it("completion stamps only the covered range and repeats as a no-op", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    s.storeMessage(id, "user", "one");
    s.storeMessage(id, "assistant", "two");
    const high = s.beginLearningJob("job_1");
    const later = s.storeMessage(id, "user", "three");

    s.completeLearningJob("job_1");
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: high, limit: 10 }),
    ).toEqual([]);
    // The message above the mark is still waiting for the next job.
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: later, limit: 10 }).map((m) => m.id),
    ).toEqual([later]);

    // Repeated completion (a lost acknowledgement) changes nothing.
    s.completeLearningJob("job_1");
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: later, limit: 10 }).map((m) => m.id),
    ).toEqual([later]);
  });

  it("stamps only what the job was shown when its input was cut short", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const ids = [
      s.storeMessage(id, "user", "one"),
      s.storeMessage(id, "assistant", "two"),
      s.storeMessage(id, "user", "three"),
    ];
    const high = s.beginLearningJob("job_1");
    expect(high).toBe(ids[2]);

    // The job only read the first two rows.
    s.completeLearningJob("job_1", ids[1]);
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: high, limit: 10 }).map((m) => m.id),
    ).toEqual([ids[2]]);
  });

  it("never stamps past the job's frozen mark", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const first = s.storeMessage(id, "user", "one");
    const high = s.beginLearningJob("job_1");
    expect(high).toBe(first);
    const later = s.storeMessage(id, "user", "two");

    s.completeLearningJob("job_1", later);
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: later, limit: 10 }).map((m) => m.id),
    ).toEqual([later]);
  });

  it("completing an unknown job does nothing", () => {
    const s = makeStore();
    const id = s.getOrCreateConversation(1, 0);
    const only = s.storeMessage(id, "user", "one");
    s.completeLearningJob("never_started");
    expect(
      s.listUnconsolidatedMessages({ throughMessageId: only, limit: 10 }).map((m) => m.id),
    ).toEqual([only]);
  });
});

describe("Store contract: external call claims", () => {
  it("claims a call once, then reports it in flight until it completes", () => {
    const s = makeStore();
    expect(s.beginExternalCall("call_1", "gmail_send")).toEqual({
      status: "claimed",
    });
    // A replay before the outcome is recorded: the request may or may not have
    // left, so the only honest answer is "unknown".
    expect(s.beginExternalCall("call_1", "gmail_send")).toEqual({
      status: "in_flight",
    });
    s.completeExternalCall("call_1", '{"id":"m1"}');
    expect(s.beginExternalCall("call_1", "gmail_send")).toEqual({
      status: "completed",
      result: '{"id":"m1"}',
    });
  });

  it("keeps calls independent by tool_use id", () => {
    const s = makeStore();
    s.beginExternalCall("call_1", "gmail_send");
    expect(s.beginExternalCall("call_2", "calendar_create_event")).toEqual({
      status: "claimed",
    });
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

describe("Store contract: settings", () => {
  it("getSettings seeds the row and reports isNewUser true with defaults", () => {
    const s = makeStore();
    const settings = s.getSettings();
    expect(settings).toEqual({
      onboardingSeen: false,
      googleOnboardingStatus: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: null,
      isNewUser: true,
    });
  });

  it("getSettings on a seeded row reports isNewUser false and same createdAt", () => {
    const s = makeStore();
    const first = s.getSettings();
    const second = s.getSettings();
    expect(second.isNewUser).toBe(false);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("updateSettings sets and resets onboardingSeen", () => {
    const s = makeStore();
    s.updateSettings({ onboardingSeen: true });
    expect(s.getSettings().onboardingSeen).toBe(true);
    s.updateSettings({ onboardingSeen: false });
    expect(s.getSettings().onboardingSeen).toBe(false);
  });

  it("updateSettings with an empty patch is a no-op", () => {
    const s = makeStore();
    s.updateSettings({ onboardingSeen: true });
    s.updateSettings({});
    expect(s.getSettings().onboardingSeen).toBe(true);
  });

  it("updateSettings sets timezone", () => {
    const s = makeStore();
    s.updateSettings({ timezone: "Europe/Berlin" });
    expect(s.getSettings().timezone).toBe("Europe/Berlin");
  });

  it("updateSettings on a missing row inserts (upsert), then updates in place", () => {
    // First writer runs before any getSettings seed: exercises the insert
    // branch. A later writer exercises the update branch on the same row.
    const s = makeStore();
    s.updateSettings({ timezone: "Europe/Berlin" });
    expect(s.getSettings()).toMatchObject({
      timezone: "Europe/Berlin",
      onboardingSeen: false,
      isNewUser: false,
    });
    s.updateSettings({ onboardingSeen: true });
    expect(s.getSettings()).toMatchObject({
      timezone: "Europe/Berlin",
      onboardingSeen: true,
    });
  });

  it("setGoogleOnboardingStatus transitions visible via getSettings", () => {
    const s = makeStore();
    s.setGoogleOnboardingStatus("queued");
    expect(s.getSettings().googleOnboardingStatus).toBe("queued");
    s.setGoogleOnboardingStatus("running");
    expect(s.getSettings().googleOnboardingStatus).toBe("running");
    s.setGoogleOnboardingStatus("done");
    expect(s.getSettings().googleOnboardingStatus).toBe("done");
  });

  it("setGoogleOnboardingStatus inserts the row when missing", () => {
    // Runs as the very first settings access: exercises the insert branch.
    const s = makeStore();
    s.setGoogleOnboardingStatus("queued");
    const settings = s.getSettings();
    expect(settings.googleOnboardingStatus).toBe("queued");
    expect(settings.onboardingSeen).toBe(false);
  });
});

describe("Store contract: telegram link", () => {
  it("getTelegramId returns null when nothing is linked", () => {
    expect(makeStore().getTelegramId()).toBeNull();
  });

  it("linkTelegram stores the id and returns no previous", () => {
    const s = makeStore();
    expect(s.linkTelegram("12345")).toEqual({ previous: null });
    expect(s.getTelegramId()).toBe("12345");
  });

  it("linkTelegram returns the previous id when re-linking", () => {
    const s = makeStore();
    s.linkTelegram("111");
    expect(s.linkTelegram("222")).toEqual({ previous: "111" });
    expect(s.getTelegramId()).toBe("222");
  });

  it("unlinkTelegram clears the id and returns the removed value", () => {
    const s = makeStore();
    s.linkTelegram("12345");
    expect(s.unlinkTelegram()).toEqual({ removed: "12345" });
    expect(s.getTelegramId()).toBeNull();
  });

  it("unlinkTelegram returns removed null when nothing is linked", () => {
    expect(makeStore().unlinkTelegram()).toEqual({ removed: null });
  });
});

describe("Store contract: webhook idempotency", () => {
  it("markProcessed returns true the first time and false on a duplicate", () => {
    const s = makeStore();
    expect(s.markProcessed("u1")).toBe(true);
    expect(s.markProcessed("u1")).toBe(false);
  });

  it("markProcessed tracks distinct update ids independently", () => {
    const s = makeStore();
    expect(s.markProcessed("u1")).toBe(true);
    expect(s.markProcessed("u2")).toBe(true);
    expect(s.markProcessed("u2")).toBe(false);
  });
});
