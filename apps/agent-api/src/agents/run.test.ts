import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { z } from "zod";
import { runAgent } from "./run";
import { scriptedModel } from "./mock-model";

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
      tools: {
        ping: tool({
          description: "ping",
          inputSchema: z.object({}),
          execute: ping,
        }),
      },
    });

    expect(ping).toHaveBeenCalledOnce();
    expect(result.text).toBe("final answer");
    expect(result.finishReason).toBe("stop");
    // messages span every step: the tool call, its result, and the final text.
    const kinds = result.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.map((p) => (p as { type: string }).type)
        : ["text"],
    );
    expect(kinds).toContain("tool-call");
    expect(kinds).toContain("tool-result");
  });

  it("sends a single user message equal to the prompt", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        captured = options;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult);
      },
    });

    await runAgent({ model, system: "sys", prompt: "the prompt" });

    const userMessages = (captured?.prompt ?? []).filter(
      (m) => m.role === "user",
    );
    expect(userMessages).toHaveLength(1);
  });

  it("forwards a messages array unchanged when given one", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        captured = options;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult);
      },
    });

    await runAgent({
      model,
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });

    const roles = (captured?.prompt ?? [])
      .filter((m) => m.role !== "system")
      .map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("returns empty string when the model produces no text (no fallback)", async () => {
    const model = scriptedModel([{ text: "" }]);
    const result = await runAgent({ model, system: "sys", prompt: "q" });
    expect(result.text).toBe("");
  });

  it("converts system into a cached leading system message and marks the last tool", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        captured = options;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult);
      },
    });

    await runAgent({
      model,
      system: "sys",
      prompt: "q",
      tools: {
        a: tool({ description: "a", inputSchema: z.object({}) }),
        b: tool({ description: "b", inputSchema: z.object({}) }),
      },
    });

    // No top-level system param; it rides as a cached leading system message.
    expect(captured?.prompt?.[0].role).toBe("system");
    const sysOpts = (captured?.prompt?.[0] as { providerOptions?: unknown })
      .providerOptions as { anthropic?: { cacheControl?: unknown } };
    expect(sysOpts?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // The last tool carries a cache breakpoint; the first does not.
    const toolOpts = (name: string) =>
      (
        captured?.tools?.find(
          (t) => (t as { name?: string }).name === name,
        ) as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }
      )?.providerOptions?.anthropic?.cacheControl;
    expect(toolOpts("b")).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(toolOpts("a")).toBeUndefined();
  });

  it("preserves caller message providerOptions", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        captured = options;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult);
      },
    });

    await runAgent({
      model,
      system: "sys",
      messages: [
        {
          role: "user",
          content: "hi",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
    });

    const user = captured?.prompt?.find((m) => m.role === "user") as {
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    };
    expect(user?.providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("flows cache token counts through to the result", async () => {
    const model = scriptedModel([{ text: "done" }]);
    const result = await runAgent({ model, system: "sys", prompt: "q" });
    expect(result.usage.cacheReadTokens).toBe(8);
    expect(result.usage.cacheWriteTokens).toBe(4);
    expect(result.usage.inputTokens).toBe(20);
    expect(result.stepUsages).toHaveLength(1);
    expect(result.stepUsages[0].cacheReadTokens).toBe(8);
  });

  it("passes the plain shape when cache is disabled", async () => {
    let captured: LanguageModelV3CallOptions | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        captured = options;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult);
      },
    });

    await runAgent({ model, system: "sys", prompt: "q", cache: false });
    // System still reaches the model (via the top-level param) but carries no
    // cache breakpoint.
    const system = captured?.prompt?.find((m) => m.role === "system") as {
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    };
    expect(system?.providerOptions?.anthropic?.cacheControl).toBeUndefined();
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
      tools: {
        ping: tool({
          description: "ping",
          inputSchema: z.object({}),
          execute: ping,
        }),
      },
      maxSteps: 1,
    });

    expect(result.finishReason).toBe("tool-calls");
    expect(result.text).toBe("");
  });
});
