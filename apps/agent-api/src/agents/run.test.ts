import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "./run";
import { capturingModel, scriptedModel } from "./mock-model";
import {
  defineTool,
  type AgentModelRequest,
  type AgentToolSet,
  type ContentBlock,
  type StopReason,
  type ToolResultBlock,
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
    .filter((b): b is ToolResultBlock => b.type === "tool_result");

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

    await runAgent({ model, system: "sys", prompt: "the prompt" });

    expect(requests[0].messages).toEqual([
      { role: "user", content: "the prompt" },
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

  it("caches the system block and the last tool with a 1h ttl", async () => {
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
    expect(requests[0].tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(requests[0].tools[0].cache_control).toBeUndefined();
    expect(requests[0].tools[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
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

  it("adds no cache breakpoints as the loop appends steps", async () => {
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

    // 4 breakpoints is the API maximum: tools + system + at most 2 messages.
    const breakpoints = requests[1].messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => "cache_control" in b && b.cache_control).length;
    expect(breakpoints).toBe(1);
  });

  it("passes the plain shape when cache is disabled", async () => {
    const { model, requests } = recordingModel([{}]);

    await runAgent({ model, system: "sys", prompt: "q", cache: false });

    expect(requests[0].system).toEqual([{ type: "text", text: "sys" }]);
  });

  it("round-trips assistant blocks verbatim, including unmodelled ones", async () => {
    const thinking = {
      type: "thinking",
      thinking: "hmm",
      signature: "sig",
    } as unknown as ContentBlock;
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
