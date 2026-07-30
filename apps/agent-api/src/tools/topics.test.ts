import { describe, it, expect } from "vitest";
import { buildTopicTools, buildInterfaceTools } from "./topics";
import { MemoryStore } from "../store/memory";
import { SystemTopicStore } from "../store/system-topics";
import type { TopicStore } from "../store/types";
import { seedTopic, setBody } from "../store/test-support";

const makeInterfaceTools = (store: TopicStore) =>
  buildInterfaceTools({
    store,
    send: async () => {},
    persistReply: () => {},
    accessed: new Set<string>(),
    replies: [],
  });

const call = <T = unknown>(
  tool: { execute: (a: never) => Promise<unknown> },
  input: unknown,
): Promise<T> => tool.execute(input as never) as Promise<T>;

// Write tools take the version the caller last read. Tests that are not about
// conflicts pass the current one.
const write = <T = unknown>(
  store: TopicStore,
  tool: { execute: (a: never) => Promise<unknown> },
  input: Record<string, unknown>,
): Promise<T> =>
  call<T>(tool, { expectedVersion: store.getKnowledgeVersion(), ...input });

describe("list_topics", () => {
  it("returns only the routing fields, never a body or extra metadata", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "an upcoming trip");
    setBody(store, "trip", "long body text");
    const tools = buildTopicTools({ store });
    const listed = await call<{
      version: number;
      topics: Array<Record<string, unknown>>;
    }>(tools.list_topics, {});
    expect(listed).toEqual({
      version: store.getKnowledgeVersion(),
      topics: [{ name: "trip", description: "an upcoming trip" }],
    });
  });

  it("counts get_topic calls for the caller", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "");
    const reads = { count: 0 };
    const tools = buildTopicTools({ store, reads });
    await call(tools.get_topic, { name: "trip" });
    await call(tools.get_topic, { name: "missing" });
    expect(reads.count).toBe(1);
  });
});

describe("topic link tools", () => {
  it("get_topic returns outboundLinks and backlinks", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "");
    seedTopic(store, "flights", "");
    setBody(store, "trip", "book [[flights]]");
    const tools = buildTopicTools({ store });
    const trip = await call<{
      version: number;
      topic: { outboundLinks: string[]; backlinks: string[] };
    }>(tools.get_topic, { name: "trip" });
    expect(trip.version).toBe(store.getKnowledgeVersion());
    expect(trip.topic.outboundLinks).toEqual(["flights"]);
    const flights = await call<{ topic: { backlinks: string[] } }>(
      tools.get_topic,
      { name: "flights" },
    );
    expect(flights.topic.backlinks).toEqual(["trip"]);
  });

  it("list_backlinks returns linking topics and records access", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "");
    setBody(store, "trip", "[[flights]]");
    const accessed = new Set<string>();
    const tools = buildTopicTools({ store, accessed });
    const rows = await call<{ topics: { name: string }[] }>(
      tools.list_backlinks,
      { name: "flights" },
    );
    expect(rows.topics.map((t) => t.name)).toEqual(["trip"]);
    expect(accessed.has("flights")).toBe(true);
  });

  it("list_backlinks returns empty for a topic nothing links to", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "lonely", "");
    const tools = buildTopicTools({ store });
    const rows = await call<{ topics: unknown[] }>(tools.list_backlinks, {
      name: "lonely",
    });
    expect(rows.topics).toEqual([]);
  });
});

describe("delete_topic tool", () => {
  it("deletes an existing topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "stale", "");
    const tools = makeInterfaceTools(store);
    const res = await write<{ deleted: string; version: number }>(
      store,
      tools.delete_topic,
      { name: "stale" },
    );
    expect(res.deleted).toBe("stale");
    expect(store.getTopic("stale")).toBeNull();
  });

  it("returns an error for an unknown topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = makeInterfaceTools(store);
    const res = await write<{ error: string }>(store, tools.delete_topic, {
      name: "nope",
    });
    expect(res.error).toContain("topic not found");
  });

  it("returns a read-only error for a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = makeInterfaceTools(store);
    const res = await write<{ error: string }>(store, tools.delete_topic, {
      name: "Zero",
    });
    expect(res.error).toContain("read-only");
  });
});

describe("update_topic_metadata tool", () => {
  it("changes the description without touching the body", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "old", "## Plans\nFly to Rome.");
    const tools = buildTopicTools({ store });
    const res = await write<{ updated: string; version: number }>(
      store,
      tools.update_topic_metadata,
      { name: "trip", description: "the Rome trip" },
    );
    expect(res.updated).toBe("trip");
    expect(store.getTopic("trip")).toMatchObject({
      description: "the Rome trip",
      body: "## Plans\nFly to Rome.",
    });
  });

  it("renames and rejects a rename onto an existing name", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "", "body");
    seedTopic(store, "taken", "", "body");
    const tools = buildTopicTools({ store });
    const clash = await write<{ error: string }>(
      store,
      tools.update_topic_metadata,
      { name: "trip", newName: "taken" },
    );
    expect(clash.error).toContain("topic exists");
    const ok = await write<{ updated: string }>(
      store,
      tools.update_topic_metadata,
      { name: "trip", newName: "rome trip" },
    );
    expect(ok.updated).toBe("rome trip");
    expect(store.getTopic("rome trip")?.body).toBe("body");
  });

  it("rejects a call that changes nothing", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "same", "body");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(
      store,
      tools.update_topic_metadata,
      { name: "trip", description: "same" },
    );
    expect(res.error).toContain("nothing to change");
  });

  it("returns a read-only error on a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(
      store,
      tools.update_topic_metadata,
      { name: "Zero", description: "hacked" },
    );
    expect(res.error).toContain("read-only");
  });
});

describe("create_topic tool", () => {
  it("creates the topic complete with its body and links", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = buildTopicTools({ store });
    const res = await write<{ created: string; version: number }>(
      store,
      tools.create_topic,
      { name: "trip", description: "travel", body: "see [[flights]]" },
    );
    expect(res.created).toBe("trip");
    expect(res.version).toBe(store.getKnowledgeVersion());
    expect(store.getTopic("trip")?.body).toBe("see [[flights]]");
    expect(store.getOutboundLinks("trip")).toEqual(["flights"]);
  });

  it("rejects an empty body", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.create_topic, {
      name: "trip",
      description: "travel",
      body: "  ",
    });
    expect(res.error).toContain("body must not be empty");
    expect(store.getTopic("trip")).toBeNull();
  });

  it("rejects an existing name", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "", "kept");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.create_topic, {
      name: "trip",
      description: "travel",
      body: "new",
    });
    expect(res.error).toContain("topic exists");
    expect(store.getTopic("trip")?.body).toBe("kept");
  });
});

describe("knowledge versions", () => {
  it("rejects a write based on a stale version and changes nothing", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "", "## Plans\nFly to Rome.");
    const stale = store.getKnowledgeVersion();
    // Another writer moves the knowledge on.
    setBody(store, "trip", "## Plans\nFly to Lisbon.");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.append_topic, {
      expectedVersion: stale,
      name: "trip",
      text: "- booked",
    });
    expect(res.error).toContain("reread");
    expect(store.getTopic("trip")?.body).toBe("## Plans\nFly to Lisbon.");
  });

  it("returns a version a following write can use", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = buildTopicTools({ store });
    const created = await write<{ version: number }>(store, tools.create_topic, {
      name: "trip",
      description: "travel",
      body: "## Plans",
    });
    const appended = await write<{ version: number }>(store, tools.append_topic, {
      expectedVersion: created.version,
      name: "trip",
      text: "- booked",
    });
    expect(appended.version).toBe(created.version + 1);
    expect(store.getTopic("trip")?.body).toBe("## Plans\n\n- booked");
  });

  it("lets only one of two writers on the same version win", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "", "## Plans");
    const tools = buildTopicTools({ store });
    const shared = store.getKnowledgeVersion();
    const first = await write<{ version: number }>(store, tools.append_topic, {
      expectedVersion: shared,
      name: "trip",
      text: "- from A",
    });
    const second = await write<{ error: string }>(store, tools.append_topic, {
      expectedVersion: shared,
      name: "trip",
      text: "- from B",
    });
    expect(first.version).toBe(shared + 1);
    expect(second.error).toContain("reread");
    expect(store.getTopic("trip")?.body).not.toContain("- from B");
  });

  it("bumps the version once when bundled system topics change", () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const before = store.getKnowledgeVersion();
    const first = store.syncSystemTopicsFingerprint("fp-1");
    expect(first).toBe(before + 1);
    expect(store.syncSystemTopicsFingerprint("fp-1")).toBe(first);
    expect(store.syncSystemTopicsFingerprint("fp-2")).toBe(first + 1);
  });
});

// Incremental body writes. These exist so a one-line change costs one line of
// generated tokens instead of the whole document; the tests pin that the rest of
// the body is preserved byte-for-byte, and that link rows still re-derive.
describe("edit_topic tool", () => {
  const seeded = () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "travel");
    setBody(store, "trip", "## Plans\nFly to Rome.\n\n## Log\n- booked flights");
    return store;
  };

  it("replaces a unique snippet and leaves the rest byte-identical", async () => {
    const store = seeded();
    const tools = buildTopicTools({ store });
    const res = await write<{ updated: string }>(store, tools.edit_topic, {
      name: "trip",
      oldText: "Fly to Rome.",
      newText: "Fly to Rome on 3 May.",
    });
    expect(res.updated).toBe("trip");
    expect(store.getTopic("trip")?.body).toBe(
      "## Plans\nFly to Rome on 3 May.\n\n## Log\n- booked flights",
    );
  });

  it("errors when the anchor is not found", async () => {
    const store = seeded();
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.edit_topic, {
      name: "trip",
      oldText: "Fly to Paris.",
      newText: "x",
    });
    expect(res.error).toContain("not found in trip");
    expect(store.getTopic("trip")?.body).toContain("Fly to Rome.");
  });

  it("errors when the anchor is ambiguous", async () => {
    const store = seeded();
    setBody(store, "trip", "note\nnote");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.edit_topic, {
      name: "trip",
      oldText: "note",
      newText: "x",
    });
    expect(res.error).toContain("more than once");
    expect(store.getTopic("trip")?.body).toBe("note\nnote");
  });

  it("errors on an empty anchor and points at append_topic", async () => {
    const store = seeded();
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.edit_topic, {
      name: "trip",
      oldText: "",
      newText: "x",
    });
    expect(res.error).toContain("append_topic");
  });

  // The tool checks existence itself: DbStore.updateTopicBody silently no-ops on
  // an unknown name, so a store-level check would report success in production.
  it("errors on an unknown topic", async () => {
    const store = seeded();
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.edit_topic, {
      name: "nope",
      oldText: "a",
      newText: "b",
    });
    expect(res.error).toBe("topic not found: nope");
  });

  it("re-derives outbound links for the edited body", async () => {
    const store = seeded();
    seedTopic(store, "flights", "");
    const tools = buildTopicTools({ store });
    await write(store, tools.edit_topic, {
      name: "trip",
      oldText: "- booked flights",
      newText: "- booked [[flights]]",
    });
    expect(store.getOutboundLinks("trip")).toContain("flights");
    await write(store, tools.edit_topic, {
      name: "trip",
      oldText: "- booked [[flights]]",
      newText: "- booked flights",
    });
    expect(store.getOutboundLinks("trip")).not.toContain("flights");
  });

  it("records the topic in the accessed set", async () => {
    const store = seeded();
    const accessed = new Set<string>();
    const tools = buildTopicTools({ store, accessed });
    await write(store, tools.edit_topic, {
      name: "trip",
      oldText: "Fly to Rome.",
      newText: "Fly to Rome soon.",
    });
    expect([...accessed]).toEqual(["trip"]);
  });

  it("returns a read-only error on a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = buildTopicTools({ store });
    const body = store.getTopic("Zero")?.body ?? "";
    const res = await write<{ error: string }>(store, tools.edit_topic, {
      name: "Zero",
      oldText: body.slice(0, 12),
      newText: "hacked",
    });
    expect(res.error).toContain("read-only");
    expect(store.getTopic("Zero")?.body).toBe(body);
  });
});

describe("append_topic tool", () => {
  it("appends a section separated by one blank line", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "");
    setBody(store, "trip", "## Plans\nFly to Rome.\n");
    const tools = buildTopicTools({ store });
    await write(store, tools.append_topic, {
      name: "trip",
      text: "## Log\n- booked flights",
    });
    expect(store.getTopic("trip")?.body).toBe(
      "## Plans\nFly to Rome.\n\n## Log\n- booked flights",
    );
  });

  it("does not leave a leading blank line on an empty body", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "fresh", "");
    const tools = buildTopicTools({ store });
    await write(store, tools.append_topic, {
      name: "fresh",
      text: "## Log\n- first",
    });
    expect(store.getTopic("fresh")?.body).toBe("## Log\n- first");
  });

  it("errors on an unknown topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.append_topic, {
      name: "nope",
      text: "x",
    });
    expect(res.error).toBe("topic not found: nope");
  });

  it("re-derives outbound links for appended text", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    seedTopic(store, "trip", "");
    seedTopic(store, "flights", "");
    const tools = buildTopicTools({ store });
    await write(store, tools.append_topic, {
      name: "trip",
      text: "see [[flights]]",
    });
    expect(store.getOutboundLinks("trip")).toContain("flights");
  });

  it("returns a read-only error on a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = buildTopicTools({ store });
    const res = await write<{ error: string }>(store, tools.append_topic, {
      name: "Zero",
      text: "hacked",
    });
    expect(res.error).toContain("read-only");
    expect(store.getTopic("Zero")?.body).not.toContain("hacked");
  });
});
