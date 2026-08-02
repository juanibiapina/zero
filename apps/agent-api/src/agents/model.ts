// The LLM seam's front door: resolve which provider and model a given agent
// runs on, then hand back a tagged `AgentModel`. The SDKs themselves live in
// model-openai.ts and model-anthropic.ts; everything downstream sees only the
// dependency-free `AgentModel` from protocol.ts.
//
// The provider is derived from the model id, not configured separately, so
// `MODEL_ID` alone decides where traffic goes and a rollback to Anthropic is a
// var flip plus a deploy, with no code change.

import type { AgentModel } from "./protocol";
import type { Env } from "../types";
import type { AiUsageAttribution } from "./ai-usage";
import type { AdapterOptions, AgentLabel } from "./model-options";
import { createAnthropicModel } from "./model-anthropic";
import { createOpenAIModel } from "./model-openai";

export type { AgentLabel } from "./model-options";

// Per-agent model overrides, empty on purpose. Zero runs one model everywhere;
// this is the lever for the agent whose quality is hardest to recover if the
// cheap tier is not good enough — the learner, which writes memory that
// persists. Adding an entry here is a code change
// on purpose: it is a quality decision, not an ops toggle.
export const AGENT_MODEL_OVERRIDES: Partial<Record<AgentLabel, string>> = {};

export type Provider = "openai" | "anthropic";

// Model ids are provider-shaped: `gpt-*` is OpenAI, `claude-*` is Anthropic.
// Anything unrecognized is treated as OpenAI, which is where Zero runs.
export const providerFor = (modelId: string): Provider =>
  modelId.startsWith("claude-") ? "anthropic" : "openai";

// The `cf-aig-metadata` value. Pure and exported so the exact tag shape is unit
// testable without reaching into an opaque client instance.
export const gatewayMetadata = (
  clerkUserId: string,
  agent: AgentLabel,
): string => JSON.stringify({ user_id: clerkUserId, agent });

// Resolve the provider base URL: an explicit override (dev/tests) wins,
// otherwise the AI Gateway binding builds it from account + gateway id.
const resolveBaseUrl = async (
  env: Env,
  provider: Provider,
): Promise<string> => {
  if (env.LLM_BASE_URL_OVERRIDE) return env.LLM_BASE_URL_OVERRIDE;
  return env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl(provider);
};

const build = (options: AdapterOptions): AgentModel =>
  providerFor(options.modelId) === "anthropic"
    ? createAnthropicModel(options)
    : createOpenAIModel(options);

// Build a per-agent model factory for one user. Base URLs are resolved once per
// provider (the only async step); the returned function stamps each model with
// its agent tag. Confined to the DO + orchestrator: agents downstream receive
// concrete tagged models, not this factory.
export const createModelFactory = async (
  env: Env,
  clerkUserId: string,
  fetchImpl?: typeof fetch,
  attribution?: AiUsageAttribution,
): Promise<(agent: AgentLabel) => AgentModel> => {
  const defaultModelId = env.MODEL_ID;
  // One lookup per provider actually in play, so the common case (no overrides)
  // makes exactly one gateway call.
  const baseUrls = new Map<Provider, string>();
  const providers = new Set<Provider>([providerFor(defaultModelId)]);
  for (const modelId of Object.values(AGENT_MODEL_OVERRIDES)) {
    providers.add(providerFor(modelId));
  }
  for (const provider of providers) {
    baseUrls.set(provider, await resolveBaseUrl(env, provider));
  }

  return (agent: AgentLabel): AgentModel => {
    const modelId = AGENT_MODEL_OVERRIDES[agent] ?? defaultModelId;
    return build({
      env,
      clerkUserId,
      agent,
      modelId,
      baseURL: baseUrls.get(providerFor(modelId)) ?? "",
      metadata: gatewayMetadata(clerkUserId, agent),
      fetchImpl,
      attribution,
    });
  };
};

// Single-model convenience over the factory, for callers outside a turn (e.g.
// onboarding). Defaults to the interface tag.
export const createModel = async (
  env: Env,
  clerkUserId: string,
  agent: AgentLabel = "interface",
  fetchImpl?: typeof fetch,
  attribution?: AiUsageAttribution,
): Promise<AgentModel> => {
  const makeModel = await createModelFactory(
    env,
    clerkUserId,
    fetchImpl,
    attribution,
  );
  return makeModel(agent);
};
