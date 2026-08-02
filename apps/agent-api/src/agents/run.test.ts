import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  runAgent,
  UNCERTAIN_EXTERNAL_CALL,
  type ExternalCallGuard,
} from "./run";
import { capturingModel, scriptedModel } from "./mock-model";
import { ExternalCallNotSent } from "./external-call";
import {
  defineTool,
  type AgentModel,
  type AgentModelRequest,
  type AgentToolSet,
  type ContentBlock,
  type StopReason,
  type ToolResultBlock,
  type ThinkingBlock,
  type ToolUseBlock,
} from "./protocol";

const pingTool = (execute: () => Promise<unknown>): AgentToolSet => ({
  ping: defineTool({
    description: "ping",
    inputSchema: z.object({}),
    execute,
  }),
});

// Capture every request the runner issues, answering with a scripted sequence.
const recordingModel = (steps: Array<Partial<{ content: ContentBlock[]; stopReason: StopReason | null }>>) => {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  const model = capturingModel((request) => {
    requests.push(structuredClone(request));
    return steps[Math.min(index++, steps.length - 1)] ?? {};
  });
  return { model, requests };
};

const toolResults = (request: AgentModelRequest): ToolResultBlock[] =>
  request.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is ToolResultBlock => b.type === "tool_result")
    // Strip the loop's sliding cache breakpoint (asserted separately) so these
    // assertions stay focused on tool-result pairing and error semantics.
    .map(({ cache_control: _cc, ...rest }) => rest);

describe("runAgent", () => {
  it("executes tool calls then returns the final text", async () => {
    const ping = vi.fn(async () => "pong");
    const model = scriptedModel([
      { tools: [{ name: "ping", input: {} }] },
      { text: "final answer" },
    ]);

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "question",
      tools: pingTool(ping),
    });

    expect(ping).toHaveBeenCalledOnce();
    expect(result.text).toBe("final answer");
    expect(result.finishReason).toBe("stop");
    expect(result.steps).toBe(2);
    // messages span every step: the tool call, its result, and the final text.
    const kinds = result.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.map((b) => b.type) : ["text"],
    );
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
  });

  it("feeds each tool result back paired with its call id", async () => {
    const { model, requests } = recordingModel([
      {
        content: [
          { type: "tool_use", id: "toolu_1", name: "ping", input: {} },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => ({ ok: true })),
    });

    expect(toolResults(requests[1])).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' },
    ]);
  });

  it("runs parallel tool calls and keeps results in call order", async () => {
    const order: string[] = [];
    const slow = defineTool({
      description: "slow",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }: { n: number }) => {
        await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
        order.push(`done-${n}`);
        return `result-${n}`;
      },
    });
    const { model, requests } = recordingModel([
      {
        content: [
          { type: "tool_use", id: "a", name: "slow", input: { n: 1 } },
          { type: "tool_use", id: "b", name: "slow", input: { n: 2 } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({ model, system: "sys", prompt: "q", tools: { slow } });

    // Started in parallel (the fast one finished first) but reported in the
    // order the model called them.
    expect(order).toEqual(["done-2", "done-1"]);
    expect(toolResults(requests[1]).map((r) => r.tool_use_id)).toEqual([
      "a",
      "b",
    ]);
    expect(toolResults(requests[1]).map((r) => r.content)).toEqual([
      "result-1",
      "result-2",
    ]);
  });

  it("reports an unknown tool name back to the model as an error result", async () => {
    const { model, requests } = recordingModel([
      {
        content: [{ type: "tool_use", id: "x", name: "nope", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });

    const [error] = toolResults(requests[1]);
    expect(error.is_error).toBe(true);
    expect(error.content).toContain("nope");
    expect(result.finishReason).toBe("stop");
  });

  it("reports invalid tool input back to the model as an error result", async () => {
    const { model, requests } = recordingModel([
      {
        content: [
          { type: "tool_use", id: "x", name: "echo", input: { text: 42 } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    const execute = vi.fn(async () => "never");

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: {
        echo: defineTool({
          description: "echo",
          inputSchema: z.object({ text: z.string() }),
          execute,
        }),
      },
    });

    expect(execute).not.toHaveBeenCalled();
    const [error] = toolResults(requests[1]);
    expect(error.is_error).toBe(true);
    expect(error.content).toContain("echo");
  });

  it("turns a thrown tool execution into an error result, not a failed run", async () => {
    const { model, requests } = recordingModel([
      {
        content: [{ type: "tool_use", id: "x", name: "ping", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" },
    ]);

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => {
        throw new Error("send failed");
      }),
    });

    expect(result.text).toBe("recovered");
    expect(toolResults(requests[1])).toEqual([
      {
        type: "tool_result",
        tool_use_id: "x",
        content: "send failed",
        is_error: true,
      },
    ]);
  });

  it("sends a single user message equal to the prompt", async () => {
    const { model, requests } = recordingModel([{}]);

    // cache off isolates prompt wrapping from the loop's sliding breakpoint.
    await runAgent({ model, system: "sys", prompt: "the prompt", cache: false });

    expect(requests[0].messages).toEqual([
      { role: "user", content: "the prompt" },
    ]);
  });

  it("caches a single-prompt (research/writer) message region on the tail", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({ model, system: "sys", prompt: "the prompt" });

    // With no caller anchor, the loop supplies the only message breakpoint, on
    // the tail. This is the fix that makes research and writer cache their
    // growing message region.
    expect(requests[0].messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "the prompt",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("forwards a messages array unchanged when given one", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({
      model,
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });

    expect(requests[0].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("returns empty string when the model produces no text (no fallback)", async () => {
    const model = scriptedModel([{ text: "" }]);
    const result = await runAgent({ model, system: "sys", prompt: "q" });
    expect(result.text).toBe("");
  });

  it("caches the system block with a 1h ttl and leaves tools unmarked", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: {
        a: defineTool({
          description: "a",
          inputSchema: z.object({}),
          execute: async () => "",
        }),
        b: defineTool({
          description: "b",
          inputSchema: z.object({}),
          execute: async () => "",
        }),
      },
    });

    expect(requests[0].system).toEqual([
      {
        type: "text",
        text: "sys",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    // Tools carry no breakpoint of their own: only an input block can carry
    // one, and tools are rendered into the prefix ahead of the system block, so
    // the system breakpoint already covers every schema.
    expect(requests[0].tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(requests[0].tools.every((t) => t.cache_control === undefined)).toBe(
      true,
    );
  });

  it("gives the per-user system tail its own breakpoint", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({
      model,
      system: "sys",
      systemTail: "\n\npinned",
      prompt: "q",
    });

    expect(requests[0].system).toEqual([
      {
        type: "text",
        text: "sys",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "text",
        text: "\n\npinned",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("sends tool schemas as JSON Schema objects", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: {
        echo: defineTool({
          description: "echo it",
          inputSchema: z.object({ text: z.string() }),
          execute: async () => "",
        }),
      },
    });

    expect(requests[0].tools[0]).toMatchObject({
      name: "echo",
      description: "echo it",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
  });

  it("preserves caller message cache breakpoints", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({
      model,
      system: "sys",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });

    expect(requests[0].messages[0].content).toEqual([
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
  });

  // A message is marked when its last content block carries a breakpoint.
  const markedIndexes = (request: AgentModelRequest): number[] =>
    request.messages.flatMap((m, i) => {
      if (!Array.isArray(m.content)) return [];
      const last = m.content[m.content.length - 1];
      return last && "cache_control" in last && last.cache_control ? [i] : [];
    });

  it("slides one message breakpoint to the growing tail each step", async () => {
    const { model, requests } = recordingModel([
      {
        content: [{ type: "tool_use", id: "x", name: "ping", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({
      model,
      system: "sys",
      // A caller anchor breakpoint on the first message (the interface agent's
      // cross-turn history read); the loop must preserve it and add exactly one
      // sliding breakpoint at the tail.
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      tools: pingTool(async () => "pong"),
    });

    // Step 0: one message (the anchor is also the tail) -> single breakpoint.
    expect(markedIndexes(requests[0])).toEqual([0]);
    // Step 1: messages grew to [anchor, assistant, tool_result]. The anchor
    // stays on index 0 and the sliding breakpoint advanced to the new tail (2).
    expect(requests[1].messages).toHaveLength(3);
    expect(markedIndexes(requests[1])).toEqual([0, 2]);
    // Never exceeds the 4-breakpoint budget: tools + system + these two.
    const total = requests[1].messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => "cache_control" in b && b.cache_control).length;
    expect(total).toBeLessThanOrEqual(2);
  });

  it("passes the loop step index to the model each call", async () => {
    const { model, requests } = recordingModel([
      {
        content: [{ type: "tool_use", id: "x", name: "ping", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });

    expect(requests.map((r) => r.step)).toEqual([0, 1]);
  });

  it("passes the plain shape when cache is disabled", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({ model, system: "sys", prompt: "q", cache: false });

    expect(requests[0].system).toEqual([{ type: "text", text: "sys" }]);
  });

  // The signature is the encrypted reasoning: modify it and the next request is
  // rejected, so the loop has to hand it back exactly as it arrived.
  it("round-trips a signed thinking block into the next request unchanged", async () => {
    const thinking: ThinkingBlock = {
      type: "thinking",
      thinking: "",
      signature: "sig",
    };
    const call: ToolUseBlock = {
      type: "tool_use",
      id: "toolu_9",
      name: "ping",
      input: { deep: { nested: true } },
    };
    const { model, requests } = recordingModel([
      { content: [thinking, call], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });

    expect(requests[1].messages[1]).toEqual({
      role: "assistant",
      content: [thinking, call],
    });
  });

  // The sliding breakpoint lands on the last message every step. When a run is
  // cut off mid-thinking that message ends on a thinking block, which cannot
  // carry cache_control, so the step must go out unmarked rather than 400.
  it("sends no breakpoint on a message that ends mid-thinking", async () => {
    const { model, requests } = recordingModel([
      {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "ping", input: {} },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "thinking", thinking: "", signature: "sig-2" }],
        stopReason: "max_tokens",
      },
    ]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });

    // Nothing in either request carries a breakpoint on a thinking block.
    for (const request of requests) {
      for (const message of request.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type === "thinking" || block.type === "redacted_thinking")
            expect(block).not.toHaveProperty("cache_control");
        }
      }
    }
  });

  it("sums token counts across steps and reports them per step", async () => {
    const model = scriptedModel([
      { tools: [{ name: "ping", input: {} }] },
      { text: "done" },
    ]);
    const result = await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });
    expect(result.stepUsages).toHaveLength(2);
    expect(result.stepUsages[0].cacheReadTokens).toBe(8);
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 16,
      cacheWriteTokens: 8,
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 6,
      modelCalls: 2,
    });
  });

  it("surfaces finishReason 'tool-calls' when the loop hits the cap mid-tool-call", async () => {
    const ping = vi.fn(async () => "pong");
    const model = scriptedModel([
      { tools: [{ name: "ping", input: {} }] },
      { tools: [{ name: "ping", input: {} }] },
    ]);

    const result = await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(ping),
      maxSteps: 1,
    });

    expect(result.finishReason).toBe("tool-calls");
    expect(result.text).toBe("");
    expect(result.steps).toBe(1);
  });

  describe("stop reason mapping", () => {
    const cases: Array<[StopReason | null, string]> = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["max_tokens", "length"],
      ["refusal", "refusal"],
      ["pause_turn", "pause"],
      ["compaction", "compaction"],
      ["model_context_window_exceeded", "context-window-exceeded"],
      [null, "unknown"],
    ];

    it.each(cases)("maps %s to %s", async (stopReason, expected) => {
      const { model } = recordingModel([
        { content: [{ type: "text", text: "partial" }], stopReason },
      ]);
      const result = await runAgent({ model, system: "sys", prompt: "q" });
      expect(result.finishReason).toBe(expected);
    });

    it("keeps looping on tool_use rather than finishing", async () => {
      const { model } = recordingModel([
        {
          content: [{ type: "tool_use", id: "x", name: "ping", input: {} }],
          stopReason: "tool_use",
        },
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]);
      const result = await runAgent({
        model,
        system: "sys",
        prompt: "q",
        tools: pingTool(async () => "pong"),
      });
      expect(result.finishReason).toBe("stop");
      expect(result.steps).toBe(2);
    });
  });
});

// Phase 1.3: a call that changes the world outside Zero is claimed durably
// before it leaves, so a replay after a reset cannot fire it twice.
describe("runAgent external write claims", () => {
  const sendTool = (execute: () => Promise<unknown>): AgentToolSet => ({
    gmail_send: defineTool({
      description: "send",
      inputSchema: z.object({}),
      execute,
      externalWrite: true,
    }),
  });

  const guardOver = (
    rows: Map<string, { status: string; result: string }>,
  ): ExternalCallGuard => ({
    begin: (toolUseId, tool) => {
      const existing = rows.get(toolUseId);
      if (existing)
        return existing.status === "completed"
          ? { status: "completed", result: existing.result }
          : { status: "in_flight" };
      rows.set(toolUseId, { status: "started", result: "" });
      void tool;
      return { status: "claimed" };
    },
    complete: (toolUseId, result) => rows.set(toolUseId, { status: "completed", result }),
  });

  const oneSend = () =>
    recordingModel([
      {
        content: [{ type: "tool_use", id: "call_1", name: "gmail_send", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "sent" }], stopReason: "end_turn" },
    ]);

  it("claims the call, runs it, and records the result", async () => {
    const rows = new Map<string, { status: string; result: string }>();
    const send = vi.fn(async () => ({ id: "m1" }));
    const { model } = oneSend();

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(rows.get("call_1")).toEqual({
      status: "completed",
      result: '{"id":"m1"}',
    });
  });

  it("reports an unknown outcome instead of sending again", async () => {
    const rows = new Map([["call_1", { status: "started", result: "" }]]);
    const send = vi.fn(async () => ({ id: "m1" }));
    const { model, requests } = oneSend();

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });

    expect(send).not.toHaveBeenCalled();
    const result = toolResults(requests[requests.length - 1])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toBe(UNCERTAIN_EXTERNAL_CALL);
  });

  it("hands back the recorded result of a call that already finished", async () => {
    const rows = new Map([
      ["call_1", { status: "completed", result: '{"id":"m1"}' }],
    ]);
    const send = vi.fn(async () => ({ id: "m2" }));
    const { model, requests } = oneSend();

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });

    expect(send).not.toHaveBeenCalled();
    expect(toolResults(requests[requests.length - 1])[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: '{"id":"m1"}',
    });
  });

  it("leaves the claim in flight when a failure does not prove non-effect", async () => {
    const rows = new Map<string, { status: string; result: string }>();
    const send = vi.fn(async () => {
      // What a fetch that dies while reading the response looks like. The mail
      // may already be sent.
      throw new Error("network error");
    });
    const { model, requests } = oneSend();

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const result = toolResults(requests[requests.length - 1])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toBe(UNCERTAIN_EXTERNAL_CALL);
    // Still in flight, so a replay of the same id says the same thing rather
    // than firing the send again.
    expect(rows.get("call_1")).toEqual({ status: "started", result: "" });

    const replay = oneSend();
    await runAgent({
      model: replay.model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      toolResults(replay.requests[replay.requests.length - 1])[0].content,
    ).toBe(UNCERTAIN_EXTERNAL_CALL);
  });

  it("completes the claim when the adapter proves the request never left", async () => {
    const rows = new Map<string, { status: string; result: string }>();
    const send = vi.fn(async () => {
      throw new ExternalCallNotSent("Google isn't connected.");
    });
    const { model, requests } = oneSend();

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: sendTool(send),
      externalCalls: guardOver(rows),
    });

    const result = toolResults(requests[requests.length - 1])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Google isn't connected.");
    // Recorded as a real failure: nothing happened, so the model may try again
    // under a new call id.
    expect(rows.get("call_1")).toEqual({
      status: "completed",
      result: "Google isn't connected.",
    });
  });

  it("runs an unmarked tool with no claim at all", async () => {
    const rows = new Map<string, { status: string; result: string }>();
    const ping = vi.fn(async () => "pong");
    const { model } = recordingModel([
      {
        content: [{ type: "tool_use", id: "call_1", name: "ping", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(ping),
      externalCalls: guardOver(rows),
    });

    expect(ping).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
  });
});

describe("run usage reporting", () => {
  it("reports one aggregate after a completed multi-step execution", async () => {
    const reportRunUsage = vi.fn();
    const model = scriptedModel([
      { tools: [{ name: "ping", input: {} }] },
      { text: "done" },
    ]);
    model.reportRunUsage = reportRunUsage;

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: pingTool(async () => "pong"),
    });

    expect(reportRunUsage).toHaveBeenCalledOnce();
    expect(reportRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({ modelCalls: 2, inputTokens: 40 }),
    );
  });

  it("reports successful responses when a later model request fails", async () => {
    const reportRunUsage = vi.fn();
    let calls = 0;
    const model: AgentModel = {
      modelId: "test-model",
      reportRunUsage,
      generate: async () => {
        calls += 1;
        if (calls === 2) throw new Error("upstream failed");
        return {
          id: "msg_1",
          content: [{ type: "tool_use", id: "call_1", name: "ping", input: {} }],
          stopReason: "tool_use",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
          },
          diagnostic: { state: "initial" },
        };
      },
    };

    await expect(
      runAgent({
        model,
        system: "sys",
        prompt: "q",
        tools: pingTool(async () => "pong"),
      }),
    ).rejects.toThrow("upstream failed");
    expect(reportRunUsage).toHaveBeenCalledWith(
      expect.objectContaining({ modelCalls: 1, inputTokens: 3 }),
    );
  });

  it("does not report an execution with no successful response", async () => {
    const reportRunUsage = vi.fn();
    const model: AgentModel = {
      modelId: "test-model",
      reportRunUsage,
      generate: async () => {
        throw new Error("upstream failed");
      },
    };

    await expect(
      runAgent({ model, system: "sys", prompt: "q" }),
    ).rejects.toThrow("upstream failed");
    expect(reportRunUsage).not.toHaveBeenCalled();
  });
});
