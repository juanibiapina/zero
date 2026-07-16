import { describe, expect, it, vi } from "vitest";
import { createModel } from "./model";
import type { Env } from "../types";

const makeEnv = (over: Partial<Env> = {}): Env =>
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

describe("createModel", () => {
  it("builds a model for the configured MODEL_ID via the gateway", async () => {
    const getUrl = vi.fn(async () => "https://gw.example/zero/anthropic");
    const env = makeEnv({
      AI: { gateway: () => ({ getUrl }) },
    } as unknown as Partial<Env>);

    const model = await createModel(env, "user_123");

    expect(model).toMatchObject({ modelId: "claude-sonnet-4-6" });
    expect(getUrl).toHaveBeenCalledWith("anthropic");
  });

  it("honors LLM_BASE_URL_OVERRIDE and skips the gateway lookup", async () => {
    const getUrl = vi.fn(async () => "unused");
    const env = makeEnv({
      LLM_BASE_URL_OVERRIDE: "https://override.example/v1",
      AI: { gateway: () => ({ getUrl }) },
    } as unknown as Partial<Env>);

    const model = await createModel(env, "user_123");

    expect(model).toMatchObject({ modelId: "claude-sonnet-4-6" });
    expect(getUrl).not.toHaveBeenCalled();
  });
});
