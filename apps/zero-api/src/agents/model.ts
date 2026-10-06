// Which model and effort each agent runs on, and the gateway attribution tag.
// Provider routing is pi-ai's job: a `MODEL_ID` flip from a `gpt-*` (Responses)
// id to a `claude-*` (Messages) id switches wire protocol with no code change.
// assistant/models.ts turns these choices into pi-ai providers.

import type { Env } from "../types";

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
// effort is decided once here rather than per provider. `minimal` is included
// for completeness of the scale; the selected agents use `low` or `high`.
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

// Per-agent effort overrides, mirroring AGENT_MODEL_OVERRIDES. Empty: every
// agent reasons at `high`. Adding an entry is a code change on purpose.
export const AGENT_EFFORT_OVERRIDES: Partial<Record<AgentLabel, Effort>> = {};

// The single model+effort decision point. Today: the per-agent override or the
// configured MODEL_ID, always at the default effort. This is the one place
// future per-user/per-plan/per-cost policy attaches, so it stays a pure function
// of its inputs and the environment.
export const resolveModelSpec = (
  env: Env,
  selection: ModelSelection,
): ModelSpec => ({
  modelId: AGENT_MODEL_OVERRIDES[selection.agent] ?? env.MODEL_ID,
  effort: AGENT_EFFORT_OVERRIDES[selection.agent] ?? DEFAULT_EFFORT,
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
