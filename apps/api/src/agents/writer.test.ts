import { describe, expect, it } from "vitest";
import { runWriterAgent } from "./writer";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";

describe("runWriterAgent", () => {
  it("updates an accessed topic the model revises", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    store.saveTopic("travel", {
      body: "## Notes\nExisting note.",
      description: "trips",
      summary: "old",
    });
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "travel" } }] },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "travel",
              body: "## Notes\nExisting note.\nGoing to Rome.\n\n## Log\n- 2026 Rome trip",
              summary: "Planning a Rome trip",
            },
          },
        ],
      },
      { text: "done" },
    ]);

    await runWriterAgent({
      model,
      store,
      accessed: ["travel"],
      exchange: { user: "I'm going to Rome", assistant: ["Nice!"] },
    });

    const saved = store.getTopic("travel");
    expect(saved?.body).toContain("Existing note.");
    expect(saved?.body).toContain("Going to Rome");
    expect(saved?.summary).toBe("Planning a Rome trip");
    // description untouched (not in the patch)
    expect(saved?.description).toBe("trips");
  });

  it("proactively creates a topic for a new durable subject", async () => {
    const store = new MemoryStore();
    const model = scriptedModel([
      { tools: [{ name: "list_topics", input: {} }] },
      {
        tools: [
          {
            name: "create_topic",
            input: { name: "rome-trip", description: "trip planning" },
          },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "rome-trip",
              body: "## Notes\nGoing to Rome in May.",
              summary: "Rome trip in May",
            },
          },
        ],
      },
      { text: "done" },
    ]);

    await runWriterAgent({
      model,
      store,
      accessed: [],
      exchange: { user: "I'm going to Rome in May", assistant: ["Nice!"] },
    });

    const created = store.getTopic("rome-trip");
    expect(created).not.toBeNull();
    expect(created?.body).toContain("Going to Rome in May");
    expect(created?.summary).toBe("Rome trip in May");
  });

  it("renames a topic via update_topic newName", async () => {
    const store = new MemoryStore();
    store.createTopic("trip", "");
    const model = scriptedModel([
      {
        tools: [
          {
            name: "update_topic",
            input: { name: "trip", body: "b", newName: "rome-trip" },
          },
        ],
      },
      { text: "done" },
    ]);

    await runWriterAgent({
      model,
      store,
      accessed: ["trip"],
      exchange: { user: "rome", assistant: ["ok"] },
    });

    expect(store.getTopic("trip")).toBeNull();
    expect(store.getTopic("rome-trip")).not.toBeNull();
    expect(store.getTopic("rome-trip")?.body).toBe("b");
  });

  it("makes no changes on a trivial exchange", async () => {
    const store = new MemoryStore();
    const model = scriptedModel([{ text: "nothing to consolidate" }]);

    await runWriterAgent({
      model,
      store,
      accessed: [],
      exchange: { user: "thanks!", assistant: ["np"] },
    });

    expect(store.listTopics()).toEqual([]);
  });
});
