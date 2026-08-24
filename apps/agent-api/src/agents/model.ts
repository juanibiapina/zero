// The LLM seam's front door: resolve which model and effort a given agent runs
// on, then hand back a tagged `AgentModel`. The library that speaks to the
// providers (@earendil-works/pi-ai) lives behind the adapter in model-pi.ts;
// everything downstream sees only the dependency-free `AgentModel` from
// protocol.ts.
//
// Provider routing is not Zero's job any more: pi-ai's built-in
// cloudflare-ai-gateway provider routes by the model's own `api`, so a
// `MODEL_ID` flip from a `gpt-*` (Responses) id to a `claude-*` (Messages) id
// switches wire protocol with no code change. `providerFor` is kept only to
// document that property and for tests.

import type { AgentModel } from "./protocol";
import type { Env } from "../types";
import type { AiUsageAttribution } from "./ai-usage";
import { createPiModel } from "./model-pi";

// The agents that issue LLM calls. Each turn runs the interface agent (which may
// search the web in its own loop) then the writer; onboarding and admin tasks
// run alone.
export type AgentLabel =
  | "interface"
  | "learner"
  | "compaction"
  | "onboarding"
  | "admin_task";

// Per-agent model overrides, empty on purpose. Zero runs one model everywhere;
// this is the lever for the agent whose quality is hardest to recover if the
// cheap tier is not good enough — the learner, which writes memory that
// persists. Adding an entry here is a code change on purpose: it is a quality
// decision, not an ops toggle.
export const AGENT_MODEL_OVERRIDES: Partial<Record<AgentLabel, string>> = {};

// Reasoning effort on pi-ai's provider-neutral scale. The adapter maps this to
// each provider's own knob (OpenAI `reasoning.effort`, Anthropic thinking), so
// effort is decided once here rather than per provider. `minimal` is unsupported
// by some models (e.g. gpt-5.6-luna maps it to null) and is included only for
// completeness of the scale.
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// The one thing model selection decides: which model, at what effort. Everything
// the adapter needs to pick provider policy comes from these two values.
export interface ModelSpec {
  modelId: string;
  effort: Effort;
}

// The inputs a selection decision is allowed to see. Deliberately minimal today
// (agent + user); per-plan/per-cost fields attach here when those policies land,
// so the call sites do not have to change shape first.
export interface ModelSelection {
  agent: AgentLabel;
  clerkUserId: string;
}

// Every agent reasons at `high`. This is load-bearing: the model family defaults
// to `medium`, and Zero's quality case for the cheap tier rests on `high` (see
// docs/plans/openai-gpt56-luna.md). A silent drop here is a silent quality drop.
export const DEFAULT_EFFORT: Effort = "high";

// The single model+effort decision point. Today: the per-agent override or the
// configured MODEL_ID, always at the default effort. This is the one place
// future per-user/per-plan/per-cost policy attaches, so it stays a pure function
// of its inputs and the environment.
export const resolveModelSpec = (
  env: Env,
  selection: ModelSelection,
): ModelSpec => ({
  modelId: AGENT_MODEL_OVERRIDES[selection.agent] ?? env.MODEL_ID,
  effort: DEFAULT_EFFORT,
});

export type Provider = "openai" | "anthropic";

// Model ids are provider-shaped: `gpt-*` is OpenAI, `claude-*` is Anthropic.
// Anything unrecognized is treated as OpenAI, which is where Zero runs. Routing
// is pi-ai's job; this only documents the id convention.
export const providerFor = (modelId: string): Provider =>
  modelId.startsWith("claude-") ? "anthropic" : "openai";

// The `cf-aig-metadata` value. Pure and exported so the exact tag shape is unit
// testable without reaching into an opaque client instance.
export const gatewayMetadata = (
  clerkUserId: string,
  agent: AgentLabel,
): string => JSON.stringify({ user_id: clerkUserId, agent });

// Build a per-agent model factory for one user. pi-ai's provider owns the base
// URL (from the gateway env template), so there is no per-provider async
// resolution any more; the returned function stamps each model with its agent
// tag, resolved model id, and effort.
export const createModelFactory = async (
  env: Env,
  clerkUserId: string,
  fetchImpl?: typeof fetch,
  attribution?: AiUsageAttribution,
): Promise<(agent: AgentLabel) => AgentModel> => {
  return (agent: AgentLabel): AgentModel => {
    const { modelId, effort } = resolveModelSpec(env, { agent, clerkUserId });
    return createPiModel({
      env,
      clerkUserId,
      agent,
      modelId,
      effort,
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
