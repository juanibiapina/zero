// Both adapters must behave identically to the learner: the local one over a
// Store, and the remote one over a UserDO-shaped RPC. The remote adapter's job
// is to make the boundary invisible, so it is tested against the same
// expectations.

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory";
import { KnowledgeConflictError } from "../store/types";
import { seedTopic, setBody } from "../store/test-support";
import { createStoreLearningPort } from "./store-port";
import { createRemoteLearningPort, type LearningRpc } from "./remote-port";
import type { LearningPort } from "./types";

// A UserDO stand-in: the same flat RPC surface the Durable Object exposes,
// backed by a MemoryStore.
const rpcOver = (store: MemoryStore): LearningRpc => {
  const write = (apply: () => number) => {
    try {
      return { version: apply() };
    } catch (err) {
      if (err instanceof KnowledgeConflictError)
        return { conflict: { expected: err.expected, current: err.current } };
      return { failed: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    learnBeginJob: (jobId) => store.beginLearningJob(jobId),
    learnListMessages: (input) => store.listUnconsolidatedMessages(input),
    learnCompleteJob: (jobId) => store.completeLearningJob(jobId),
    learnGetContext: (conversationId, limit) => {
      const context = store.getConversationContext(conversationId, limit);
      return {
        summary: context.summary,
        messages: context.messages.map((m) => ({ ...m, conversationId })),
      };
    },
    learnCompactConversation: (conversationId, input) =>
      store.compactConversation(conversationId, input),
    learnKnowledgeVersion: () => store.getKnowledgeVersion(),
    learnListTopics: () => store.listTopics(),
    learnGetTopic: (name) => store.getTopic(name),
    learnGetOutboundLinks: (name) => store.getOutboundLinks(name),
    learnGetBacklinks: (name) => store.getBacklinks(name),
    learnCreateTopic: (input) => write(() => store.createTopic(input)),
    learnUpdateTopicBody: (input) => write(() => store.updateTopicBody(input)),
    learnUpdateTopicMetadata: (input) =>
      write(() => store.updateTopicMetadata(input)),
    learnDeleteTopic: (input) => write(() => store.deleteTopic(input)),
  };
};

const adapters: Array<[string, (store: MemoryStore) => LearningPort]> = [
  ["local store", (store) => createStoreLearningPort(store)],
  ["remote rpc", (store) => createRemoteLearningPort(rpcOver(store))],
];

describe.each(adapters)("learning port (%s)", (_name, build) => {
  it("freezes a job's range and consolidates only what it covered", async () => {
    const store = new MemoryStore();
    const port = build(store);
    const conv = store.getOrCreateConversation(1, 0);
    store.storeMessage(conv, "user", "one");

    const high = await port.beginJob("job_1");
    const later = store.storeMessage(conv, "user", "two");

    expect((await port.listMessages({ throughMessageId: high, limit: 10 })).map((m) => m.id)).toEqual([high]);
    await port.completeJob("job_1");
    expect(
      (await port.listMessages({ throughMessageId: later, limit: 10 })).map(
        (m) => m.id,
      ),
    ).toEqual([later]);
  });

  it("reads and writes topics through the versioned interface", async () => {
    const store = new MemoryStore();
    const port = build(store);
    const version = await port.topics.getKnowledgeVersion();

    const next = await port.topics.createTopic({
      expectedVersion: version,
      name: "weather",
      description: "climate",
      body: "Sunny.",
    });
    expect(next).toBe(version + 1);
    expect((await port.topics.getTopic("weather"))?.body).toBe("Sunny.");
    expect((await port.topics.listTopics()).map((t) => t.name)).toEqual([
      "weather",
    ]);
  });

  it("reports a stale write as a knowledge conflict, not a generic error", async () => {
    const store = new MemoryStore();
    const port = build(store);
    seedTopic(store, "weather", "climate");
    const stale = await port.topics.getKnowledgeVersion();
    // Someone else writes in between.
    setBody(store, "weather", "Rain.");

    // The IIFE turns the local adapter's synchronous throw into a rejection;
    // callers reach both through `await`, which is what the tools do.
    await expect(
      (async () =>
        port.topics.updateTopicBody({
          expectedVersion: stale,
          name: "weather",
          body: "Sunny.",
        }))(),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect(store.getTopic("weather")?.body).toBe("Rain.");
  });

  it("surfaces links so the learner sees the same graph a turn sees", async () => {
    const store = new MemoryStore();
    const port = build(store);
    seedTopic(store, "trip", "");
    setBody(store, "trip", "with [[weather]]");
    seedTopic(store, "weather", "");

    expect(await port.topics.getOutboundLinks("trip")).toEqual(["weather"]);
    expect((await port.topics.getBacklinks("weather")).map((t) => t.name)).toEqual([
      "trip",
    ]);
  });

  it("compacts one conversation without deleting the raw log", async () => {
    const store = new MemoryStore();
    const port = build(store);
    const conv = store.getOrCreateConversation(1, 0);
    const first = store.storeMessage(conv, "user", "one");
    store.storeMessage(conv, "assistant", "two");

    await port.compactConversation(conv, {
      throughMessageId: first,
      summary: "they said one",
    });

    const context = await port.getContext(conv, 10);
    expect(context.summary).toBe("they said one");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].conversationId).toBe(conv);
    // The raw rows are still there: learning reads them, rendering skips them.
    const high = await port.beginJob("job_1");
    expect(
      await port.listMessages({ throughMessageId: high, limit: 10 }),
    ).toHaveLength(2);
  });
});
