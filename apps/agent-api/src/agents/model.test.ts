import { describe, expect, it } from "vitest";
import {
  createModel,
  createModelFactory,
  gatewayMetadata,
  providerFor,
  resolveModelSpec,
  AGENT_MODEL_OVERRIDES,
} from "./model";
import {
  promptCacheKey,
  toContext,
  fromAssistant,
  toTokenUsage,
  toStopReason,
} from "./model-pi";
import type {
  AgentModelRequest,
  ContentBlock,
  ThinkingBlock,
} from "./protocol";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { Env } from "../types";

const makeEnv = (over: Record<string, unknown> = {}): Env =>
  ({
    MODEL_ID: "gpt-5.6-luna",
    CLOUDFLARE_GATEWAY_ID: "zero",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_KEY: "cf-key",
    LLM_BASE_URL_OVERRIDE: "",
    ...over,
  }) as unknown as Env;

const request = (over: Partial<AgentModelRequest> = {}): AgentModelRequest => ({
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "ping", description: "ping", input_schema: { type: "object" } }],
  ...over,
});

describe("providerFor", () => {
  it("routes by model id so MODEL_ID alone picks the provider", () => {
    expect(providerFor("gpt-5.6-luna")).toBe("openai");
    expect(providerFor("gpt-5.6-terra")).toBe("openai");
    expect(providerFor("claude-sonnet-4.6")).toBe("anthropic");
  });
});

describe("resolveModelSpec", () => {
  it("returns the configured MODEL_ID at the default high effort", () => {
    expect(
      resolveModelSpec(makeEnv(), { agent: "interface", clerkUserId: "u" }),
    ).toEqual({ modelId: "gpt-5.6-luna", effort: "high" });
  });

  it("honors a per-agent override for that agent only", () => {
    (AGENT_MODEL_OVERRIDES as Record<string, string>).learner =
      "claude-sonnet-4.6";
    try {
      expect(
        resolveModelSpec(makeEnv(), { agent: "learner", clerkUserId: "u" })
          .modelId,
      ).toBe("claude-sonnet-4.6");
      expect(
        resolveModelSpec(makeEnv(), { agent: "interface", clerkUserId: "u" })
          .modelId,
      ).toBe("gpt-5.6-luna");
    } finally {
      delete (AGENT_MODEL_OVERRIDES as Record<string, string>).learner;
    }
  });
});

describe("createModel", () => {
  it("builds a model tagged with the configured MODEL_ID", async () => {
    const model = await createModel(makeEnv(), "user_123");
    expect(model).toMatchObject({ modelId: "gpt-5.6-luna" });
  });

  // Rollback is a var flip, not a code change: the gateway catalog holds the
  // claude models (dotted id, e.g. `claude-sonnet-4.6`) and routes them to the
  // Anthropic wire by the model's own `api`.
  it("builds a claude model id from the same catalog for rollback", async () => {
    const model = await createModel(
      makeEnv({ MODEL_ID: "claude-sonnet-4.6" }),
      "user_123",
    );
    expect(model).toMatchObject({ modelId: "claude-sonnet-4.6" });
  });

  it("tags each agent independently off one factory", async () => {
    const makeModel = await createModelFactory(makeEnv(), "user_123");
    expect(makeModel("interface")).toMatchObject({ modelId: "gpt-5.6-luna" });
    expect(makeModel("learner")).toMatchObject({ modelId: "gpt-5.6-luna" });
  });

  it("throws for a model id absent from the gateway catalog", async () => {
    await expect(
      createModel(makeEnv({ MODEL_ID: "no-such-model" }), "user_123"),
    ).rejects.toThrow(/catalog/);
  });
});

describe("gatewayMetadata", () => {
  it("carries the user id and the agent label", () => {
    expect(JSON.parse(gatewayMetadata("user_123", "interface"))).toEqual({
      user_id: "user_123",
      agent: "interface",
    });
    expect(JSON.parse(gatewayMetadata("u", "learner"))).toMatchObject({
      agent: "learner",
    });
  });
});

describe("promptCacheKey", () => {
  it("keys the cache per agent so one agent's prefix cannot shadow another's", () => {
    expect(promptCacheKey("interface", "user_1")).not.toBe(
      promptCacheKey("learner", "user_1"),
    );
    // Shared across users: the instructions + tools prefix is identical for
    // everyone, and a per-user key would make it unreusable.
    expect(promptCacheKey("interface", "user_1")).toBe(
      promptCacheKey("interface", "user_2"),
    );
  });
});

// The translation is the whole adapter and the main risk surface. The live gate
// (a real gateway call proving store:false, encrypted-reasoning replay, cf-aig
// headers and BYOK) is the spike + bin/e2e-test; these unit tests pin the pure
// protocol <-> pi-ai Context translation in both directions.
describe("toContext (request translation)", () => {
  it("joins system blocks into the system prompt and passes tool schemas through", () => {
    const ctx = toContext(
      request({
        system: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
      "gpt-5.6-luna",
      "openai-responses",
    );
    expect(ctx.systemPrompt).toBe("one\n\ntwo");
    expect(ctx.tools).toEqual([
      { name: "ping", description: "ping", parameters: { type: "object" } },
    ]);
  });

  it("splits a user turn's tool results out of the surrounding text", () => {
    const ctx = toContext(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "tool_result", tool_use_id: "call_1", content: "ok" },
              { type: "text", text: "after" },
            ],
          },
        ],
      }),
      "gpt-5.6-luna",
      "openai-responses",
    );
    expect(ctx.messages.map((m) => m.role)).toEqual([
      "user",
      "toolResult",
      "user",
    ]);
    const toolResult = ctx.messages[1];
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
  });

  it("maps an image block to pi-ai's image content", () => {
    const ctx = toContext(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "XYZ",
                },
              },
            ],
          },
        ],
      }),
      "gpt-5.6-luna",
      "openai-responses",
    );
    expect(ctx.messages[0].content).toEqual([
      { type: "image", data: "XYZ", mimeType: "image/png" },
    ]);
  });

  it("rebuilds an OpenAI reasoning item and stamps the assistant api", () => {
    const ctx = toContext(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "",
                signature: "",
                id: "rs_1",
                encrypted_content: "enc",
              },
              { type: "text", text: "hi", phase: "final_answer" },
              { type: "tool_use", id: "call_9", name: "ping", input: { a: 1 } },
            ],
          },
        ],
      }),
      "gpt-5.6-luna",
      "openai-responses",
    );
    const assistant = ctx.messages[0];
    expect(assistant).toMatchObject({ role: "assistant", api: "openai-responses" });
    const [thinking, text, tool] = (
      assistant as AssistantMessage
    ).content;
    expect(JSON.parse((thinking as { thinkingSignature: string }).thinkingSignature)).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc",
    });
    expect(text).toMatchObject({ type: "text", text: "hi" });
    expect(tool).toMatchObject({
      type: "toolCall",
      id: "call_9",
      name: "ping",
      arguments: { a: 1 },
    });
  });

  it("infers the anthropic api from a signature-only thinking block", () => {
    const ctx = toContext(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reason", signature: "sig123" },
            ],
          },
        ],
      }),
      "claude-sonnet-4.6",
      "anthropic-messages",
    );
    expect(ctx.messages[0]).toMatchObject({ api: "anthropic-messages" });
  });
});

describe("fromAssistant (response translation)", () => {
  it("maps text with phase, decodes an OpenAI reasoning item, and splits a tool id", () => {
    const content: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "enc",
        }),
      },
      {
        type: "text",
        text: "hi",
        textSignature: JSON.stringify({ v: 1, id: "", phase: "final_answer" }),
      },
      { type: "toolCall", id: "call_9|item_2", name: "ping", arguments: { a: 1 } },
    ];
    expect(fromAssistant(content)).toEqual([
      {
        type: "thinking",
        thinking: "",
        signature: "",
        id: "rs_1",
        encrypted_content: "enc",
      },
      { type: "text", text: "hi", phase: "final_answer" },
      { type: "tool_use", id: "call_9", name: "ping", input: { a: 1 } },
    ]);
  });

  it("keeps an opaque anthropic signature verbatim", () => {
    const content: AssistantMessage["content"] = [
      { type: "thinking", thinking: "reason", thinkingSignature: "sig123" },
    ];
    expect(fromAssistant(content)).toEqual([
      { type: "thinking", thinking: "reason", signature: "sig123" },
    ]);
  });
});

describe("thinking round-trip", () => {
  const roundTrip = (block: ThinkingBlock): ContentBlock[] => {
    const ctx = toContext(
      request({ messages: [{ role: "assistant", content: [block] }] }),
      "gpt-5.6-luna",
      "openai-responses",
    );
    return fromAssistant((ctx.messages[0] as AssistantMessage).content);
  };

  it("preserves an OpenAI encrypted reasoning block across the round-trip", () => {
    const block: ThinkingBlock = {
      type: "thinking",
      thinking: "",
      signature: "",
      id: "rs_1",
      encrypted_content: "enc",
    };
    expect(roundTrip(block)).toEqual([block]);
  });

  it("preserves an Anthropic signed reasoning block across the round-trip", () => {
    const block: ThinkingBlock = {
      type: "thinking",
      thinking: "reason",
      signature: "sig123",
    };
    expect(roundTrip(block)).toEqual([block]);
  });
});

describe("toTokenUsage", () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    input: 11,
    output: 3,
    cacheRead: 7,
    cacheWrite: 5,
    totalTokens: 26,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  });

  it("maps pi-ai usage, folding the whole write into the 5m bucket for OpenAI", () => {
    expect(toTokenUsage(usage())).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
      cacheWrite5mTokens: 5,
      cacheWrite1hTokens: 0,
      costUsd: 0,
    });
  });

  it("splits the 1h write bucket when Anthropic reports it", () => {
    expect(toTokenUsage(usage({ cacheWrite: 5, cacheWrite1h: 2 }))).toMatchObject({
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 2,
    });
  });

  it("carries the provider-reported dollar cost", () => {
    expect(
      toTokenUsage(
        usage({
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.03,
          },
        }),
      ).costUsd,
    ).toBe(0.03);
  });
});

describe("toStopReason", () => {
  it("maps pi-ai stop reasons to the protocol's", () => {
    expect(toStopReason("toolUse")).toBe("tool_use");
    expect(toStopReason("length")).toBe("max_tokens");
    expect(toStopReason("stop")).toBe("end_turn");
  });
});
