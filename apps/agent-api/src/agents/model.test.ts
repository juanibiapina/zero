import { describe, expect, it, vi } from "vitest";
import { createModel, createModelFactory, gatewayMetadata } from "./model";
import type { AgentModelRequest } from "./protocol";
import type { Env } from "../types";

const makeEnv = (over: Record<string, unknown> = {}): Env =>
  ({
    MODEL_ID: "claude-sonnet-4-6",
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

// A canned Messages response, plus a recorder for the request the SDK issued.
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
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 5,
          cache_creation: {
            ephemeral_5m_input_tokens: 2,
            ephemeral_1h_input_tokens: 3,
          },
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
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ],
};

describe("createModel", () => {
  it("builds a model for the configured MODEL_ID via the gateway", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/anthropic");
    const env = makeEnv({
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

    expect(model).toMatchObject({ modelId: "claude-sonnet-4-6" });
    expect(getUrl).not.toHaveBeenCalled();
  });

  it("resolves the base URL once and tags each agent independently", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/anthropic");
    const env = makeEnv({
      AI: { gateway: () => ({ getUrl }) },
    });

    const makeModel = await createModelFactory(env, "user_123");
    const a = makeModel("interface");
    const b = makeModel("research");

    expect(a).toMatchObject({ modelId: "claude-sonnet-4-6" });
    expect(b).toMatchObject({ modelId: "claude-sonnet-4-6" });
    // Base URL resolved once for the turn, not per agent.
    expect(getUrl).toHaveBeenCalledTimes(1);
  });
});

describe("the Anthropic request", () => {
  const send = async (
    over: Partial<AgentModelRequest> = {},
    responseBody?: Record<string, unknown>,
  ) => {
    const { fetchImpl, calls } = transport(responseBody);
    const env = makeEnv({ LLM_BASE_URL_OVERRIDE: "https://gw.example/v1" });
    const model = await createModel(env, "user_123", "interface", fetchImpl);
    const response = await model.generate({ ...request, ...over });
    return { call: calls[0], response };
  };

  it("posts to the beta Messages endpoint with the cache-diagnosis beta", async () => {
    const { call } = await send();
    expect(call.url).toBe("https://gw.example/v1/v1/messages?beta=true");
    expect(call.headers.get("anthropic-beta")).toBe(
      "cache-diagnosis-2026-04-07",
    );
  });

  it("carries the gateway headers and never sends an API key", async () => {
    const { call } = await send();
    expect(call.headers.get("cf-aig-authorization")).toBe("Bearer cf-key");
    expect(JSON.parse(call.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      user_id: "user_123",
      agent: "interface",
    });
    // Under BYOK the gateway injects the real key; a client key would override it.
    expect(call.headers.get("x-api-key")).toBeNull();
  });

  it("sends the model, an explicit max_tokens, and the request as given", async () => {
    const { call } = await send();
    expect(call.body).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
    });
  });

  it("omits diagnostics unless the caller opted in", async () => {
    const { call } = await send();
    expect(call.body.diagnostics).toBeUndefined();
  });

  it("threads the previous response id when the caller opts in", async () => {
    const { call } = await send({ previousMessageId: "msg_00" });
    expect(call.body.diagnostics).toEqual({ previous_message_id: "msg_00" });
  });

  it("opts in with null on the first request of a run", async () => {
    const { call } = await send({ previousMessageId: null });
    expect(call.body.diagnostics).toEqual({ previous_message_id: null });
  });
});

describe("the Anthropic response", () => {
  const send = async (
    over: Partial<AgentModelRequest> = {},
    responseBody?: Record<string, unknown>,
  ) => {
    const { fetchImpl } = transport(responseBody);
    const env = makeEnv({ LLM_BASE_URL_OVERRIDE: "https://gw.example/v1" });
    const model = await createModel(env, "user_123", "interface", fetchImpl);
    return model.generate({ ...request, ...over });
  };

  it("maps id, content, stop reason, and token usage", async () => {
    const response = await send();
    expect(response.id).toBe("msg_01");
    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
      cacheWrite5mTokens: 2,
      cacheWrite1hTokens: 3,
    });
  });

  it("reads a null cache read/write count as zero", async () => {
    const response = await send(
      {},
      {
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    );
    expect(response.usage.cacheReadTokens).toBe(0);
    expect(response.usage.cacheWriteTokens).toBe(0);
  });

  it("labels a first-of-run response 'initial', not 'no divergence'", async () => {
    const response = await send({ previousMessageId: null }, {
      diagnostics: null,
    });
    expect(response.diagnostic).toEqual({ state: "initial" });
  });

  it("labels an unchanged prefix 'no_divergence' once a previous id was sent", async () => {
    const response = await send({ previousMessageId: "msg_00" }, {
      diagnostics: null,
    });
    expect(response.diagnostic).toEqual({ state: "no_divergence" });
  });

  it("reports a miss reason with its missed token count", async () => {
    const response = await send({ previousMessageId: "msg_00" }, {
      diagnostics: {
        cache_miss_reason: {
          type: "system_changed",
          cache_missed_input_tokens: 940,
        },
      },
    });
    expect(response.diagnostic).toEqual({
      state: "system_changed",
      missedInputTokens: 940,
    });
  });

  it("reports a miss reason that carries no token count", async () => {
    const response = await send({ previousMessageId: "msg_00" }, {
      diagnostics: { cache_miss_reason: { type: "previous_message_not_found" } },
    });
    expect(response.diagnostic).toEqual({
      state: "previous_message_not_found",
    });
  });

  it("reports an unfinished comparison as pending", async () => {
    const response = await send({ previousMessageId: "msg_00" }, {
      diagnostics: { cache_miss_reason: null },
    });
    expect(response.diagnostic).toEqual({ state: "pending" });
  });
});

describe("gatewayMetadata", () => {
  it("carries the user id and the agent label", () => {
    expect(JSON.parse(gatewayMetadata("user_123", "interface"))).toEqual({
      user_id: "user_123",
      agent: "interface",
    });
    expect(JSON.parse(gatewayMetadata("user_123", "research"))).toEqual({
      user_id: "user_123",
      agent: "research",
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
