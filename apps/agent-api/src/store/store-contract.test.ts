// Contract tests for the Store port. Run against MemoryStore here; the same
// suite can be pointed at DbStore under a Workers test pool later. Because the
// agents and orchestrator are tested on MemoryStore, this suite is what makes
// those tests trustworthy.

import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory";
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
