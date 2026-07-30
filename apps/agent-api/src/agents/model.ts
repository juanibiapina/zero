// LLM adapter (the true-external seam): the only module that knows the official
// Anthropic SDK exists. Both agents get their model here so gateway routing and
// per-user attribution live in one place; everything downstream sees the
// dependency-free `AgentModel` from protocol.ts.
//
// Traffic goes through the Cloudflare AI Gateway (not the raw Anthropic API):
// - `x-api-key` is deliberately suppressed (`defaultHeaders: { "x-api-key":
//   null }`). Under BYOK the gateway injects the stored Anthropic key, and a
//   client-sent key would override it. `apiKey` is still a non-null dummy:
//   with a null apiKey the SDK starts its credential-resolution chain, which in
//   workerd believes it is on Node and latches any resolution error into the
//   client forever.
// - `cf-aig-authorization: Bearer <CLOUDFLARE_API_KEY>` authenticates to the
//   gateway, which injects the stored Anthropic key upstream.
// - `cf-aig-metadata: {"user_id": clerkUserId, "agent": agent}` reproduces
//   per-user analytics and split-by-value spend limits, and tags which agent
//   (interface / research / writer / onboarding) issued the call so the gateway
//   can break down cost, tokens, and latency per agent. Headers are
//   per-instance, so a fresh client is built per agent to tag each request.

import { Anthropic } from "@anthropic-ai/sdk/client";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";
import type {
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  CacheDiagnostic,
  ContentBlock,
  TokenUsage,
} from "./protocol";
import { log } from "../log";
import type { Env } from "../types";

// The agents that issue LLM calls. Each turn runs the interface agent (which
// may spawn research) then the writer; onboarding and admin tasks run alone.
export type AgentLabel =
  | "interface"
  | "research"
  | "writer"
  | "onboarding"
  | "admin_task";

// Reports how this request's prompt prefix diverged from the previous request in
// the same run. Sent on every request (even before anything reads it) so the
// request bytes stay stable, and with them the cache entries.
const CACHE_DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07";

// Required by the API. With an explicit client `timeout` the SDK stops deriving
// its own non-streaming ceiling, so this is a product choice: far above any
// reply or topic body Zero has ever produced, low enough that a runaway
// generation is bounded.
const MAX_TOKENS = 16000;

// Per-attempt request timeout. The SDK default is 600s, an unhelpfully long
// abort inside a DO alarm. Retries are bounded too, so a 429 burst cannot
// stretch a turn indefinitely.
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

// The `cf-aig-metadata` value. Pure and exported so the exact tag shape is unit
// testable without reaching into an opaque client instance.
export const gatewayMetadata = (
  clerkUserId: string,
  agent: AgentLabel,
): string => JSON.stringify({ user_id: clerkUserId, agent });

// Resolve the Anthropic base URL: an explicit override (dev/tests) wins,
// otherwise the AI Gateway binding builds it from account + gateway id.
const resolveBaseUrl = async (env: Env): Promise<string> => {
  if (env.LLM_BASE_URL_OVERRIDE) return env.LLM_BASE_URL_OVERRIDE;
  return env.AI.gateway(env.CLOUDFLARE_GATEWAY_ID).getUrl("anthropic");
};

const toUsage = (usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage => ({
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
});

// Translate the response's diagnostics envelope into Zero's local states. The
// wire cannot distinguish "no divergence" from "there was nothing to compare
// against", so the caller's own `previousMessageId` decides which it was.
export const toDiagnostic = (
  diagnostics: { cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null } | null | undefined,
  previousMessageId: string | null | undefined,
): CacheDiagnostic => {
  if (previousMessageId === undefined) return { state: "initial" };
  if (diagnostics === null || diagnostics === undefined) {
    return previousMessageId === null
      ? { state: "initial" }
      : { state: "no_divergence" };
  }
  const reason = diagnostics.cache_miss_reason;
  if (reason === null) return { state: "pending" };
  return {
    state: reason.type as Exclude<
      CacheDiagnostic,
      { state: "initial" | "no_divergence" | "pending" }
    >["state"],
    ...(typeof reason.cache_missed_input_tokens === "number"
      ? { missedInputTokens: reason.cache_missed_input_tokens }
      : {}),
  };
};

// Build a per-agent model factory for one user. The base URL is resolved once
// (the only async step); the returned function stamps each model with the
// agent tag. Confined to the DO + orchestrator: agents downstream receive
// concrete tagged models, not this factory.
export const createModelFactory = async (
  env: Env,
  clerkUserId: string,
  // Test seam: the request bytes are what the prompt cache keys on, so tests
  // assert on them by intercepting the transport. Production passes nothing.
  fetchImpl?: typeof fetch,
): Promise<(agent: AgentLabel) => AgentModel> => {
  const baseURL = await resolveBaseUrl(env);
  const modelId = env.MODEL_ID;
  return (agent: AgentLabel): AgentModel => {
    const client = new Anthropic({
      apiKey: "gateway-byok",
      baseURL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      defaultHeaders: {
        // Suppress the SDK's own auth header; the gateway supplies the key.
        "x-api-key": null,
        "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_API_KEY}`,
        "cf-aig-metadata": gatewayMetadata(clerkUserId, agent),
      },
    });
    return {
      modelId,
      generate: async (
        request: AgentModelRequest,
      ): Promise<AgentModelResponse> => {
        const response = await client.beta.messages.create({
          model: modelId,
          max_tokens: MAX_TOKENS,
          system: request.system,
          tools: request.tools,
          // Cast: the protocol types an image block's media type as a plain
          // string (attachment MIME types come from Telegram at runtime), while
          // the SDK narrows it to the four types the API accepts. An
          // unsupported type is rejected upstream, not here.
          messages: request.messages as BetaMessageParam[],
          betas: [CACHE_DIAGNOSIS_BETA],
          ...(request.previousMessageId !== undefined
            ? { diagnostics: { previous_message_id: request.previousMessageId } }
            : {}),
        });
        const usage = toUsage(response.usage);
        const diagnostic = toDiagnostic(
          response.diagnostics,
          request.previousMessageId,
        );
        // Content-free: state and token counts only, never prompts, responses,
        // or response ids. The cache read/write counts ride along because a
        // divergence state is chain-relative and can coexist with a full cache
        // hit (docs/caching.md). `input_tokens` (uncached, full-price) and the
        // loop `step` make the write-then-read pattern readable per agent per
        // call: on a working message-region cache, read grows step-over-step
        // while input stays small.
        log("cache_diagnostic", {
          agent,
          ...(request.step !== undefined ? { step: request.step } : {}),
          state: diagnostic.state,
          // Whether the comparison crossed a turn boundary: a divergence here
          // means the conversation prefix changed between turns, not within a
          // run.
          chain_crossed_turn: request.crossRun === true,
          ...("missedInputTokens" in diagnostic &&
          diagnostic.missedInputTokens !== undefined
            ? { cache_missed_input_tokens: diagnostic.missedInputTokens }
            : {}),
          input_tokens: usage.inputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
        });
        return {
          id: response.id,
          content: response.content as unknown as ContentBlock[],
          stopReason: response.stop_reason,
          usage,
          diagnostic,
        };
      },
    };
  };
};

// Single-model convenience over the factory, for callers outside a turn (e.g.
// onboarding). Defaults to the interface tag.
export const createModel = async (
  env: Env,
  clerkUserId: string,
  agent: AgentLabel = "interface",
  fetchImpl?: typeof fetch,
): Promise<AgentModel> => {
  const makeModel = await createModelFactory(env, clerkUserId, fetchImpl);
  return makeModel(agent);
};
