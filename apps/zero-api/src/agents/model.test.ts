import { describe, expect, it } from "vitest";
import {
  gatewayMetadata,
  providerFor,
  resolveModelSpec,
  AGENT_MODEL_OVERRIDES,
  AGENT_EFFORT_OVERRIDES,
} from "./model";
import { createGatewayModels, gatewayModelChoices, providerId } from "../assistant/models";
import type { Env } from "../types";

const makeEnv = (over: Record<string, unknown> = {}): Env =>
  ({
    MODEL_ID: "gpt-6-luna",
    CLOUDFLARE_GATEWAY_ID: "zero",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_KEY: "cf-key",
    LLM_BASE_URL_OVERRIDE: "",
    ...over,
  }) as unknown as Env;

describe("providerFor", () => {
  it("routes by model id so MODEL_ID alone picks the provider", () => {
    expect(providerFor("gpt-6-luna")).toBe("openai");
    expect(providerFor("gpt-5.6-terra")).toBe("openai");
    expect(providerFor("claude-sonnet-4-6")).toBe("anthropic");
  });
});

describe("resolveModelSpec", () => {
  it("returns the configured MODEL_ID at the default high effort", () => {
    expect(
      resolveModelSpec(makeEnv(), { agent: "interface", clerkUserId: "u" }),
    ).toEqual({ modelId: "gpt-6-luna", effort: "high" });
  });

  it("has no effort overrides, so every agent reasons at high", () => {
    expect(AGENT_EFFORT_OVERRIDES).toEqual({});
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
      ).toBe("gpt-6-luna");
    } finally {
      delete (AGENT_MODEL_OVERRIDES as Record<string, string>).learner;
    }
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


describe("gateway models", () => {
  it("gives every agent its own provider carrying its attribution tag", () => {
    const env = makeEnv();
    const models = createGatewayModels(env, "user_123");
    const choices = gatewayModelChoices(env, "user_123");
    for (const agent of ["interface", "learner", "compaction"] as const) {
      const { model } = choices(agent);
      expect(model).toEqual({ provider: providerId(agent), modelId: "gpt-6-luna" });
      const resolved = models.getModel(model.provider, model.modelId);
      expect(JSON.parse(resolved?.headers?.["cf-aig-metadata"] ?? "{}")).toEqual({
        user_id: "user_123",
        agent,
      });
    }
  });

  it("thinks at the default high effort", () => {
    expect(gatewayModelChoices(makeEnv(), "u")("interface").thinkingLevel).toBe("high");
  });

  it("sends requests to the override when one is set", () => {
    const env = makeEnv({ LLM_BASE_URL_OVERRIDE: "http://localhost:3502" });
    const models = createGatewayModels(env, "u");
    expect(models.getModel(providerId("interface"), "gpt-6-luna")?.baseUrl).toBe(
      "http://localhost:3502",
    );
  });

  it("resolves a catalog model for a rollback by MODEL_ID", () => {
    const env = makeEnv({ MODEL_ID: "claude-sonnet-4-6" });
    const { model } = gatewayModelChoices(env, "u")("interface");
    expect(createGatewayModels(env, "u").getModel(model.provider, model.modelId)?.api).toBe(
      "anthropic-messages",
    );
  });
});
