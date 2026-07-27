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
