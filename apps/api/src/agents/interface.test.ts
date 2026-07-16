import { describe, expect, it } from "vitest";
import {
  CONVERSATION_HEADER,
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
      { text: "done" },
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

  it("sends nothing when the model calls no reply and returns empty text", async () => {
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

    expect(sink.sent).toEqual([]);
    expect(result.replies).toEqual([]);
  });

  it("does not send trailing filler text when reply was already called", async () => {
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

    expect(sink.sent).toEqual(["the answer"]);
    expect(result.replies).toEqual(["the answer"]);
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
