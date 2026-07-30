import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "./orchestrator";
import { FALLBACK_MESSAGE } from "./interface";
import { RATE_LIMIT_MESSAGE } from "./llm-error";
import { capturingModel, scriptedModel } from "./mock-model";
import type { AgentModel } from "./protocol";
import { MemoryStore } from "../store/memory";
import {
  LEARN_SIZE_THRESHOLD_TOKENS,
  messageText,
} from "../store/messages";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { createMemoryGoogle } from "../google/memory";
import { seedTopic } from "../store/test-support";

const collectSink = () => {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
};

// A makeModel factory that hands the same model to every agent, so a single
// scripted sequence is shared across interface + writer exactly as one model
// was before per-agent tagging.
const constModel = (model: AgentModel) => () => model;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTurn", () => {
  it("no-ops when the thread tail is not a user message", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    store.storeMessage(id, "assistant", "hello");
    const sink = collectSink();

    await runTurn({
      store,
      makeModel: constModel(scriptedModel([])),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual([]);
  });

  it("runs the interface agent and persists what it sent", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    await runTurn({
      store,
      makeModel: constModel(scriptedModel([
        { text: "hello there" },
        // writer runs every turn; trivial exchange → no tool call.
        { text: "nothing to consolidate" },
      ])),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual(["hello there"]);
    const history = store
      .getConversationHistory(id, 10)
      .map(({ role, content }) => ({ role, content: messageText(content) }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
    // No topics accessed → thread tail is now assistant, not awaiting reply.
    expect(store.findConversationsWithWork()).toEqual([]);
  });

  it("does not resend when the alarm re-fires after a completed turn", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    const run = () =>
      runTurn({
        store,
        makeModel: constModel(scriptedModel([
          { text: "hello there" },
          // writer runs every turn; trivial exchange → no tool call.
          { text: "nothing to consolidate" },
        ])),
        send: sink.send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      });

    await run();
    // Reply persisted → tail is assistant → the thread no longer awaits reply,
    // so a re-fired alarm re-runs the turn as a no-op (no duplicate send).
    expect(store.findConversationsWithWork()).toEqual([]);
    await run();

    expect(sink.sent).toEqual(["hello there"]);
  });

  it("stops the typing indicator as soon as the reply is sent", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    // Record the order of key events: when the reply reaches the user and when
    // typing stops. Nothing runs after the reply any more, so the indicator must
    // stop right behind it.
    const events: string[] = [];
    const origSend = sink.send;
    const send = async (t: string) => {
      events.push("reply");
      await origSend(t);
    };
    const stopTyping = () => events.push("stopTyping");
    const makeModel = () => scriptedModel([{ text: "hello there" }]);

    await runTurn({
      store,
      makeModel,
      send,
      stopTyping,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(events).toEqual(["reply", "stopTyping"]);
    // And it is not left running past the turn: exactly one stop.
    expect(events.filter((e) => e === "stopTyping")).toHaveLength(1);
  });

  it("stops the typing indicator on the failure path, after the fallback is sent", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const events: string[] = [];
    const send = async (t: string) => {
      events.push(`send:${t === FALLBACK_MESSAGE ? "fallback" : "other"}`);
      sink.sent.push(t);
    };
    const stopTyping = () => events.push("stopTyping");

    // Interface agent throws before any reply, so the orchestrator sends the
    // fallback; typing must still stop.
    const model = capturingModel(() => {
      throw new Error("gateway down");
    });

    await runTurn({
      store,
      makeModel: constModel(model),
      send,
      stopTyping,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(events).toEqual(["send:fallback", "stopTyping"]);
  });

  it("does not consolidate topics on the turn path", async () => {
    const store = new MemoryStore();
    seedTopic(store, "travel", "trips");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "I'm going to Rome");
    const sink = collectSink();
    // One reply and nothing else: a second scripted step would throw
    // ("ran out of steps") if anything ran after the interface agent.
    await runTurn({
      store,
      makeModel: constModel(
        scriptedModel([
          { tools: [{ name: "get_topic", input: { name: "travel" } }] },
          { text: "Have fun!" },
        ]),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual(["Have fun!"]);
    // Consolidation happens in LearningDO, per idle period or size threshold.
    expect(store.getTopic("travel")?.body).toBe("");
  });

  it("delivers a fallback and logs turn_failed when a reply send fails", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // The transport is down for the model's reply but recovers for the
    // fallback, so the user still gets told the turn failed.
    const sent: string[] = [];
    const send = async (text: string) => {
      if (text !== FALLBACK_MESSAGE) throw new Error("telegram down");
      sent.push(text);
    };

    await expect(
      runTurn({
        store,
        makeModel: constModel(scriptedModel([
          { text: "undelivered" },
          { text: "done" },
        ])),
        send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      }),
    ).resolves.toBeUndefined();

    expect(sent).toEqual([FALLBACK_MESSAGE]);
    // The undelivered reply was persisted (persist-before-send) before the
    // send failed, so it remains in history alongside the fallback.
    expect(
      store
        .getConversationHistory(id, 10)
        .map(({ role, content }) => ({ role, content: messageText(content) })),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "undelivered" },
      { role: "assistant", content: FALLBACK_MESSAGE },
    ]);
    expect(store.findConversationsWithWork()).toEqual([]);
    const events = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_failed")).toBe(true);
  });

  it("delivers a fallback, persists it, clears busy, and logs turn_failed when the agent throws", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // A model whose generate call rejects: the throw propagates out of the
    // interface agent and must be caught by the orchestrator.
    const model = capturingModel(() => {
      throw new Error("gateway down");
    });

    await expect(
      runTurn({
        store,
        makeModel: constModel(model),
        send: sink.send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      }),
    ).resolves.toBeUndefined();

    expect(sink.sent).toEqual([FALLBACK_MESSAGE]);
    const history = store
      .getConversationHistory(id, 10)
      .map(({ role, content }) => ({ role, content: messageText(content) }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: FALLBACK_MESSAGE },
    ]);
    // Fallback persisted → thread tail is assistant, no longer awaiting reply.
    expect(store.findConversationsWithWork()).toEqual([]);
    const events = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_failed")).toBe(true);
  });

  it("rethrows a DO reset (property set), sending and persisting nothing", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // The isolate reset surfaces at a storage syscall (persistReply). Model it
    // as a throw carrying the workerd reset markers.
    const model = capturingModel(() => {
      throw Object.assign(
        new Error("Durable Object reset because its code was updated."),
        { durableObjectReset: true, retryable: true },
      );
    });

    await expect(
      runTurn({
        store,
        makeModel: constModel(model),
        send: sink.send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      }),
    ).rejects.toThrow(/reset/);

    // Nothing sent, nothing persisted: the tail stays `user` so the platform
    // alarm retry re-runs the turn cleanly.
    expect(sink.sent).toEqual([]);
    expect(
      store
        .getConversationHistory(id, 10)
        .map(({ role, content }) => ({ role, content: messageText(content) })),
    ).toEqual([{ role: "user", content: "hi" }]);
    expect(store.findConversationsWithWork()).toHaveLength(1);
    // The defer is logged; the failure event is not.
    const infoEvents = logSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(infoEvents.some((e) => e.msg === "turn_reset_retrying")).toBe(true);
    const errEvents = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(errEvents.some((e) => e.msg === "turn_failed")).toBe(false);
  });

  it("rethrows a DO reset detected by message string alone", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // No durableObjectReset property: only the canonical message string.
    const model = capturingModel(() => {
      throw new Error(
        "Durable Object reset because its code was updated.",
      );
    });

    await expect(
      runTurn({
        store,
        makeModel: constModel(model),
        send: sink.send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      }),
    ).rejects.toThrow(/reset/);

    expect(sink.sent).toEqual([]);
    expect(
      store
        .getConversationHistory(id, 10)
        .map(({ role, content }) => ({ role, content: messageText(content) })),
    ).toEqual([{ role: "user", content: "hi" }]);
    expect(store.findConversationsWithWork()).toHaveLength(1);
  });

  it("delivers the rate-limit message and logs turn_rate_limited on a 429", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Thrown at the model seam (above the HTTP client), so nothing retries;
    // it carries status 429 for the classifier to key on.
    const model = capturingModel(() => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });

    await expect(
      runTurn({
        store,
        makeModel: constModel(model),
        send: sink.send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      }),
    ).resolves.toBeUndefined();

    expect(sink.sent).toEqual([RATE_LIMIT_MESSAGE]);
    const history = store
      .getConversationHistory(id, 10)
      .map(({ role, content }) => ({ role, content: messageText(content) }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: RATE_LIMIT_MESSAGE },
    ]);
    // Reply persisted → thread tail is assistant, no longer awaiting reply.
    expect(store.findConversationsWithWork()).toEqual([]);
    const events = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_rate_limited")).toBe(true);
    expect(events.some((e) => e.msg === "turn_failed")).toBe(false);
  });

  it("requests interface and research models from the factory", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    const requested: string[] = [];
    const shared = scriptedModel([{ text: "hi back" }]);
    const makeModel = (agent: string) => {
      requested.push(agent);
      return shared;
    };

    await runTurn({
      store,
      makeModel: makeModel,
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    // The interface agent and its research tool each pull a tagged model.
    expect(requested).toContain("interface");
    expect(requested).toContain("research");
    expect(requested).not.toContain("writer");
  });

  it("gives each agent its own in-run cache-diagnostic chain", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    // Record, per agent, the previousMessageId each request carried.
    const chains: Record<string, Array<string | null | undefined>> = {};
    let counter = 0;
    const makeModel = (agent: string): AgentModel => ({
      modelId: "mock-model",
      generate: async (request) => {
        (chains[agent] ??= []).push(request.previousMessageId);
        return {
          id: `msg_${agent}_${counter++}`,
          content: [{ type: "text", text: "" }],
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          diagnostic: { state: "initial" },
        };
      },
    });

    await runTurn({
      store,
      makeModel,
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    // The interface agent opens its chain with null on a fresh conversation, and
    // no other agent runs on the turn path to inherit it.
    expect(chains.interface).toEqual([null]);
    expect(Object.keys(chains)).toEqual(["interface"]);
  });

  it("chains the next turn's first request to the previous turn's response", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    const chain: Array<{ previous: string | null | undefined; crossRun?: boolean }> = [];
    let counter = 0;
    const makeModel = (agent: string): AgentModel => ({
      modelId: "mock-model",
      generate: async (request) => {
        if (agent === "interface")
          chain.push({ previous: request.previousMessageId, crossRun: request.crossRun });
        return {
          id: `msg_${agent}_${counter++}`,
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          diagnostic: { state: "initial" },
        };
      },
    });
    const turn = () =>
      runTurn({
        store,
        makeModel,
        send: collectSink().send,
        search: createMemorySearch(),
        fetcher: createMemoryFetcher(),
        google: createMemoryGoogle(),
        chatId: 1,
        topicId: 0,
      });

    store.storeMessage(id, "user", "first");
    await turn();
    store.storeMessage(id, "user", "second");
    await turn();

    expect(chain[0]).toEqual({ previous: null, crossRun: false });
    // The second turn's prefix extends the first turn's, so it is compared
    // against that response rather than starting a fresh chain.
    expect(chain[1]).toEqual({ previous: "msg_interface_0", crossRun: true });
  });
});

// Phase markers for stall diagnosis. A DO alarm invocation killed at the 900s
// wall-time ceiling throws nothing, so a stalled turn is identifiable only by
// which of these lines is missing. Their absence on the failure path is
// therefore as load-bearing as their presence on the happy path.
describe("runTurn phase markers", () => {
  it("logs turn_completed on a normal turn", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTurn({
      store,
      makeModel: () => scriptedModel([{ text: "hello there" }]),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    const msgs = logSpy.mock.calls
      .map((c) => (c[0] as { msg?: string }).msg)
      .filter((m): m is string => typeof m === "string");
    expect(msgs).toContain("interface_completed");
    expect(msgs).toContain("turn_completed");
    expect(msgs.indexOf("interface_completed")).toBeLessThan(
      msgs.indexOf("turn_completed"),
    );
    // The writer is gone from the turn path entirely.
    expect(msgs).not.toContain("writer_started");
  });

  it("shows the model the summary instead of the compacted messages", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "what about Rome");
    const boundary = store.storeMessage(id, "assistant", "Rome is warm");
    store.storeMessage(id, "user", "and Oslo");
    store.compactConversation(id, {
      throughMessageId: boundary,
      summary: "they discussed Rome",
    });
    const sink = collectSink();
    const requests: string[] = [];

    await runTurn({
      store,
      makeModel: constModel(
        capturingModel((request) => {
          requests.push(JSON.stringify(request.messages));
          return { content: [{ type: "text", text: "Oslo is cold" }] };
        }),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(requests[0]).toContain("they discussed Rome");
    expect(requests[0]).not.toContain("Rome is warm");
    expect(requests[0]).toContain("and Oslo");
  });

  it("carries history past the old 20-message window", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    for (let i = 0; i < 25; i++) {
      store.storeMessage(id, "user", `q${i}`);
      store.storeMessage(id, "assistant", `a${i}`);
    }
    store.storeMessage(id, "user", "last question");
    const sink = collectSink();
    const requests: string[] = [];

    await runTurn({
      store,
      makeModel: constModel(
        capturingModel((request) => {
          requests.push(JSON.stringify(request.messages));
          return { content: [{ type: "text", text: "ok" }] };
        }),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    // 51 rows, under the 60-message backstop, so the whole conversation is
    // rendered. The old fixed window would have cut everything before q15.
    expect(requests[0]).toContain("q0");
    expect(requests[0]).toContain("q24");
  });

  it("logs context_rendered with the rendered size and stale stub count", async () => {
    const store = new MemoryStore();
    seedTopic(store, "travel", "trips");
    const id = store.getOrCreateConversation(1, 0);
    // A persisted topic read taken at an older knowledge version.
    store.storeMessage(id, "assistant", [
      { type: "tool_use", id: "tu_1", name: "get_topic", input: { name: "travel" } },
    ], { stopReason: "tool_use" });
    store.storeMessage(
      id,
      "user",
      [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: JSON.stringify({ version: 0, topic: { name: "travel" } }),
        },
      ],
      { kind: "tool_result" },
    );
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTurn({
      store,
      makeModel: constModel(
        capturingModel(() => ({ content: [{ type: "text", text: "hello" }] })),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    const line = logSpy.mock.calls
      .map((c) => c[0] as { msg?: string; stale_stubs?: number; messages_after_boundary?: number; total_tokens?: number })
      .find((e) => e.msg === "context_rendered");
    expect(line).toMatchObject({ stale_stubs: 1, messages_after_boundary: 3 });
    expect(line?.total_tokens).toBeGreaterThan(0);
  });

  // turn_completed means "runTurn returned", not "the turn succeeded". A handled
  // agent failure still returns (it sends the fallback), and saying so is the
  // point: it distinguishes a failed turn from a stalled invocation. The phase
  // it never reached — the writer — is what the missing marker reports.
  it("logs turn_completed but not interface_completed when the turn fails", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTurn({
      store,
      makeModel: constModel(
        capturingModel(() => {
          throw new Error("gateway down");
        }),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    const msgs = logSpy.mock.calls.map((c) => (c[0] as { msg?: string }).msg);
    expect(msgs).toContain("turn_completed");
    // The phase that never finished leaves no completion line behind: that
    // absence is the diagnostic, since a killed invocation throws nothing.
    expect(msgs).not.toContain("interface_completed");
  });
});

describe("runTurn size trigger", () => {
  it("asks for learning once the rendered context crosses the threshold", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    // ~45k tokens is ~180k characters; the backstop keeps 150k of them, which is
    // still over the threshold.
    store.storeMessage(id, "user", "x".repeat(200_000));
    const requests: Array<[string, number]> = [];

    await runTurn({
      store,
      makeModel: constModel(
        scriptedModel([{ text: "ok" }, { text: "nothing to consolidate" }]),
      ),
      send: collectSink().send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
      onContextTooLarge: (conversationId, tokens) =>
        requests.push([conversationId, tokens]),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toBe(id);
    expect(requests[0][1]).toBeGreaterThanOrEqual(LEARN_SIZE_THRESHOLD_TOKENS);
  });

  it("stays quiet on an ordinary conversation", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const requests: string[] = [];

    await runTurn({
      store,
      makeModel: constModel(
        scriptedModel([{ text: "ok" }, { text: "nothing to consolidate" }]),
      ),
      send: collectSink().send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
      onContextTooLarge: (conversationId) => requests.push(conversationId),
    });

    expect(requests).toEqual([]);
  });
});

// Phase 1.3: the loop writes into the log as it goes, so a turn interrupted
// anywhere resumes from what is stored instead of replaying it.
describe("runTurn durable loop", () => {
  const runOne = (store: MemoryStore, model: AgentModel, send: (t: string) => Promise<void>) =>
    runTurn({
      store,
      makeModel: constModel(model),
      send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

  it("persists the response and its tool results in order", async () => {
    const store = new MemoryStore();
    seedTopic(store, "weather", "climate");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "weather?");
    const sink = collectSink();

    await runOne(
      store,
      scriptedModel([
        { text: "checking", tools: [{ name: "get_topic", input: { name: "weather" } }] },
        { text: "sunny" },
        { text: "nothing to consolidate" },
      ]),
      sink.send,
    );

    const rows = store.getConversationHistory(id, 10);
    expect(rows.map((r) => r.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ]);
    const call = rows[1].content;
    expect(Array.isArray(call) && call.some((b) => b.type === "tool_use")).toBe(true);
    const result = rows[2].content;
    expect(Array.isArray(result) && result[0].type === "tool_result").toBe(true);
    // Both replies out, and the conversation is idle again.
    expect(sink.sent).toEqual(["checking", "sunny"]);
    expect(store.findConversationsWithWork()).toEqual([]);
  });

  it("resumes a response whose tool results were never stored", async () => {
    const store = new MemoryStore();
    seedTopic(store, "weather", "climate");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "weather?");
    // What a reset between persisting a response and persisting its results
    // leaves behind: an assistant row with an unanswered tool call, and its
    // text already claimed for delivery.
    const messageId = store.storeMessage(
      id,
      "assistant",
      [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "call_1", name: "get_topic", input: { name: "weather" } },
      ],
      { stopReason: "tool_use" },
    );
    store.claimDelivery(messageId, 0);
    const sink = collectSink();

    expect(store.findConversationsWithWork()).toHaveLength(1);

    await runOne(
      store,
      scriptedModel([{ text: "sunny" }, { text: "nothing to consolidate" }]),
      sink.send,
    );

    // "checking" was already sent, so only the continuation reaches the user.
    expect(sink.sent).toEqual(["sunny"]);
    const rows = store.getConversationHistory(id, 10);
    expect(rows.map((r) => r.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ]);
    expect(store.findConversationsWithWork()).toEqual([]);
  });

  it("does not re-send mail a dead run had already started", async () => {
    const store = new MemoryStore();
    const google = createMemoryGoogle();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "email alice");
    store.storeMessage(
      id,
      "assistant",
      [
        {
          type: "tool_use",
          id: "call_send",
          name: "gmail_send",
          input: { to: "alice@x.com", subject: "hi", body: "hi" },
        },
      ],
      { stopReason: "tool_use" },
    );
    // The request left (or did not) and the reset landed before the result was
    // recorded.
    store.beginExternalCall("call_send", "gmail_send");
    const sink = collectSink();

    await runTurn({
      store,
      makeModel: constModel(
        scriptedModel([
          { text: "I'm not sure that email went out — check Gmail." },
          { text: "nothing to consolidate" },
        ]),
      ),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google,
      chatId: 1,
      topicId: 0,
    });

    expect(google.sentMail).toEqual([]);
    const rows = store.getConversationHistory(id, 10);
    expect(JSON.stringify(rows[2].content)).toContain("Do not retry it");
  });

  it("answers a message that arrives mid-run in the same run", async () => {
    const store = new MemoryStore();
    seedTopic(store, "weather", "climate");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "weather?");
    const sink = collectSink();

    // The follow-up lands while the model is working: queued during the tool
    // step, so it can only be injected at the first terminal stop.
    let step = 0;
    const model: AgentModel = {
      modelId: "mock",
      generate: async () => {
        step++;
        if (step === 1)
          return {
            id: "msg_1",
            content: [
              { type: "tool_use", id: "call_1", name: "get_topic", input: { name: "weather" } },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            diagnostic: { state: "initial" },
          };
        if (step === 2) {
          store.enqueuePendingMessage(id, "and tomorrow?");
          return {
            id: "msg_2",
            content: [{ type: "text", text: "sunny" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            diagnostic: { state: "initial" },
          };
        }
        return {
          id: `msg_${step}`,
          content: [{ type: "text", text: step === 3 ? "sunny then too" : "nothing to consolidate" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          diagnostic: { state: "initial" },
        };
      },
    };

    await runOne(store, model, sink.send);

    expect(sink.sent).toEqual(["sunny", "sunny then too"]);
    const rows = store.getConversationHistory(id, 10);
    expect(rows.map((r) => r.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(messageText(rows[4].content)).toBe("and tomorrow?");
    expect(store.findConversationsWithWork()).toEqual([]);
  });
});
