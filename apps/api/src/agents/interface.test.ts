import { describe, expect, it } from "vitest";
import { runInterfaceAgent } from "./interface";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

describe("runInterfaceAgent", () => {
  it("sends each reply immediately and collects them", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "Got it, let me check." } }] },
      { tools: [{ name: "reply", input: { text: "Here is the answer." } }] },
      { text: "done" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      history: [],
      userMessage: "hi",
    });

    expect(sink.sent).toEqual(["Got it, let me check.", "Here is the answer."]);
    expect(result.replies).toEqual([
      "Got it, let me check.",
      "Here is the answer.",
    ]);
    expect(result.accessed).toEqual([]);
  });

  it("tracks accessed topics from get/create/update", async () => {
    const store = new MemoryStore();
    store.createTopic("weather", "climate");
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "weather" } }] },
      {
        tools: [
          { name: "create_topic", input: { name: "travel", description: "trips" } },
        ],
      },
      { tools: [{ name: "update_topic", input: { name: "travel", body: "notes" } }] },
      { tools: [{ name: "reply", input: { text: "ok" } }] },
      { text: "done" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      history: [],
      userMessage: "plan a trip",
    });

    expect(result.accessed.sort()).toEqual(["travel", "weather"]);
    expect(store.getTopic("travel")?.body).toBe("notes");
    expect(result.replies).toEqual(["ok"]);
  });

  it("does not track a topic that was not found", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "ghost" } }] },
      { tools: [{ name: "reply", input: { text: "no such topic" } }] },
      { text: "done" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      history: [],
      userMessage: "tell me about ghost",
    });

    expect(result.accessed).toEqual([]);
  });
});
