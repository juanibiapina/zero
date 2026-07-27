import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MESSAGE,
  buildConversationMessages,
  decideFinalDelivery,
  formatTimestamp,
  runInterfaceAgent,
} from "./interface";
import {
  interfaceContext,
  interfaceSystemPrompt,
  renderPinnedTopics,
} from "./prompts";
import { capturingModel, scriptedModel } from "./mock-model";
import type { AgentMessage, TextBlock } from "./protocol";
import type { Topic } from "../store/types";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryGoogle } from "../google/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { createMemoryAttachments } from "../attachments/memory";
import { attachmentKey } from "../attachments/types";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date("2026-07-17T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("formatTimestamp", () => {
  it("renders an absolute local timestamp in the user's timezone", () => {
    expect(formatTimestamp(NOW.toISOString(), "UTC")).toBe("2026-07-17 12:00");
    expect(formatTimestamp(NOW.toISOString(), "America/Sao_Paulo")).toBe(
      "2026-07-17 09:00",
    );
  });
});

describe("decideFinalDelivery", () => {
  // Row 1: clean finish, non-empty text, no prior replies -> send.
  it("sends the final text on a clean finish with no prior replies", () => {
    expect(
      decideFinalDelivery({ finishReason: "stop", text: "answer", replies: [] }),
    ).toEqual({ action: "send", text: "answer" });
  });

  // Row 2: the ack-then-answer regression — an earlier non-echo reply must not
  // suppress the final text.
  it("sends the final text even after a prior non-echo reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "the answer",
        replies: ["Searching now..."],
      }),
    ).toEqual({ action: "send", text: "the answer" });
  });

  // Row 3: final text exactly echoes the last reply -> suppress.
  it("suppresses the final text when it exactly echoes the last reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "done",
        replies: ["done"],
      }),
    ).toEqual({ action: "none" });
  });

  // Echo compares both sides trimmed.
  it("suppresses the final text when it echoes the last reply modulo whitespace", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "  done  ",
        replies: ["done"],
      }),
    ).toEqual({ action: "none" });
  });

  // Row 4: clean finish, empty text, prior reply -> suppress.
  it("suppresses an empty final text when a reply already went out", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "",
        replies: ["the reply"],
      }),
    ).toEqual({ action: "none" });
  });

  // Whitespace-only text is treated as empty.
  it("treats whitespace-only final text as empty (suppress with a prior reply)", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "   ",
        replies: ["the reply"],
      }),
    ).toEqual({ action: "none" });
  });

  // Row 5: clean finish, empty text, no replies -> fallback.
  it("falls back on a clean finish that said nothing and sent no reply", () => {
    expect(
      decideFinalDelivery({ finishReason: "stop", text: "", replies: [] }),
    ).toEqual({ action: "fallback" });
  });

  // Row 6a: cap cut-off with empty text and no replies -> fallback.
  it("falls back on a cap cut-off with no reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "tool-calls",
        text: "",
        replies: [],
      }),
    ).toEqual({ action: "fallback" });
  });

  // Row 6b: cap cut-off after an ack reply -> still fallback.
  it("falls back on a cap cut-off after an ack reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "tool-calls",
        text: "",
        replies: ["Searching now..."],
      }),
    ).toEqual({ action: "fallback" });
  });

  // Concern 1: cap cut-off discards produced final text (no replies variant).
  it("discards non-empty final text on a cap cut-off with no reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "tool-calls",
        text: "some answer",
        replies: [],
      }),
    ).toEqual({ action: "fallback" });
  });

  // Concern 1: cap cut-off discards produced final text (ack variant).
  it("discards non-empty final text on a cap cut-off after an ack reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "tool-calls",
        text: "some answer",
        replies: ["Searching now..."],
      }),
    ).toEqual({ action: "fallback" });
  });

  // Raw-vs-trimmed: guards compare trimmed, delivery carries the raw text.
  it("carries the raw untrimmed text on the send action", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "answer\n",
        replies: [],
      }),
    ).toEqual({ action: "send", text: "answer\n" });
  });

  // Concern 2: the echo guard compares only the last reply, so echoing an
  // earlier, non-last reply must still send.
  it("sends when the final text echoes an earlier, non-last reply", () => {
    expect(
      decideFinalDelivery({
        finishReason: "stop",
        text: "hi",
        replies: ["hi", "different"],
      }),
    ).toEqual({ action: "send", text: "hi" });
  });

  // Nit 1: fallback and none carry no text field (runner owns FALLBACK_MESSAGE).
  it("returns fallback and none with no stray text field", () => {
    const fallback = decideFinalDelivery({
      finishReason: "tool-calls",
      text: "",
      replies: [],
    });
    const none = decideFinalDelivery({
      finishReason: "stop",
      text: "",
      replies: ["reply"],
    });
    expect(fallback).toEqual({ action: "fallback" });
    expect(fallback).not.toHaveProperty("text");
    expect(none).toEqual({ action: "none" });
    expect(none).not.toHaveProperty("text");
  });
});

describe("interfaceSystemPrompt", () => {
  it("carries no per-minute time or timezone value (stays cross-user cacheable)", () => {
    const prompt = interfaceSystemPrompt();
    expect(prompt).not.toContain("Current time:");
    expect(prompt).not.toContain("The user's timezone is");
    expect(prompt).toContain("given with the latest user message");
  });

  it("folds pinned topics onto the tail when present, absent when empty", () => {
    expect(interfaceSystemPrompt()).not.toContain("Pinned topics");
    const withPinned = interfaceSystemPrompt("\n\n## Pinned topics\n\nbody");
    expect(withPinned).toContain("Pinned topics");
    expect(withPinned.endsWith("body")).toBe(true);
  });
});

describe("interfaceContext", () => {
  it("renders the current datetime and timezone in UTC by default", () => {
    expect(interfaceContext(NOW)).toContain(
      "Current time: Friday, 2026-07-17 12:00 (UTC, GMT+0).",
    );
    expect(interfaceContext(NOW)).toContain("Your timezone is UTC");
  });

  it("renders the anchor in the user's timezone", () => {
    const context = interfaceContext(NOW, "America/Sao_Paulo");
    expect(context).toContain(
      "Current time: Friday, 2026-07-17 09:00 (America/Sao_Paulo, GMT-3).",
    );
    expect(context).toContain("Your timezone is America/Sao_Paulo");
  });
});

const topic = (name: string, body: string, pinned = true): Topic => ({
  name,
  description: "",
  summary: "",
  system: false,
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
    const model = capturingModel((request) => {
      captured.system = request.system.map((b) => b.text).join("\n");
      return {};
    });

    await runInterfaceAgent({
      model,
      store,
      send: collectSink().send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "hi",
    });

    expect(captured.system).toContain("name: Alice; city: Berlin");
  });
});

describe("runInterfaceAgent prompt shape (caching)", () => {
  const capturePrompt = async (opts: {
    history?: import("../store/types").Message[];
    timezone?: string;
  }) => {
    const store = new MemoryStore();
    const captured: { system?: TextBlock[]; messages?: AgentMessage[] } = {};
    const model = capturingModel((request) => {
      captured.system = request.system;
      captured.messages = request.messages;
      return {};
    });
    await runInterfaceAgent({
      model,
      store,
      send: collectSink().send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: opts.history ?? [],
      userMessage: "hi",
      timezone: opts.timezone,
      now: NOW,
    });
    return captured;
  };

  // A message is marked when its last content block carries a breakpoint.
  const cc = (m: AgentMessage | undefined) => {
    if (!m || typeof m.content === "string") return undefined;
    return m.content[m.content.length - 1]?.cache_control;
  };

  it("puts the current time and timezone on the latest user message, not the system prompt", async () => {
    const { system, messages } = await capturePrompt({
      timezone: "America/Sao_Paulo",
    });
    expect(JSON.stringify(system)).not.toContain("Current time:");

    const users = (messages ?? []).filter((m) => m.role === "user");
    const lastUser = JSON.stringify(users[users.length - 1]?.content);
    expect(lastUser).toContain("Current time: Friday, 2026-07-17 09:00");
    expect(lastUser).toContain("Your timezone is America/Sao_Paulo");
  });

  it("caches the system prompt with a 1h ttl", async () => {
    const { system } = await capturePrompt({});
    expect(system?.[system.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("marks the last stable message and the current message (sliding window)", async () => {
    const { messages = [] } = await capturePrompt({
      history: [
        { role: "user", content: "q", createdAt: iso(5 * 60_000) },
        { role: "assistant", content: "a", createdAt: iso(4 * 60_000) },
      ],
    });
    // Last two conversation messages (stable assistant + current user) carry a
    // breakpoint; earlier messages do not.
    expect(cc(messages[messages.length - 1])).toBeTruthy();
    expect(cc(messages[messages.length - 2])).toBeTruthy();
    expect(cc(messages[0])).toBeFalsy();
  });

  it("collapses to one breakpoint on the current message when history is empty", async () => {
    const { messages = [] } = await capturePrompt({});
    expect(messages).toHaveLength(1);
    expect(cc(messages[0])).toBeTruthy();
  });
});

describe("buildConversationMessages", () => {
  it("returns a single user message for empty history", () => {
    expect(buildConversationMessages([], "hi", NOW, "UTC")).toEqual([
      { role: "user", content: "[2026-07-17 12:00] hi" },
    ]);
  });

  it("maps roles and prefixes user messages with an absolute timestamp", () => {
    const messages = buildConversationMessages(
      [
        { role: "user", content: "hello", createdAt: iso(2 * 86_400_000) },
        { role: "assistant", content: "hi there", createdAt: iso(5 * 60_000) },
      ],
      "how are you",
      NOW,
      "UTC",
    );

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-15 12:00] hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "[2026-07-17 12:00] how are you" },
    ]);
  });

  it("drops leading assistant messages so the array starts with a user turn", () => {
    const messages = buildConversationMessages(
      [
        { role: "assistant", content: "earlier reply", createdAt: iso(3 * 60_000) },
        { role: "user", content: "hi", createdAt: iso(2 * 60_000) },
      ],
      "now",
      NOW,
      "UTC",
    );

    expect(messages.map((m) => m.role)).toEqual(["user"]);
    expect(messages[0].content).toBe(
      "[2026-07-17 11:58] hi\n\n[2026-07-17 12:00] now",
    );
  });

  it("coalesces consecutive assistant messages", () => {
    const messages = buildConversationMessages(
      [
        { role: "user", content: "q", createdAt: iso(4 * 60_000) },
        { role: "assistant", content: "one", createdAt: iso(3 * 60_000) },
        { role: "assistant", content: "two", createdAt: iso(2 * 60_000) },
      ],
      "next",
      NOW,
      "UTC",
    );

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-17 11:56] q" },
      { role: "assistant", content: "one\n\ntwo" },
      { role: "user", content: "[2026-07-17 12:00] next" },
    ]);
  });

  it("coalesces the current message with a trailing user message", () => {
    const messages = buildConversationMessages(
      [{ role: "user", content: "first", createdAt: iso(2 * 60_000) }],
      "second",
      NOW,
      "UTC",
    );

    expect(messages).toEqual([
      {
        role: "user",
        content: "[2026-07-17 11:58] first\n\n[2026-07-17 12:00] second",
      },
    ]);
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
        fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
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
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "read big",
    });

    expect(result.transcript).toContain("…[truncated]");
    expect(result.transcript.length).toBeLessThan(big.length);
  });

  it("views a stored image via view_attachment and answers", async () => {
    const store = new MemoryStore();
    const attachments = createMemoryAttachments();
    const conv = store.getOrCreateConversation(1, 0);
    const r2Key = attachmentKey("user_1", "u2");
    store.putAttachment({
      id: "att_1",
      conversationId: conv,
      r2Key,
      filename: "cat.jpg",
      mimeType: "image/jpeg",
    });
    await attachments.put(r2Key, new Uint8Array([1, 2, 3]), "image/jpeg");
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "view_attachment", input: { id: "att_1" } }] },
      { tools: [{ name: "reply", input: { text: "It's a cat." } }] },
      { text: "" },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      attachments,
      getAttachment: (id) => store.getAttachment(id),
      history: [],
      userMessage: 'what is this? [image "cat.jpg" id=att_1]',
    });

    expect(result.replies).toEqual(["It's a cat."]);
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
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "tell me about ghost",
    });

    expect(result.accessed).toEqual([]);
  });
});
