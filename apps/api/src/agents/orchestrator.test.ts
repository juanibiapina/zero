import { describe, expect, it } from "vitest";
import { runTurn } from "./orchestrator";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

describe("runTurn", () => {
  it("no-ops when the thread tail is not a user message", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    store.storeMessage(id, "assistant", "hello");
    const sink = collectSink();

    await runTurn({
      store,
      model: scriptedModel([]),
      send: sink.send,
      search: createMemorySearch(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual([]);
  });

  it("runs the interface agent, persists replies, and clears busy", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    await runTurn({
      store,
      model: scriptedModel([
        { tools: [{ name: "reply", input: { text: "hello there" } }] },
        { text: "done" },
      ]),
      send: sink.send,
      search: createMemorySearch(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual(["hello there"]);
    const history = store.getConversationHistory(id, 10);
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
    // No topics accessed → thread tail is now assistant, not awaiting reply.
    expect(store.findThreadsAwaitingReply()).toEqual([]);
  });

  it("consolidates accessed topics via the writer", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "I'm going to Rome");
    const sink = collectSink();

    await runTurn({
      store,
      model: scriptedModel([
        // interface: read topic, then reply
        { tools: [{ name: "get_topic", input: { name: "travel" } }] },
        { tools: [{ name: "reply", input: { text: "Have fun!" } }] },
        { text: "done" },
        // writer: save the topic
        {
          tools: [
            {
              name: "save_topic",
              input: {
                name: "travel",
                body: "Rome trip planned.",
                description: "trip planning",
                summary: "Rome trip",
              },
            },
          ],
        },
        { text: "done" },
      ]),
      send: sink.send,
      search: createMemorySearch(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual(["Have fun!"]);
    expect(store.getTopic("travel")?.body).toContain("Rome trip planned.");
  });
});
