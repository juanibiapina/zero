import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MESSAGE,
  buildConversationMessages,
  needsFallback,
  formatTimestamp,
  runInterfaceAgent,
} from "./interface";
import {
  interfaceContext,
  interfaceSystemPrompt,
  renderPinnedTopics,
} from "./prompts";
import { capturingModel, scriptedModel } from "./mock-model";
import { isCacheable } from "./protocol";
import type { AgentMessage, ContentBlock, TextBlock } from "./protocol";
import type { Topic } from "../store/types";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryGoogle } from "../google/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { createMemoryFileBlobs } from "../files/memory";
import { createUserFileStore } from "../files/store";
import { historyMessage, pinTopic, seedTopic, setBody } from "../store/test-support";

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

describe("needsFallback", () => {
  it("is false on a clean finish that sent something", () => {
    expect(needsFallback({ finishReason: "stop", sentCount: 1 })).toBe(false);
  });

  it("is true on a clean finish that said nothing all turn", () => {
    expect(needsFallback({ finishReason: "stop", sentCount: 0 })).toBe(true);
  });

  it("is true on a cap cut-off, even after an earlier message", () => {
    expect(needsFallback({ finishReason: "tool-calls", sentCount: 0 })).toBe(
      true,
    );
    expect(needsFallback({ finishReason: "tool-calls", sentCount: 2 })).toBe(
      true,
    );
  });
});

describe("interfaceSystemPrompt", () => {
  it("carries no per-minute time or timezone value (stays cross-user cacheable)", () => {
    const prompt = interfaceSystemPrompt();
    expect(prompt).not.toContain("Current time:");
    expect(prompt).not.toContain("The user's timezone is");
    expect(prompt).not.toContain("your country code is");
  });

  // A budget, not a measurement. The prompt is paid for on every turn and its
  // last three quarters are the shared topic-write rules, so anything the
  // interface adds about itself has to earn room. Most of what used to sit here
  // restated a tool description or told an assistant how to be an assistant;
  // this ceiling is what stops that coming back one sentence at a time.
  it("stays small: instructions the tools and the Zero topic do not already carry", () => {
    expect(interfaceSystemPrompt().length).toBeLessThan(4000);
  });

  it("says nothing the tool descriptions and tool errors already say", () => {
    const prompt = interfaceSystemPrompt();
    // Schedules, Google and the file send/delete gates live on the tools.
    expect(prompt).not.toContain("create_schedule");
    expect(prompt).not.toContain("Gmail");
    expect(prompt).not.toContain("set_country");
    expect(prompt).not.toContain("set_timezone");
  });

  it("folds pinned topics onto the tail when present, absent when empty", () => {
    expect(interfaceSystemPrompt()).not.toContain("Pinned topics");
    const withPinned = interfaceSystemPrompt("\n\n## Pinned topics\n\nbody");
    expect(withPinned).toContain("Pinned topics");
    expect(withPinned.endsWith("body")).toBe(true);
  });

  it("routes a given web address to read_page and wider questions to web_search", () => {
    const prompt = interfaceSystemPrompt();
    expect(prompt).toContain("read_page");
    expect(prompt).toContain("web_search");
  });

  // These rules used to live in a separate research agent's prompt. With the
  // searching in this loop, this prompt is the only place that can carry them.
  it("carries the investigation discipline the research prompt used to hold", () => {
    const prompt = interfaceSystemPrompt();
    expect(prompt).toContain("cast a wide net");
    expect(prompt).toContain("stop changing the answer");
    expect(prompt).toContain("Source: <url>");
    expect(prompt).toContain("Say you are looking");
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

  it("names the user's country next to the timezone", () => {
    expect(interfaceContext(NOW, "America/Sao_Paulo", "BR")).toContain(
      "Your timezone is America/Sao_Paulo and your country code is BR (Brazil)",
    );
  });

  it("renders a code with no country name bare", () => {
    const context = interfaceContext(NOW, "UTC", "QQ");
    expect(context).toContain("your country code is QQ;");
    expect(context).not.toContain("QQ (");
  });

  it("says so when the country is unknown", () => {
    expect(interfaceContext(NOW)).toContain("your country code is not set");
  });
});

const topic = (name: string, body: string, pinned = true): Topic => ({
  name,
  description: "",
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
    const block = renderPinnedTopics([topic("User", "x".repeat(1500))]);
    expect(block).toContain("…[truncated]");
    expect(block.length).toBeLessThan(1500);
  });
});

describe("runInterfaceAgent pinned surfacing", () => {
  it("includes a pinned topic's body in the system prompt", async () => {
    const store = new MemoryStore();
    seedTopic(store, "User", "identity");
    setBody(store, "User", "name: Alice; city: Berlin");
    pinTopic(store, "User", true);

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
  // Thinking blocks have no `cache_control` field at all, which is the point.
  const cc = (m: AgentMessage | undefined) => {
    if (!m || typeof m.content === "string") return undefined;
    const last = m.content[m.content.length - 1];
    return last && isCacheable(last) ? last.cache_control : undefined;
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

  it("caches the system prompt", async () => {
    const { system } = await capturePrompt({});
    expect(system?.[system.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  // The runner marks every markable message, so the turn's history is marked
  // without the interface placing an anchor of its own. Assistant replies stay
  // unmarked: only an input block can carry a breakpoint.
  it("marks every input message in the conversation", async () => {
    const { messages = [] } = await capturePrompt({
      history: [
        historyMessage("user", "q", iso(5 * 60_000)),
        historyMessage("assistant", "a", iso(4 * 60_000)),
      ],
    });
    expect(cc(messages[0])).toBeTruthy();
    expect(cc(messages[1])).toBeFalsy();
    expect(cc(messages[messages.length - 1])).toBeTruthy();
  });

  it("marks the single current message when history is empty", async () => {
    const { messages = [] } = await capturePrompt({});
    expect(messages).toHaveLength(1);
    expect(cc(messages[0])).toBeTruthy();
  });
});

describe("buildConversationMessages", () => {
  const text = (t: string) => [{ type: "text", text: t }];

  it("returns a single user message for empty history", () => {
    expect(
      buildConversationMessages({
        history: [],
        userMessage: "hi",
        now: NOW,
        timezone: "UTC",
      }),
    ).toEqual([{ role: "user", content: "[2026-07-17 12:00] hi" }]);
  });

  it("prefixes user messages with a timestamp and keeps assistant blocks verbatim", () => {
    const messages = buildConversationMessages({
      history: [
        historyMessage("user", "hello", iso(2 * 86_400_000)),
        historyMessage("assistant", "hi there", iso(5 * 60_000)),
      ],
      userMessage: "how are you",
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-15 12:00] hello" },
      { role: "assistant", content: text("hi there") },
      { role: "user", content: "[2026-07-17 12:00] how are you" },
    ]);
  });

  it("prepends the volatile per-turn context to the message being answered", () => {
    const messages = buildConversationMessages({
      history: [],
      userMessage: "hi",
      now: NOW,
      timezone: "UTC",
      context: "Current time: whenever.",
    });

    expect(messages).toEqual([
      {
        role: "user",
        content: "Current time: whenever.\n\n[2026-07-17 12:00] hi",
      },
    ]);
  });

  it("replays a tool call and its result verbatim, results first in the user turn", () => {
    const toolUse = {
      type: "tool_use" as const,
      id: "call_1",
      name: "get_topic",
      input: { name: "weather" },
    };
    const toolResult = {
      type: "tool_result" as const,
      tool_use_id: "call_1",
      content: '{"version":1}',
    };
    const messages = buildConversationMessages({
      history: [
        historyMessage("user", "weather?", iso(60_000)),
        historyMessage("assistant", [{ type: "text", text: "checking" }, toolUse], iso(50_000)),
        historyMessage("user", [toolResult], iso(40_000), {
          kind: "tool_result",
        }),
        historyMessage("assistant", "sunny", iso(30_000)),
      ],
      userMessage: "and tomorrow",
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-17 11:59] weather?" },
      {
        role: "assistant",
        content: [{ type: "text", text: "checking" }, toolUse],
      },
      { role: "user", content: [toolResult] },
      { role: "assistant", content: text("sunny") },
      { role: "user", content: "[2026-07-17 12:00] and tomorrow" },
    ]);
  });

  it("appends the rows an interrupted run of this turn already persisted", () => {
    const toolUse = {
      type: "tool_use" as const,
      id: "call_9",
      name: "list_topics",
      input: {},
    };
    const messages = buildConversationMessages({
      history: [],
      userMessage: "hi",
      trailing: [historyMessage("assistant", [toolUse], iso(1000))],
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-17 12:00] hi" },
      { role: "assistant", content: [toolUse] },
    ]);
  });

  it("keeps a leading assistant message instead of dropping the reply", () => {
    const messages = buildConversationMessages({
      history: [
        historyMessage("assistant", "earlier reply", iso(3 * 60_000)),
        historyMessage("user", "hi", iso(2 * 60_000)),
      ],
      userMessage: "now",
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "assistant", content: text("earlier reply") },
      { role: "user", content: "[2026-07-17 11:58] hi" },
      { role: "user", content: "[2026-07-17 12:00] now" },
    ]);
  });

  it("opens with the compacted summary as a user message", () => {
    const messages = buildConversationMessages({
      history: [historyMessage("assistant", "reply after boundary", iso(2 * 60_000))],
      userMessage: "now",
      now: NOW,
      timezone: "UTC",
      summary: "earlier: they picked a flight",
    });

    expect(messages).toEqual([
      {
        role: "user",
        content:
          "[summary of earlier conversation]\n\nearlier: they picked a flight",
      },
      { role: "assistant", content: text("reply after boundary") },
      { role: "user", content: "[2026-07-17 12:00] now" },
    ]);
  });

  it("renders consecutive assistant rows as separate messages", () => {
    const messages = buildConversationMessages({
      history: [
        historyMessage("user", "q", iso(4 * 60_000)),
        historyMessage("assistant", "one", iso(3 * 60_000)),
        historyMessage("assistant", "two", iso(2 * 60_000)),
      ],
      userMessage: "next",
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-17 11:56] q" },
      { role: "assistant", content: text("one") },
      { role: "assistant", content: text("two") },
      { role: "user", content: "[2026-07-17 12:00] next" },
    ]);
  });

  it("keeps the current message separate from the preceding user row", () => {
    const messages = buildConversationMessages({
      history: [historyMessage("user", "first", iso(2 * 60_000))],
      userMessage: "second",
      now: NOW,
      timezone: "UTC",
    });

    expect(messages).toEqual([
      { role: "user", content: "[2026-07-17 11:58] first" },
      { role: "user", content: "[2026-07-17 12:00] second" },
    ]);
  });

  // The property the append-only rule exists for: what turn N sent must still be
  // what turn N+1 sends for the same rows, or the cross-turn prefix cache breaks.
  it("renders turn N's history as an unchanged prefix of turn N+1's", () => {
    const history = [
      historyMessage("user", "q", iso(4 * 60_000)),
      historyMessage("assistant", "a", iso(3 * 60_000)),
    ];
    const turnN = buildConversationMessages({
      history,
      userMessage: "next",
      now: NOW,
      timezone: "UTC",
    });
    const turnNPlus1 = buildConversationMessages({
      history: [
        ...history,
        historyMessage("user", "next", iso(2 * 60_000)),
        historyMessage("assistant", "b", iso(60_000)),
      ],
      userMessage: "third",
      now: NOW,
      timezone: "UTC",
    });

    // Every message of turn N except its volatile tail (the current message,
    // which carries the per-turn context) reappears byte-identical.
    expect(turnNPlus1.slice(0, turnN.length - 1)).toEqual(
      turnN.slice(0, turnN.length - 1),
    );
  });
});

describe("runInterfaceAgent", () => {
  it("sends each text block immediately and collects them", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      {
        text: "Got it, let me check.",
        tools: [{ name: "list_topics", input: {} }],
      },
      { text: "Here is the answer." },
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

  // The user gets the answer, not the reasoning: thinking is persisted so the
  // model can pick its own reasoning back up, and never delivered.
  it("persists the model's reasoning but sends only its text", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const persisted: ContentBlock[][] = [];
    const model = scriptedModel([
      {
        thinking: "",
        text: "Checking.",
        tools: [{ name: "list_topics", input: {} }],
      },
      { thinking: "", text: "Here is the answer." },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      persistAssistant: (content) => {
        persisted.push(content);
        return persisted.length;
      },
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "hi",
    });

    expect(result.replies).toEqual(["Checking.", "Here is the answer."]);
    expect(sink.sent).toEqual(["Checking.", "Here is the answer."]);
    expect(persisted[0][0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "sig-0",
    });
    expect(persisted[1][0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "sig-1",
    });
  });

  it("tracks accessed topics from get/create/update", async () => {
    const store = new MemoryStore();
    seedTopic(store, "weather", "climate");
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "get_topic", input: { name: "weather" } }] },
      {
        tools: [
          {
            name: "create_topic",
            input: {
              expectedVersion: store.getKnowledgeVersion(),
              name: "travel",
              description: "trips",
              body: "notes",
            },
          },
        ],
      },
      { text: "ok" },
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

  it("says it is looking, searches, then answers from what it found", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    const model = scriptedModel([
      // One loop: the acknowledgement and the answer are both this agent's
      // own text blocks, with the search in between.
      {
        text: "Let me check.",
        tools: [{ name: "web_search", input: { query: "distance to Mars" } }],
      },
      { text: "Mars is far. Source: https://ex.com/mars" },
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

  // Brave bills per query and the loop can fan out several searches per step,
  // so `steps` says nothing about spend. This rollup used to sit on
  // `research_completed`; the searching moved, so it moved with it.
  it("reports the turn's search tally on interface_completed", async () => {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args[0] as Record<string, unknown>);
    });
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    const model = scriptedModel([
      { tools: [{ name: "web_search", input: { query: "distance to Mars" } }] },
      { tools: [{ name: "web_search", input: { query: "Mars orbit" } }] },
      { tools: [{ name: "web_search", input: { query: "Mars orbit" } }] },
      { text: "Mars is far. Source: https://ex.com/mars" },
    ]);

    await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search,
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "how far is Mars",
    });

    const done = lines.find((l) => l.msg === "interface_completed");
    expect(done).toMatchObject({
      searches: 3,
      unique_queries: 2,
      searches_failed: 0,
      searches_empty: 0,
    });
    expect(typeof done?.search_ms_total).toBe("number");
  });

  it("surfaces a topic read for context on a searching turn via accessed", async () => {
    const store = new MemoryStore();
    seedTopic(store, "Mars", "the planet");
    setBody(store, "Mars", "Mars is far. Source: https://ex.com/mars");
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    const model = scriptedModel([
      // Read the existing topic for context, then search on top of it.
      {
        text: "Let me check.",
        tools: [{ name: "get_topic", input: { name: "Mars" } }],
      },
      { tools: [{ name: "web_search", input: { query: "distance to Mars" } }] },
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

    // Searching writes nothing; the stored body is unchanged.
    expect(store.getTopic("Mars")?.body).toBe(
      "Mars is far. Source: https://ex.com/mars",
    );
    // The topic read for context still reaches the writer via accessed.
    expect(result.accessed).toContain("Mars");
  });

  it("reads a page directly and answers from it, without searching", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      {
        text: "Let me look.",
        tools: [{ name: "read_page", input: { url: "thing.com/post" } }],
      },
      { text: "The post announces a new release." },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher({
        "thing.com/post": "# Release\n\nWe shipped a new version.",
      }),
      history: [],
      userMessage: "check thing.com/post",
    });

    expect(result.replies).toEqual([
      "Let me look.",
      "The post announces a new release.",
    ]);
  });

  it("answers clearly after a failed direct read", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "read_page", input: { url: "ftp://thing.com" } }] },
      { text: "I couldn't open that address." },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: {
        fetch: async () => {
          throw new Error("page fetch failed: invalid web address");
        },
      },
      history: [],
      userMessage: "read ftp://thing.com",
    });

    expect(result.replies).toEqual(["I couldn't open that address."]);
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

  it("routes set_country through to the setter", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const setCountry = vi.fn();
    const model = scriptedModel([
      { tools: [{ name: "set_country", input: { country: "PT" } }] },
      { text: "Done, I've updated your country." },
    ]);

    await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      setCountry,
      history: [],
      userMessage: "I moved to Portugal",
    });

    expect(setCountry).toHaveBeenCalledWith("PT");
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
              attachments: [],
            },
          ],
        },
      },
    });
    const model = scriptedModel([
      { tools: [{ name: "gmail_search", input: { query: "from:a" } }] },
      { tools: [{ name: "gmail_thread", input: { threadId: "T1" } }] },
      { text: "Your last mail from a@x.com asks about lunch." },
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

  it("drafts a reply and archives the thread, without sending anything", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const google = createMemoryGoogle({
      labels: ["Receipts"],
      threadLabels: { T1: ["INBOX", "UNREAD"] },
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
              attachments: [],
            },
          ],
        },
      },
    });
    const model = scriptedModel([
      { tools: [{ name: "gmail_thread", input: { threadId: "T1" } }] },
      {
        tools: [
          {
            name: "gmail_draft",
            input: {
              to: "a@x.com",
              subject: "Re: Lunch?",
              body: "Yes, Thursday works.",
              replyTo: { messageIdHeader: "<abc@mail>", threadId: "T1" },
            },
          },
        ],
      },
      {
        tools: [
          { name: "gmail_modify_thread", input: { threadId: "T1", remove: ["INBOX"] } },
        ],
      },
      { text: "Drafted a reply and archived the thread. Say the word and I'll send it." },
    ]);

    await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google,
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "draft a yes to that lunch mail and get it out of my inbox",
    });

    expect(google.savedDrafts).toHaveLength(1);
    expect(google.savedDrafts[0].replyTo?.threadId).toBe("T1");
    expect(google.modifications).toEqual([
      { threadId: "T1", add: [], remove: ["INBOX"] },
    ]);
    // Drafting is not sending: nothing left the mailbox.
    expect(google.sentMail).toEqual([]);
    expect(google.sentDrafts).toEqual([]);
  });

  it("persists the response, then claims the block, then sends it", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const model = scriptedModel([{ text: "hi" }]);

    await runInterfaceAgent({
      model,
      store,
      send: async (t) => void order.push(`send:${t}`),
      persistAssistant: (content) => {
        order.push(`persist:${JSON.stringify(content)}`);
        return 7;
      },
      claimDelivery: (messageId, blockIndex) => {
        order.push(`claim:${messageId}:${blockIndex}`);
        return true;
      },
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "x",
    });

    expect(order).toEqual([
      'persist:[{"type":"text","text":"hi"}]',
      "claim:7:0",
      "send:hi",
    ]);
  });

  it("stays quiet on a block a previous run already claimed", async () => {
    const store = new MemoryStore();
    const sent: string[] = [];
    const model = scriptedModel([{ text: "hi" }]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: async (t) => void sent.push(t),
      persistAssistant: () => 7,
      claimDelivery: () => false,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "x",
    });

    // Nothing sent, so the no-silence rule fires and the fallback is delivered
    // through the same claim path (which this stub also refuses).
    expect(sent).toEqual([]);
    expect(result.replies).toEqual([]);
  });

  it("sends the text of an interrupted run's response that never got out", async () => {
    const store = new MemoryStore();
    const sent: string[] = [];
    const claimed = new Set<string>(["11:0"]);
    const model = scriptedModel([{ text: "and here it is" }]);

    await runInterfaceAgent({
      model,
      store,
      send: async (t) => void sent.push(t),
      persistAssistant: () => 12,
      claimDelivery: (messageId, blockIndex) => {
        const key = `${messageId}:${blockIndex}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "x",
      trailing: [
        historyMessage(
          "assistant",
          [
            { type: "text", text: "already sent" },
            { type: "text", text: "never sent" },
          ],
          iso(1000),
          { id: 11 },
        ),
      ],
    });

    expect(sent).toEqual(["never sent", "and here it is"]);
  });

  it("persists the prose fallback before sending it", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    const model = scriptedModel([{ text: "" }]);

    await runInterfaceAgent({
      model,
      store,
      send: async (t) => void order.push(`send:${t}`),
      persistAssistant: (content) => {
        order.push(`persist:${JSON.stringify(content)}`);
        return 3;
      },
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      history: [],
      userMessage: "x",
    });

    expect(order).toEqual([
      'persist:[{"type":"text","text":""}]',
      `persist:[{"type":"text","text":${JSON.stringify(FALLBACK_MESSAGE)}}]`,
      `send:${FALLBACK_MESSAGE}`,
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

  it("sends the fallback after an ack message when the loop hits the step cap", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      {
        text: "Let me check.",
        tools: [{ name: "get_topic", input: { name: "y" } }],
      },
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

  it("delivers the final message even after an earlier one", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const model = scriptedModel([
      { text: "the answer", tools: [{ name: "list_topics", input: {} }] },
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

  it("delivers the post-search answer sent as final prose after an ack reply", async () => {
    const store = new MemoryStore();
    const sink = collectSink();
    const search = createMemorySearch([
      { title: "Mars", url: "https://ex.com/mars", snippet: "red planet" },
    ]);
    // Model acks, searches, then answers in its final text. Both are
    // messages, in order.
    const model = scriptedModel([
      {
        text: "Searching now...",
        tools: [{ name: "web_search", input: { query: "distance to Mars" } }],
      },
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

  it("re-raises when a send fails and still persists before sending", async () => {
    const store = new MemoryStore();
    const persisted: string[] = [];
    const model = scriptedModel([{ text: "undelivered" }, { text: "done" }]);

    await expect(
      runInterfaceAgent({
        model,
        store,
        send: async () => {
          throw new Error("telegram down");
        },
        persistAssistant: (content) => {
          persisted.push(JSON.stringify(content));
          return 1;
        },
        search: createMemorySearch(),
        google: createMemoryGoogle(),
        fetcher: createMemoryFetcher(),
        history: [],
        userMessage: "hi",
      }),
    ).rejects.toThrow("telegram down");

    // Persist-before-send preserved even though the send failed.
    expect(persisted).toEqual(['[{"type":"text","text":"undelivered"}]']);
  });

  it("views a stored image via view_attachment and answers", async () => {
    const store = new MemoryStore();
    const blobs = createMemoryFileBlobs();
    const r2Key = "attachments/user_1/u2";
    store.putFile({
      id: "att_1",
      storageKey: r2Key,
      filename: "cat.jpg",
      mimeType: "image/jpeg",
      byteSize: null,
    });
    await blobs.put(r2Key, new Uint8Array([1, 2, 3]), "image/jpeg");
    const files = createUserFileStore({ clerkUserId: "user_1", records: store, blobs });
    const sink = collectSink();
    const model = scriptedModel([
      { tools: [{ name: "view_attachment", input: { id: "att_1" } }] },
      { text: "It's a cat." },
    ]);

    const result = await runInterfaceAgent({
      model,
      store,
      send: sink.send,
      search: createMemorySearch(),
      google: createMemoryGoogle(),
      fetcher: createMemoryFetcher(),
      files,
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
