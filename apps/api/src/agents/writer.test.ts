import { describe, expect, it } from "vitest";
import { runWriterAgent } from "./writer";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";

describe("runWriterAgent", () => {
  it("returns early with no topics and does not call the model", async () => {
    const store = new MemoryStore();
    // A model that would throw if generate were called (empty script).
    const model = scriptedModel([]);
    const result = await runWriterAgent({
      model,
      store,
      topics: [],
      exchange: { user: "hi", assistant: ["hello"] },
    });
    expect(result.saved).toEqual([]);
  });

  it("persists a topic the model saves", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    const topics = store.getTopicsWithBodies(["travel"]);
    const model = scriptedModel([
      {
        tools: [
          {
            name: "save_topic",
            input: {
              name: "travel",
              body: "## Notes\nGoing to Rome.",
              description: "trip planning",
              summary: "Planning a Rome trip",
            },
          },
        ],
      },
      { text: "done" },
    ]);

    const result = await runWriterAgent({
      model,
      store,
      topics,
      exchange: { user: "I'm going to Rome", assistant: ["Nice!"] },
    });

    expect(result.saved).toEqual(["travel"]);
    const saved = store.getTopic("travel");
    expect(saved?.body).toContain("Going to Rome");
    expect(saved?.summary).toBe("Planning a Rome trip");
  });

  it("appends a log line to accessed topics the model skips", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    const topics = store.getTopicsWithBodies(["travel"]);
    const model = scriptedModel([{ text: "nothing to save" }]);

    await runWriterAgent({
      model,
      store,
      topics,
      exchange: { user: "just chatting", assistant: ["ok"] },
    });

    const body = store.getTopic("travel")?.body ?? "";
    expect(body).toContain("## Log");
    expect(body).toContain("just chatting");
  });

  it("renames a topic when save_topic supplies newName", async () => {
    const store = new MemoryStore();
    store.createTopic("trip", "");
    const topics = store.getTopicsWithBodies(["trip"]);
    const model = scriptedModel([
      {
        tools: [
          {
            name: "save_topic",
            input: {
              name: "trip",
              body: "b",
              description: "d",
              summary: "s",
              newName: "rome-trip",
            },
          },
        ],
      },
      { text: "done" },
    ]);

    const result = await runWriterAgent({
      model,
      store,
      topics,
      exchange: { user: "rome", assistant: ["ok"] },
    });

    expect(store.getTopic("trip")).toBeNull();
    expect(store.getTopic("rome-trip")).not.toBeNull();
    expect(result.saved).toContain("rome-trip");
  });
});
