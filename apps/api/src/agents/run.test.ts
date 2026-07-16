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

  it("returns empty string when the model produces no text (no fallback)", async () => {
    const model = scriptedModel([{ text: "" }]);
    const result = await runAgent({ model, system: "sys", prompt: "q" });
    expect(result.text).toBe("");
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
