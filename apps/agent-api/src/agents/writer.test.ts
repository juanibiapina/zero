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
              description: "Rome trip planning",
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
      transcript: "User: I'm going to Rome\n\nAssistant: Nice!",
    });

    const saved = store.getTopic("travel");
    expect(saved?.body).toContain("Existing note.");
    expect(saved?.body).toContain("Going to Rome");
    expect(saved?.description).toBe("Rome trip planning");
  });

  // The consolidation shape we want: an anchored edit plus an appended Log line,
  // with no whole-body rewrite. The point is cost — a one-line change must not
  // cost the model the whole document — so the assertion is that untouched text
  // survives verbatim while the writer only ever generated the delta.
  it("consolidates with an anchored edit and an appended log line", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    const longBody =
      "## Notes\nExisting note.\n\n## History\n" +
      Array.from({ length: 40 }, (_, i) => `- old fact ${i}`).join("\n");
    store.saveTopic("travel", {
      body: longBody,
      description: "trips",
    });
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "travel" } }] },
      {
        tools: [
          {
            name: "edit_topic",
            input: {
              name: "travel",
              oldText: "## Notes\nExisting note.",
              newText: "## Notes\nExisting note.\nGoing to Rome.",
            },
          },
        ],
      },
      {
        tools: [
          {
            name: "append_topic",
            input: { name: "travel", text: "## Log\n- 2026 Rome trip" },
          },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: { name: "travel", description: "Rome trip planning" },
          },
        ],
      },
      { text: "done" },
    ]);

    await runWriterAgent({
      model,
      store,
      accessed: ["travel"],
      transcript: "User: I'm going to Rome\n\nAssistant: Nice!",
    });

    const saved = store.getTopic("travel");
    expect(saved?.body).toContain("Going to Rome.");
    expect(saved?.body).toContain("- 2026 Rome trip");
    // Every pre-existing line survives untouched, and none of it was regenerated.
    expect(saved?.body).toContain("- old fact 0");
    expect(saved?.body).toContain("- old fact 39");
    expect(saved?.description).toBe("Rome trip planning");
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
              description: "Rome trip in May",
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
      transcript: "User: I'm going to Rome in May\n\nAssistant: Nice!",
    });

    const created = store.getTopic("rome-trip");
    expect(created).not.toBeNull();
    expect(created?.body).toContain("Going to Rome in May");
    expect(created?.description).toBe("Rome trip in May");
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
      transcript: "User: rome\n\nAssistant: ok",
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
      transcript: "User: thanks!\n\nAssistant: np",
    });

    expect(store.listTopics()).toEqual([]);
  });

  it("creates a topic from a fact that only appears in a tool result", async () => {
    const store = new MemoryStore();
    // The user asked about their weekend; the wedding detail came from the
    // calendar tool result, not from the user message or the reply.
    const transcript = [
      "User: what's on this weekend?",
      "Tool call calendar_list_events: {}",
      'Tool result calendar_list_events: [{"title":"Anna & Tom wedding","start":"2026-08-15T15:00","location":"Tuscany"}]',
      "Assistant: You've got a wedding Saturday.",
    ].join("\n\n");
    const model = scriptedModel([
      { tools: [{ name: "list_topics", input: {} }] },
      {
        tools: [
          {
            name: "create_topic",
            input: { name: "anna-tom-wedding", description: "wedding event" },
          },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: {
              name: "anna-tom-wedding",
              body: "## Details\nAnna & Tom wedding, 2026-08-15 15:00, Tuscany.",
              description: "Wedding on 2026-08-15 in Tuscany",
            },
          },
        ],
      },
      { text: "done" },
    ]);

    await runWriterAgent({ model, store, accessed: [], transcript });

    const created = store.getTopic("anna-tom-wedding");
    expect(created).not.toBeNull();
    expect(created?.body).toContain("Tuscany");
    expect(created?.body).toContain("2026-08-15");
  });
});
