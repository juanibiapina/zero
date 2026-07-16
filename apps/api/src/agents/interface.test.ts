import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_HEADER,
  FALLBACK_MESSAGE,
  renderConversation,
  runInterfaceAgent,
} from "./interface";
import { scriptedModel } from "./mock-model";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderConversation", () => {
  it("renders empty history with only the new user message", () => {
    expect(renderConversation([], "hi")).toBe(`${CONVERSATION_HEADER}\n\nUser: hi`);
  });

  it("renders mixed history in order, ending with the new user message", () => {
    const rendered = renderConversation(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      "how are you",
    );

    expect(rendered).toBe(
      `${CONVERSATION_HEADER}\n\nUser: hello\n\nYou: hi there\n\nUser: how are you`,
    );
  });
});

describe("runInterfaceAgent", () => {
  it("sends each reply immediately and collects them", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "Got it, let me check." } }] },
      { tools: [{ name: "reply", input: { text: "Here is the answer." } }] },
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
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
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "plan a trip",
    });

    expect(result.accessed.sort()).toEqual(["travel", "weather"]);
    expect(store.getTopic("travel")?.body).toBe("notes");
    expect(result.replies).toEqual(["ok"]);
  });

  it("researches then replies with the result", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    const model = scriptedModel([
      // interface acknowledges, then researches
      { tools: [{ name: "reply", input: { text: "Let me check." } }] },
      { tools: [{ name: "research", input: { prompt: "distance to Mars" } }] },
      // research agent: search then summarise
      { tools: [{ name: "web_search", input: { query: "distance to Mars" } }] },
      { text: "Mars is far. Source: https://ex.com/mars" },
      // interface relays the finding
      {
        tools: [
          { name: "reply", input: { text: "Mars is far. Source: https://ex.com/mars" } },
        ],
      },
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search,
      history: [],
      userMessage: "how far is Mars",
    });

    expect(result.replies).toEqual([
      "Let me check.",
      "Mars is far. Source: https://ex.com/mars",
    ]);
  });

  it("persists each reply before sending it", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "hi" } }] },
      { text: "" },
    ]);

    await runInterfaceAgent({
      model,
      store,
      send: async (t) => void order.push(`send:${t}`),
      persistReply: (t) => order.push(`persist:${t}`),
      search: createMemorySearch(),
      history: [],
      userMessage: "x",
    });

    expect(order).toEqual(["persist:hi", "send:hi"]);
  });

  it("persists the prose fallback before sending it", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const model = scriptedModel([{ text: "prose answer" }]);

    await runInterfaceAgent({
      model,
      store,
      send: async (t) => void order.push(`send:${t}`),
      persistReply: (t) => order.push(`persist:${t}`),
      search: createMemorySearch(),
      history: [],
      userMessage: "x",
    });

    expect(order).toEqual(["persist:prose answer", "send:prose answer"]);
  });

  it("sends the final text when the model never calls reply", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { text: "Here is the whole answer in prose." },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
    });

    expect(sink.sent).toEqual(["Here is the whole answer in prose."]);
    expect(result.replies).toEqual(["Here is the whole answer in prose."]);
  });

  it("sends the fallback when the model calls no reply and returns empty text", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([{ text: "" }]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
    });

    expect(sink.sent).toEqual([FALLBACK_MESSAGE]);
    expect(result.replies).toEqual([FALLBACK_MESSAGE]);
  });

  it("sends the fallback and logs turn_incomplete when the loop hits the step cap", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // A script of only tool steps under a low cap ends on a tool call
    // (finishReason "tool-calls") with no final text.
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "x" } }] },
      { tools: [{ name: "get_topic", input: { name: "y" } }] },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
      maxSteps: 1,
    });

    expect(sink.sent).toEqual([FALLBACK_MESSAGE]);
    expect(result.replies).toEqual([FALLBACK_MESSAGE]);
    const events = logSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_incomplete")).toBe(true);
  });

  it("sends the fallback after an ack reply when the loop hits the step cap", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "Let me check." } }] },
      { tools: [{ name: "get_topic", input: { name: "y" } }] },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
      maxSteps: 2,
    });

    expect(sink.sent).toEqual(["Let me check.", FALLBACK_MESSAGE]);
    expect(result.replies).toEqual(["Let me check.", FALLBACK_MESSAGE]);
  });

  it("delivers the final message even after an earlier reply", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "the answer" } }] },
      { text: "done" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
    });

    expect(sink.sent).toEqual(["the answer", "done"]);
    expect(result.replies).toEqual(["the answer", "done"]);
  });

  it("does not re-send the final text when it echoes the last reply", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "the answer" } }] },
      { text: "the answer" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      history: [],
      userMessage: "hi",
    });

    expect(sink.sent).toEqual(["the answer"]);
    expect(result.replies).toEqual(["the answer"]);
  });

  it("delivers the post-research answer sent as final prose after an ack reply", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    // The real failure: model acks, researches, then puts the answer in its
    // final text instead of another reply(). The ack must not suppress it.
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "Searching now..." } }] },
      { tools: [{ name: "research", input: { prompt: "distance to Mars" } }] },
      { tools: [{ name: "web_search", input: { query: "distance to Mars" } }] },
      { text: "Mars is far. Source: https://ex.com/mars" },
      { text: "Mars averages 225M km away. Source: https://ex.com/mars" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search,
      history: [],
      userMessage: "how far is Mars",
    });

    expect(sink.sent).toEqual([
      "Searching now...",
      "Mars averages 225M km away. Source: https://ex.com/mars",
    ]);
    expect(result.replies).toEqual(sink.sent);
  });

  it("re-raises when a reply send fails and still persists before sending", async () => {
    const store = new MemoryStore();
    const persisted: string[] = [];
    const model = scriptedModel([
      { tools: [{ name: "reply", input: { text: "undelivered" } }] },
      { text: "done" },
    ]);

    await expect(
      runInterfaceAgent({
        model,
        store,
        send: async () => {
          throw new Error("telegram down");
        },
        persistReply: (t) => persisted.push(t),
        search: createMemorySearch(),
        history: [],
        userMessage: "hi",
      }),
    ).rejects.toThrow("telegram down");

    // Persist-before-send preserved even though the send failed.
    expect(persisted).toEqual(["undelivered"]);
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
      search: createMemorySearch(),
      history: [],
      userMessage: "tell me about ghost",
    });

    expect(result.accessed).toEqual([]);
  });
});
