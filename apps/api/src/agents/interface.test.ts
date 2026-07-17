import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_HEADER,
  FALLBACK_MESSAGE,
  formatAge,
  renderConversation,
  runInterfaceAgent,
} from "./interface";
import { interfaceSystemPrompt, renderPinnedTopics } from "./prompts";
import { scriptedModel } from "./mock-model";
import { MockLanguageModelV3 } from "ai/test";
import type { Topic } from "../store/types";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryGoogle } from "../google/memory";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-07-17T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatAge", () => {
  it("buckets deltas from just-now to absolute fallback", () => {
    expect(formatAge(iso(0), NOW)).toBe("just now");
    expect(formatAge(iso(30_000), NOW)).toBe("just now");
    expect(formatAge(iso(5 * 60_000), NOW)).toBe("5 min ago");
    expect(formatAge(iso(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(formatAge(iso(26 * 3_600_000), NOW)).toBe("yesterday");
    expect(formatAge(iso(3 * 86_400_000), NOW)).toBe("3 days ago");
    expect(formatAge(iso(7 * 86_400_000), NOW)).toBe("7 days ago");
    expect(formatAge(iso(30 * 86_400_000), NOW)).toBe("on 2026-06-17");
  });
});

describe("interfaceSystemPrompt", () => {
  it("anchors the prompt with the current datetime in UTC by default", () => {
    expect(interfaceSystemPrompt(NOW)).toContain(
      "Current time: Friday, 2026-07-17 12:00 (UTC, GMT+0).",
    );
  });

  it("renders the anchor in the user's timezone", () => {
    const prompt = interfaceSystemPrompt(NOW, "America/Sao_Paulo");
    expect(prompt).toContain(
      "Current time: Friday, 2026-07-17 09:00 (America/Sao_Paulo, GMT-3).",
    );
    expect(prompt).toContain("The user's timezone is America/Sao_Paulo");
  });
});

const topic = (name: string, body: string, pinned = true): Topic => ({
  name,
  description: "",
  summary: "",
  body,
  createdAt: NOW.toISOString(),
  lastActiveAt: NOW.toISOString(),
  messageCount: 0,
  pinned,
});

describe("renderPinnedTopics", () => {
  it("returns empty string when nothing is pinned", () => {
    expect(renderPinnedTopics([])).toBe("");
  });

  it("renders each pinned topic's name and body", () => {
    const block = renderPinnedTopics([topic("User", "name: Alice")]);
    expect(block).toContain("Pinned topics (always in your context)");
    expect(block).toContain("### User");
    expect(block).toContain("name: Alice");
  });

  it("truncates a very long body", () => {
    const block = renderPinnedTopics([topic("User", "x".repeat(2000))]);
    expect(block).toContain("…[truncated]");
    expect(block.length).toBeLessThan(2000);
  });
});

describe("runInterfaceAgent pinned surfacing", () => {
  it("includes a pinned topic's body in the system prompt", async () => {
    const store = new MemoryStore();
    store.createTopic("User", "identity");
    store.updateTopicBody("User", "name: Alice; city: Berlin");
    store.setPinned("User", true);

    const captured: { system?: string } = {};
    const model = new MockLanguageModelV3({
      doGenerate: async (options: {
        prompt: Array<{ role: string; content: unknown }>;
      }) => {
        const sys = options.prompt.find((m) => m.role === "system");
        captured.system =
          typeof sys?.content === "string"
            ? sys.content
            : JSON.stringify(sys?.content);
        return {
          content: [{ type: "text", text: "" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as never;
      },
    });

    await runInterfaceAgent({
      model,
      store,
      send: collectSink().send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      history: [],
      userMessage: "hi",
    });

    expect(captured.system).toContain("name: Alice; city: Berlin");
  });
});

describe("renderConversation", () => {
  it("renders empty history with only the new user message as just now", () => {
    expect(renderConversation([], "hi", NOW)).toBe(
      `${CONVERSATION_HEADER}\n\n[just now] User: hi`,
    );
  });

  it("renders mixed history with relative ages, ending with the new message", () => {
    const rendered = renderConversation(
      [
        { role: "user", content: "hello", createdAt: iso(2 * 86_400_000) },
        { role: "assistant", content: "hi there", createdAt: iso(5 * 60_000) },
      ],
      "how are you",
      NOW,
    );

    expect(rendered).toBe(
      `${CONVERSATION_HEADER}\n\n[2 days ago] User: hello\n\n[5 min ago] You: hi there\n\n[just now] User: how are you`,
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
      history: [],
      userMessage: "how far is Mars",
    });

    expect(result.replies).toEqual([
      "Let me check.",
      "Mars is far. Source: https://ex.com/mars",
    ]);
  });

  it("keeps research findings in a topic even when the model never replies them", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    const model = scriptedModel([
      // interface acks then researches
      { tools: [{ name: "reply", input: { text: "Let me check." } }] },
      { tools: [{ name: "research", input: { prompt: "distance to Mars" } }] },
      // research agent: search, create + fill a topic, then final text
      { tools: [{ name: "web_search", input: { query: "distance to Mars" } }] },
      {
        tools: [
          { name: "create_topic", input: { name: "Mars", description: "the planet" } },
        ],
      },
      {
        tools: [
          {
            name: "update_topic",
            input: { name: "Mars", body: "Mars is far. Source: https://ex.com/mars" },
          },
        ],
      },
      { text: "Wrote topic 'Mars'." },
      // interface finishes without replying the finding
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search,
      google: createMemoryGoogle(),
      history: [],
      userMessage: "how far is Mars",
    });

    expect(store.getTopic("Mars")?.body).toBe(
      "Mars is far. Source: https://ex.com/mars",
    );
    expect(result.accessed).toContain("Mars");
  });

  it("routes set_timezone through to the setter", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const setTimezone = vi.fn();
    const model = scriptedModel([
      { tools: [{ name: "set_timezone", input: { timezone: "Asia/Tokyo" } }] },
      { text: "Done, you're on Tokyo time now." },
    ]);

    await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      setTimezone,
      history: [],
      userMessage: "I moved to Tokyo",
    });

    expect(setTimezone).toHaveBeenCalledWith("Asia/Tokyo");
  });

  it("reads a Gmail thread then replies, flowing the tool result back", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const google = createMemoryGoogle({
      threadSummaries: [
        { threadId: "T1", date: "today", from: "a@x.com", subject: "Lunch?", snippet: "s" },
      ],
      threads: {
        T1: {
          threadId: "T1",
          messages: [
            {
              id: "M1",
              threadId: "T1",
              messageIdHeader: "<abc@mail>",
              from: "a@x.com",
              to: "me@x.com",
              subject: "Lunch?",
              date: "today",
              body: "Want lunch?",
            },
          ],
        },
      },
    });
    const model = scriptedModel([
      { tools: [{ name: "gmail_search", input: { query: "from:a" } }] },
      { tools: [{ name: "gmail_thread", input: { threadId: "T1" } }] },
      { tools: [{ name: "reply", input: { text: "Your last mail from a@x.com asks about lunch." } }] },
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google,
      history: [],
      userMessage: "what did a email me?",
    });

    expect(result.replies).toEqual([
      "Your last mail from a@x.com asks about lunch.",
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
      google: createMemoryGoogle(),
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
        google: createMemoryGoogle(),
        history: [],
        userMessage: "hi",
      }),
    ).rejects.toThrow("telegram down");

    // Persist-before-send preserved even though the send failed.
    expect(persisted).toEqual(["undelivered"]);
  });

  it("builds a transcript with the user message, tool calls, and results", async () => {
    const store = new MemoryStore();
    store.createTopic("weather", "climate");
    store.saveTopic("weather", {
      body: "Sunny today.",
      description: "climate",
      summary: "sunny",
    });
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "weather" } }] },
      { tools: [{ name: "reply", input: { text: "It's sunny." } }] },
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      history: [],
      userMessage: "weather?",
    });

    expect(result.transcript).toContain("User: weather?");
    expect(result.transcript).toContain("Tool call get_topic");
    expect(result.transcript).toContain("Tool result get_topic");
    expect(result.transcript).toContain("Sunny today.");
  });

  it("truncates a large tool result in the transcript", async () => {
    const store = new MemoryStore();
    const big = "x".repeat(5000);
    store.createTopic("big", "");
    store.saveTopic("big", { body: big, description: "", summary: "" });
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "big" } }] },
      { text: "done" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      history: [],
      userMessage: "read big",
    });

    expect(result.transcript).toContain("…[truncated]");
    expect(result.transcript.length).toBeLessThan(big.length);
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
      google: createMemoryGoogle(),
      history: [],
      userMessage: "tell me about ghost",
    });

    expect(result.accessed).toEqual([]);
  });
});
