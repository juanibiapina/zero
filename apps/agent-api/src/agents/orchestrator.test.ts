import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "./orchestrator";
import { FALLBACK_MESSAGE } from "./interface";
import { RATE_LIMIT_MESSAGE } from "./llm-error";
import { capturingModel, scriptedModel } from "./mock-model";
import type { AgentModel } from "./protocol";
import { MemoryStore } from "../store/memory";
import { createMemorySearch } from "../websearch/memory";
import { createMemoryFetcher } from "../pagefetch/memory";
import { createMemoryGoogle } from "../google/memory";

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

  it("runs the interface agent, persists replies, and clears busy", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    await runTurn({
      store,
      makeModel: constModel(scriptedModel([
        { tools: [{ name: "reply", input: { text: "hello there" } }] },
        { text: "" },
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
      .map(({ role, content }) => ({ role, content }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
    // No topics accessed → thread tail is now assistant, not awaiting reply.
    expect(store.findThreadsAwaitingReply()).toEqual([]);
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
          { tools: [{ name: "reply", input: { text: "hello there" } }] },
          { text: "" },
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
    expect(store.findThreadsAwaitingReply()).toEqual([]);
    await run();

    expect(sink.sent).toEqual(["hello there"]);
  });

  it("consolidates accessed topics via the writer", async () => {
    const store = new MemoryStore();
    store.createTopic("travel", "trips");
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "I'm going to Rome");
    const sink = collectSink();

    await runTurn({
      store,
      makeModel: constModel(scriptedModel([
        // interface: read topic, then reply
        { tools: [{ name: "get_topic", input: { name: "travel" } }] },
        { tools: [{ name: "reply", input: { text: "Have fun!" } }] },
        { text: "" },
        // writer: read then revise the topic
        { tools: [{ name: "get_topic", input: { name: "travel" } }] },
        {
          tools: [
            {
              name: "update_topic",
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
      ])),
      send: sink.send,
      search: createMemorySearch(),
      fetcher: createMemoryFetcher(),
      google: createMemoryGoogle(),
      chatId: 1,
      topicId: 0,
    });

    expect(sink.sent).toEqual(["Have fun!"]);
    expect(store.getTopic("travel")?.body).toContain("Rome trip planned.");
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
          { tools: [{ name: "reply", input: { text: "undelivered" } }] },
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
        .map(({ role, content }) => ({ role, content })),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "undelivered" },
      { role: "assistant", content: FALLBACK_MESSAGE },
    ]);
    expect(store.findThreadsAwaitingReply()).toEqual([]);
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
      .map(({ role, content }) => ({ role, content }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: FALLBACK_MESSAGE },
    ]);
    // Fallback persisted → thread tail is assistant, no longer awaiting reply.
    expect(store.findThreadsAwaitingReply()).toEqual([]);
    const events = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_failed")).toBe(true);
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
      .map(({ role, content }) => ({ role, content }));
    expect(history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: RATE_LIMIT_MESSAGE },
    ]);
    // Reply persisted → thread tail is assistant, no longer awaiting reply.
    expect(store.findThreadsAwaitingReply()).toEqual([]);
    const events = errSpy.mock.calls.map((c) => c[0] as { msg: string });
    expect(events.some((e) => e.msg === "turn_rate_limited")).toBe(true);
    expect(events.some((e) => e.msg === "turn_failed")).toBe(false);
  });

  it("requests interface, research, and writer models from the factory", async () => {
    const store = new MemoryStore();
    const id = store.getOrCreateConversation(1, 0);
    store.storeMessage(id, "user", "hi");
    const sink = collectSink();

    const requested: string[] = [];
    const shared = scriptedModel([
      { tools: [{ name: "reply", input: { text: "hi back" } }] },
      { text: "" },
      { text: "nothing to consolidate" },
    ]);
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

    // Interface, its research tool, and the writer each pull a tagged model.
    expect(requested).toContain("interface");
    expect(requested).toContain("research");
    expect(requested).toContain("writer");
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

    // Each agent opts in with null on its own first request; no chain leaks
    // across the interface -> writer boundary.
    expect(chains.interface).toEqual([null]);
    expect(chains.writer).toEqual([null]);
  });
});
