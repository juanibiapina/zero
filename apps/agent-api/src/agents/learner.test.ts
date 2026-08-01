// The learner in slices, driven exactly as LearningDO drives it, over an
// in-memory port. The interesting cases are the ones a Durable Object cannot be
// asked to reproduce: a slice cut off by its step bound, and a kill after a
// topic write but before its result was checkpointed.

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory";
import { createStoreLearningPort } from "../learning/store-port";
import { seedTopic, setBody } from "../store/test-support";
import { renderLearningLog, runLearnerSlice, summarizeConversation } from "./learner";
import { capturingModel, scriptedModel } from "./mock-model";
import type { AgentMessage } from "./protocol";
import type { LearningMessage } from "../store/types";

const learningMessages = (store: MemoryStore, conversationId: string) =>
  store
    .getConversationHistory(conversationId, 50)
    .map((m): LearningMessage => ({ ...m, conversationId }));

// Drive slices the way LearningDO's alarm does: keep the wire log, call again
// while unfinished.
const runToCompletion = async (input: {
  store: MemoryStore;
  model: Parameters<typeof runLearnerSlice>[0]["model"];
  messages: LearningMessage[];
  maxSteps: number;
  maxSlices?: number;
}) => {
  const port = createStoreLearningPort(input.store);
  const wireLog: AgentMessage[] = [];
  let slices = 0;
  for (;;) {
    const result = await runLearnerSlice({
      model: input.model,
      port,
      messages: input.messages,
      wireLog: [...wireLog],
      maxSteps: input.maxSteps,
      onAssistant: async (content) => {
        wireLog.push({ role: "assistant", content });
      },
      onToolResults: async (results) => {
        wireLog.push({ role: "user", content: results });
      },
    });
    slices++;
    if (result.finished) return { slices, wireLog };
    if (slices >= (input.maxSlices ?? 5)) return { slices, wireLog };
  }
};

describe("renderLearningLog", () => {
  it("groups messages by conversation and keeps tool results, bounded", () => {
    const rendered = renderLearningLog([
      {
        id: 1,
        conversationId: "c1",
        role: "user",
        kind: "user_message",
        content: "book the flight",
        stopReason: null,
        responseId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 2,
        conversationId: "c1",
        role: "user",
        kind: "tool_result",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "x".repeat(5000) },
        ],
        stopReason: null,
        responseId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: 3,
        conversationId: "c2",
        role: "assistant",
        kind: "assistant_message",
        content: "done",
        stopReason: "end_turn",
        responseId: null,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);

    expect(rendered).toContain("## Conversation 1");
    expect(rendered).toContain("## Conversation 2");
    expect(rendered).toContain("User: book the flight");
    expect(rendered).toContain("[tool result]");
    expect(rendered).toContain("…[truncated]");
    expect(rendered).not.toContain("x".repeat(2001));
  });

  // The learner reads what happened, not how the model got there. A thinking
  // block is neither: it used to fall through to the "[image]" fallback and show
  // up as an attachment that never existed.
  it("leaves thinking blocks out of the log entirely", () => {
    const rendered = renderLearningLog([
      {
        id: 1,
        conversationId: "c1",
        role: "assistant",
        kind: "assistant_message",
        content: [
          { type: "thinking", thinking: "maybe Lisbon?", signature: "sig" },
          { type: "redacted_thinking", data: "encrypted" },
          { type: "text", text: "Booked." },
          { type: "tool_use", id: "call_1", name: "create_topic", input: {} },
        ],
        stopReason: "tool_use",
        responseId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(rendered).toContain("Booked.");
    expect(rendered).toContain("[called create_topic]");
    expect(rendered).not.toContain("[image]");
    expect(rendered).not.toContain("maybe Lisbon?");
    expect(rendered).not.toContain("sig");
  });
});

describe("runLearnerSlice", () => {
  it("consolidates into topics through the port", async () => {
    const store = new MemoryStore();
    const conv = store.getOrCreateConversation(1, 0);
    store.storeMessage(conv, "user", "I'm going to Lisbon in May");
    const version = store.getKnowledgeVersion();

    const { slices } = await runToCompletion({
      store,
      model: scriptedModel([
        {
          tools: [
            {
              name: "create_topic",
              input: {
                expectedVersion: version,
                name: "Trip to Lisbon",
                description: "May trip",
                body: "Lisbon in May.",
              },
            },
          ],
        },
        { text: "recorded the trip" },
      ]),
      messages: learningMessages(store, conv),
      maxSteps: 12,
    });

    expect(slices).toBe(1);
    expect(store.getTopic("Trip to Lisbon")?.body).toBe("Lisbon in May.");
  });

  it("reports an unfinished slice instead of running past its bound", async () => {
    const store = new MemoryStore();
    const conv = store.getOrCreateConversation(1, 0);
    store.storeMessage(conv, "user", "lots to learn");
    seedTopic(store, "weather", "climate");

    const { slices, wireLog } = await runToCompletion({
      store,
      model: scriptedModel([
        { tools: [{ name: "get_topic", input: { name: "weather" } }] },
        { tools: [{ name: "list_topics", input: {} }] },
        { text: "done" },
      ]),
      messages: learningMessages(store, conv),
      // One model step per slice: the job needs three.
      maxSteps: 1,
    });

    expect(slices).toBe(3);
    // Every step is in the log, so a slice resumes rather than replays.
    expect(wireLog.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("re-running a checkpointed write conflicts instead of appending twice", async () => {
    const store = new MemoryStore();
    const conv = store.getOrCreateConversation(1, 0);
    store.storeMessage(conv, "user", "note this");
    seedTopic(store, "notes", "");
    setBody(store, "notes", "first line");
    const port = createStoreLearningPort(store);
    const staleVersion = store.getKnowledgeVersion();

    const append = {
      name: "append_topic",
      input: { expectedVersion: staleVersion, name: "notes", text: "second line" },
    };
    // Slice 1 applies the append; the kill lands before its result is stored, so
    // slice 2 replays the same call with the same expected version.
    await runLearnerSlice({
      model: scriptedModel([{ tools: [append] }, { text: "done" }]),
      port,
      messages: learningMessages(store, conv),
      wireLog: [],
      maxSteps: 1,
    });
    expect(store.getTopic("notes")?.body).toBe("first line\n\nsecond line");

    const results: string[] = [];
    await runLearnerSlice({
      model: scriptedModel([{ tools: [append] }, { text: "done" }]),
      port,
      messages: learningMessages(store, conv),
      wireLog: [],
      maxSteps: 2,
      onToolResults: async (blocks) => {
        results.push(
          typeof blocks[0].content === "string" ? blocks[0].content : "",
        );
      },
    });

    // The body is untouched and the model is told to reread, rather than the
    // line being appended a second time.
    expect(store.getTopic("notes")?.body).toBe("first line\n\nsecond line");
    expect(results[0]).toContain("knowledge changed since you read it");
  });
});

describe("summarizeConversation", () => {
  it("gives the model the previous summary and the messages, and no tools", async () => {
    const captured: { system?: string; prompt?: string; tools?: number } = {};
    const model = capturingModel((request) => {
      captured.system = request.system.map((b) => b.text).join("\n");
      captured.prompt = JSON.stringify(request.messages);
      captured.tools = request.tools.length;
      return { content: [{ type: "text", text: "  they picked Lisbon  " }] };
    });

    const { summary } = await summarizeConversation({
      model,
      summary: "earlier: they were choosing a destination",
      messages: [
        {
          id: 1,
          conversationId: "c1",
          role: "user",
          kind: "user_message",
          content: "Lisbon then",
          stopReason: null,
          responseId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(summary).toBe("they picked Lisbon");
    expect(captured.tools).toBe(0);
    expect(captured.system).toContain("Never copy a topic body");
    expect(captured.prompt).toContain("choosing a destination");
    expect(captured.prompt).toContain("Lisbon then");
  });

  // A compacted summary outlives the raw turns it replaces, so reasoning must
  // not be able to leak into it and become permanent.
  it("cannot carry reasoning into the summary prompt", async () => {
    let prompt = "";
    const model = capturingModel((request) => {
      prompt = JSON.stringify(request.messages);
      return { content: [{ type: "text", text: "they picked Lisbon" }] };
    });

    await summarizeConversation({
      model,
      summary: null,
      messages: [
        {
          id: 1,
          conversationId: "c1",
          role: "assistant",
          kind: "assistant_message",
          content: [
            { type: "thinking", thinking: "weighing Porto", signature: "sig" },
            { type: "text", text: "Lisbon it is." },
          ],
          stopReason: "end_turn",
          responseId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(prompt).toContain("Lisbon it is.");
    expect(prompt).not.toContain("weighing Porto");
    expect(prompt).not.toContain("sig");
  });
});
