import { describe, it, expect } from "vitest";
import { buildTopicTools } from "./topics";
import { MemoryStore } from "../store/memory";

const call = <T = unknown>(
  tool: { execute: (a: unknown) => Promise<unknown> },
  input: unknown,
): Promise<T> => tool.execute(input) as Promise<T>;

describe("topic link tools", () => {
  it("get_topic returns outboundLinks and backlinks", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("trip", "");
    store.createTopic("flights", "");
    store.saveTopic("trip", { body: "book [[flights]]", description: "", summary: "" });
    const tools = buildTopicTools({ store });
    const trip = await call<{ outboundLinks: string[]; backlinks: string[] }>(
      tools.get_topic as never,
      { name: "trip" },
    );
    expect(trip.outboundLinks).toEqual(["flights"]);
    const flights = await call<{ backlinks: string[] }>(
      tools.get_topic as never,
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
    const rows = await call<{ name: string }[]>(tools.list_backlinks as never, {
      name: "flights",
    });
    expect(rows.map((t) => t.name)).toEqual(["trip"]);
    expect(accessed.has("flights")).toBe(true);
  });

  it("list_backlinks returns empty for a topic nothing links to", async () => {
    const store = new MemoryStore(() => "2026-01-01T00:00:00.000Z");
    store.createTopic("lonely", "");
    const tools = buildTopicTools({ store });
    const rows = await call<unknown[]>(tools.list_backlinks as never, {
      name: "lonely",
    });
    expect(rows).toEqual([]);
  });
});
