import { describe, it, expect } from "vitest";
import { buildTopicTools, buildInterfaceTools } from "./topics";
import { MemoryStore } from "../store/memory";
import { SystemTopicStore } from "../store/system-topics";
import type { TopicStore } from "../store/types";

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

describe("topic link tools", () => {
  it("get_topic returns outboundLinks and backlinks", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("trip", "");
    store.createTopic("flights", "");
    store.saveTopic("trip", { body: "book [[flights]]", description: "", summary: "" });
    const tools = buildTopicTools({ store });
    const trip = await call<{ outboundLinks: string[]; backlinks: string[] }>(
      tools.get_topic,
      { name: "trip" },
    );
    expect(trip.outboundLinks).toEqual(["flights"]);
    const flights = await call<{ backlinks: string[] }>(
      tools.get_topic,
      { name: "flights" },
    );
    expect(flights.backlinks).toEqual(["trip"]);
  });

  it("list_backlinks returns linking topics and records access", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("trip", "");
    store.saveTopic("trip", { body: "[[flights]]", description: "", summary: "" });
    const accessed = new Set<string>();
    const tools = buildTopicTools({ store, accessed });
    const rows = await call<{ name: string }[]>(
      tools.list_backlinks, {
      name: "flights",
    });
    expect(rows.map((t) => t.name)).toEqual(["trip"]);
    expect(accessed.has("flights")).toBe(true);
  });

  it("list_backlinks returns empty for a topic nothing links to", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("lonely", "");
    const tools = buildTopicTools({ store });
    const rows = await call<unknown[]>(
      tools.list_backlinks, {
      name: "lonely",
    });
    expect(rows).toEqual([]);
  });
});

describe("delete_topic tool", () => {
  it("deletes an existing topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("stale", "");
    const tools = makeInterfaceTools(store);
    const res = await call<{ deleted: string }>(
      tools.delete_topic, {
      name: "stale",
    });
    expect(res).toEqual({ deleted: "stale" });
    expect(store.getTopic("stale")).toBeNull();
  });

  it("returns an error for an unknown topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = makeInterfaceTools(store);
    const res = await call<{ error: string }>(
      tools.delete_topic, {
      name: "nope",
    });
    expect(res.error).toContain("topic not found");
  });

  it("returns a read-only error for a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = makeInterfaceTools(store);
    const res = await call<{ error: string }>(
      tools.delete_topic, {
      name: "Zero",
    });
    expect(res.error).toContain("read-only");
  });
});

describe("update_topic tool on system topics", () => {
  it("returns a read-only error", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = buildTopicTools({ store });
    const res = await call<{ error: string }>(
      tools.update_topic, {
      name: "Zero",
      body: "hacked",
    });
    expect(res.error).toContain("read-only");
    expect(store.getTopic("Zero")?.body).not.toBe("hacked");
  });
});

// Incremental body writes. These exist so a one-line change costs one line of
// generated tokens instead of the whole document; the tests pin that the rest of
// the body is preserved byte-for-byte, and that link rows still re-derive.
describe("edit_topic tool", () => {
  const seeded = () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("trip", "travel");
    store.saveTopic("trip", {
      body: "## Plans\nFly to Rome.\n\n## Log\n- booked flights",
      description: "travel",
      summary: "",
    });
    return store;
  };

  it("replaces a unique snippet and leaves the rest byte-identical", async () => {
    const store = seeded();
    const tools = buildTopicTools({ store });
    const res = await call<{ updated: string }>(tools.edit_topic, {
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
    const res = await call<{ error: string }>(tools.edit_topic, {
      name: "trip",
      oldText: "Fly to Paris.",
      newText: "x",
    });
    expect(res.error).toContain("not found in trip");
    expect(store.getTopic("trip")?.body).toContain("Fly to Rome.");
  });

  it("errors when the anchor is ambiguous", async () => {
    const store = seeded();
    store.updateTopicBody("trip", "note\nnote");
    const tools = buildTopicTools({ store });
    const res = await call<{ error: string }>(tools.edit_topic, {
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
    const res = await call<{ error: string }>(tools.edit_topic, {
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
    const res = await call<{ error: string }>(tools.edit_topic, {
      name: "nope",
      oldText: "a",
      newText: "b",
    });
    expect(res.error).toBe("topic not found: nope");
  });

  it("re-derives outbound links for the edited body", async () => {
    const store = seeded();
    store.createTopic("flights", "");
    const tools = buildTopicTools({ store });
    await call(tools.edit_topic, {
      name: "trip",
      oldText: "- booked flights",
      newText: "- booked [[flights]]",
    });
    expect(store.getOutboundLinks("trip")).toContain("flights");
    await call(tools.edit_topic, {
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
    await call(tools.edit_topic, {
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
    const res = await call<{ error: string }>(tools.edit_topic, {
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
    store.createTopic("trip", "");
    store.saveTopic("trip", {
      body: "## Plans\nFly to Rome.\n",
      description: "",
      summary: "",
    });
    const tools = buildTopicTools({ store });
    await call(tools.append_topic, {
      name: "trip",
      text: "## Log\n- booked flights",
    });
    expect(store.getTopic("trip")?.body).toBe(
      "## Plans\nFly to Rome.\n\n## Log\n- booked flights",
    );
  });

  it("does not leave a leading blank line on an empty body", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("fresh", "");
    const tools = buildTopicTools({ store });
    await call(tools.append_topic, { name: "fresh", text: "## Log\n- first" });
    expect(store.getTopic("fresh")?.body).toBe("## Log\n- first");
  });

  it("errors on an unknown topic", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    const tools = buildTopicTools({ store });
    const res = await call<{ error: string }>(tools.append_topic, {
      name: "nope",
      text: "x",
    });
    expect(res.error).toBe("topic not found: nope");
  });

  it("re-derives outbound links for appended text", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("trip", "");
    store.createTopic("flights", "");
    const tools = buildTopicTools({ store });
    await call(tools.append_topic, { name: "trip", text: "see [[flights]]" });
    expect(store.getOutboundLinks("trip")).toContain("flights");
  });

  it("returns a read-only error on a system topic", async () => {
    const store = new SystemTopicStore(
      new MemoryStore(() => "2026-01-01T00:00:00.000Z"),
    );
    const tools = buildTopicTools({ store });
    const res = await call<{ error: string }>(tools.append_topic, {
      name: "Zero",
      text: "hacked",
    });
    expect(res.error).toContain("read-only");
    expect(store.getTopic("Zero")?.body).not.toContain("hacked");
  });
});
