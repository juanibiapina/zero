import { describe, expect, it, vi } from "vitest";
import {
  createModel,
  createModelFactory,
  gatewayMetadata,
  providerFor,
  type AgentLabel,
} from "./model";
import { promptCacheKey } from "./model-openai";
import type { AgentModelRequest } from "./protocol";
import type { Env } from "../types";

const makeEnv = (over: Record<string, unknown> = {}): Env =>
  ({
    MODEL_ID: "gpt-5.6-luna",
    CLOUDFLARE_GATEWAY_ID: "zero",
    CLOUDFLARE_API_KEY: "cf-key",
    LLM_BASE_URL_OVERRIDE: "",
    AI: {
      gateway: (id: string) => ({
        getUrl: async (provider: string) =>
          `https://gw.example/${id}/${provider}`,
      }),
    },
    ...over,
  }) as unknown as Env;

// A canned Responses reply, plus a recorder for the request the SDK issued. The
// request bytes are what the prompt cache keys on, so they are the thing worth
// asserting on.
const transport = (
  body: Record<string, unknown> = {},
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;
} => {
  const calls: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit),
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        id: "resp_01",
        object: "response",
        model: "gpt-5.6-luna",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
        usage: {
          input_tokens: 18,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 7, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        ...body,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl: fetchImpl, calls };
};

const request: AgentModelRequest = {
  system: [
    {
      type: "text",
      text: "sys",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ],
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      name: "ping",
      description: "ping",
      input_schema: { type: "object" },
    },
  ],
};

describe("providerFor", () => {
  it("routes by model id so MODEL_ID alone picks the provider", () => {
    expect(providerFor("gpt-5.6-luna")).toBe("openai");
    expect(providerFor("gpt-5.6-terra")).toBe("openai");
    expect(providerFor("claude-sonnet-4-6")).toBe("anthropic");
  });
});

describe("createModel", () => {
  it("builds a model for the configured MODEL_ID via the gateway", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/openai");
    const env = makeEnv({ AI: { gateway: () => ({ getUrl }) } });

    const model = await createModel(env, "user_123");

    expect(model).toMatchObject({ modelId: "gpt-5.6-luna" });
    expect(getUrl).toHaveBeenCalledWith("openai");
  });

  // Rollback is a var flip, not a code change.
  it("falls back to the Anthropic gateway route for a claude model id", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/anthropic");
    const env = makeEnv({
      MODEL_ID: "claude-sonnet-4-6",
      AI: { gateway: () => ({ getUrl }) },
    });

    const model = await createModel(env, "user_123");

    expect(model).toMatchObject({ modelId: "claude-sonnet-4-6" });
    expect(getUrl).toHaveBeenCalledWith("anthropic");
  });

  it("honors LLM_BASE_URL_OVERRIDE and skips the gateway lookup", async () => {
    const getUrl = vi.fn(async () => "unused");
    const env = makeEnv({
      LLM_BASE_URL_OVERRIDE: "https://override.example/v1",
      AI: { gateway: () => ({ getUrl }) },
    });

    const model = await createModel(env, "user_123");

    expect(model).toMatchObject({ modelId: "gpt-5.6-luna" });
    expect(getUrl).not.toHaveBeenCalled();
  });

  it("resolves the base URL once and tags each agent independently", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/openai");
    const env = makeEnv({ AI: { gateway: () => ({ getUrl }) } });

    const makeModel = await createModelFactory(env, "user_123");
    const a = makeModel("interface");
    const b = makeModel("learner");

    expect(a).toMatchObject({ modelId: "gpt-5.6-luna" });
    expect(b).toMatchObject({ modelId: "gpt-5.6-luna" });
    // Base URL resolved once for the turn, not per agent.
    expect(getUrl).toHaveBeenCalledTimes(1);
  });
});

describe("the OpenAI request", () => {
  const send = async (
    over: Partial<AgentModelRequest> = {},
    responseBody?: Record<string, unknown>,
    agent: AgentLabel = "interface",
  ) => {
    const { fetchImpl, calls } = transport(responseBody);
    const env = makeEnv({ LLM_BASE_URL_OVERRIDE: "https://gw.example/openai" });
    const model = await createModel(env, "user_123", agent, fetchImpl);
    const response = await model.generate({ ...request, ...over });
    return { call: calls[0], response };
  };

  it("posts to the Responses endpoint", async () => {
    const { call } = await send();
    expect(call.url).toBe("https://gw.example/openai/responses");
  });

  // Under BYOK the gateway holds the provider key; a client-sent Authorization
  // header would be used instead of the stored one.
  it("authenticates to the gateway and sends no provider key", async () => {
    const { call } = await send();
    expect(call.headers.get("cf-aig-authorization")).toBe("Bearer cf-key");
    expect(JSON.parse(call.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      user_id: "user_123",
      agent: "interface",
    });
    expect(call.headers.get("authorization")).toBeNull();
  });

  it("sends the model, the output ceiling, and stores nothing provider-side", async () => {
    const { call } = await send();
    expect(call.body).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 32000,
      store: false,
      include: ["reasoning.encrypted_content"],
      safety_identifier: "user_123",
    });
  });

  // The family defaults to medium, and Zero's quality case for the cheap tier
  // rests on high. A silent drop here is a silent quality drop.
  it("asks every agent to reason at high effort", async () => {
    const agents: AgentLabel[] = [
      "interface",
      "learner",
      "compaction",
      "onboarding",
      "admin_task",
    ];
    for (const agent of agents) {
      const { call } = await send({}, undefined, agent);
      expect(call.body.reasoning).toEqual({
        effort: "high",
        context: "all_turns",
      });
    }
  });

  it("caches explicitly, keyed per agent, so the volatile tail is never written", async () => {
    const { call } = await send();
    expect(call.body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(call.body.prompt_cache_key).toBe("zero:interface:v1:0");
  });

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

  it("translates system, tools and messages into the Responses shapes", async () => {
    const { call } = await send();
    expect(call.body.tools).toEqual([
      {
        type: "function",
        name: "ping",
        description: "ping",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
    expect(call.body.input).toEqual([
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "sys",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });
});

describe("the OpenAI response", () => {
  const send = async (
    over: Partial<AgentModelRequest> = {},
    responseBody?: Record<string, unknown>,
  ) => {
    const { fetchImpl } = transport(responseBody);
    const env = makeEnv({ LLM_BASE_URL_OVERRIDE: "https://gw.example/openai" });
    const model = await createModel(env, "user_123", "interface", fetchImpl);
    return model.generate({ ...request, ...over });
  };

  it("maps id, content, stop reason, and token usage", async () => {
    const response = await send();
    expect(response.id).toBe("resp_01");
    expect(response.content).toEqual([
      { type: "text", text: "hello", phase: "final_answer" },
    ]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      // 18 reported input tokens include the 7 that were cache reads.
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
      cacheWrite5mTokens: 5,
      cacheWrite1hTokens: 0,
    });
  });

  it("reports a tool call as tool_use", async () => {
    const response = await send({}, {
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "ping",
          arguments: "{}",
        },
      ],
    });
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "ping", input: {} },
    ]);
  });

  // Reasoning spend is inside output_tokens, so the per-request log line is the
  // only place it is visible. Without it there is no telling a turn that thought
  // hard from one that barely thought.
  it("logs cache and reasoning counts for the call", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await send(
      { step: 2 },
      {
        usage: {
          input_tokens: 1000,
          output_tokens: 300,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 40 },
          output_tokens_details: { reasoning_tokens: 240 },
        },
      },
    );
    const events = logSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(events.find((e) => e.msg === "cache_stats")).toMatchObject({
      agent: "interface",
      step: 2,
      input_tokens: 100,
      cache_read_tokens: 900,
      cache_write_tokens: 40,
      thinking_tokens: 240,
    });
    logSpy.mockRestore();
  });

  it("reads a response with no usage as zeros", async () => {
    const response = await send({}, { usage: null });
    expect(response.usage.cacheReadTokens).toBe(0);
    expect(response.usage.cacheWriteTokens).toBe(0);
    expect(response.usage.inputTokens).toBe(0);
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
    expect(JSON.parse(gatewayMetadata("u", "compaction"))).toMatchObject({
      agent: "compaction",
    });
    expect(JSON.parse(gatewayMetadata("u", "onboarding"))).toMatchObject({
      agent: "onboarding",
    });
    expect(JSON.parse(gatewayMetadata("u", "admin_task"))).toMatchObject({
      agent: "admin_task",
    });
  });
});
