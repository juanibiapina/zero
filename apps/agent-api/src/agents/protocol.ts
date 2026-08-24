// The agent protocol: the message, tool, and model shapes every agent speaks.
// Deliberately Zero-owned and dependency-free — the runner (run.ts), the tools,
// and the prompt-cache helpers depend on this module, never on an SDK. The
// official Anthropic SDK is confined to the adapter in model.ts, which
// translates these shapes to and from the wire.
//
// The shapes mirror the Anthropic Messages wire format closely (snake_case
// block fields, `cache_control` in place) because that is what the prompt cache
// keys on: an intermediate representation would put a translation layer between
// the code that decides what to cache and the bytes that get cached.

import { z } from "zod";

export type CacheTtl = "5m" | "1h";

export interface CacheControl {
  type: "ephemeral";
  ttl?: CacheTtl;
}

export interface TextBlock {
  type: "text";
  text: string;
  // Assistant text only: whether the model labelled this as intermediate
  // commentary or its final answer. Recent models degrade when a replayed
  // assistant message loses its phase, so it is stored and sent back verbatim.
  phase?: "commentary" | "final_answer";
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControl;
}

// What a tool hands back to the model. A string is the common case; the block
// array carries images (view_image) so the model sees pixels, not base64.
export type ToolResultContent = string | Array<TextBlock | ImageBlock>;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
  cache_control?: CacheControl;
}

// The model's reasoning, returned ahead of the text blocks when thinking is on.
// `thinking` is empty when the provider omits the readable reasoning (what Zero
// requests); the opaque part must be round-tripped unmodified or the API rejects
// the request. Deliberately has no `cache_control`: a breakpoint on a reasoning
// block is invalid.
//
// The two providers identify reasoning differently, and the fields are named
// after each: `signature` is Anthropic's, while `id` + `encrypted_content` are
// the OpenAI reasoning item's. A block carrying the wrong provider's fields is
// dropped on the way to the model rather than translated — reasoning is never
// required for correctness, only for quality, so a conversation written under
// one provider stays usable under the other.
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
  id?: string;
  encrypted_content?: string;
}

// Reasoning the safety system flagged and encrypted wholesale. Opaque, and
// round-tripped exactly like a thinking block.
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

// The blocks Zero produces or reads. Model responses may still contain types
// Zero does not model (server tool use); those are round-tripped verbatim into
// the next request rather than reserialized, so they need no type here.
// Thinking is modelled because Zero has to *recognize* it: it must never carry a
// cache breakpoint and must never be rendered as prose.
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

// Blocks that may carry a `cache_control` breakpoint. Thinking blocks may not:
// Anthropic rejects a breakpoint on one (they are cached implicitly, with the
// prefix around them).
export const isCacheable = (
  block: ContentBlock,
): block is TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock =>
  block.type !== "thinking" && block.type !== "redacted_thinking";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// A tool as it goes on the wire. Key order is fixed at construction: the
// serialized bytes are part of the cached prefix, so an unstable order shows up
// as a `tools_changed` cache miss.
export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object" } & Record<string, unknown>;
  cache_control?: CacheControl;
}

// Anthropic's stop reasons, verbatim. `null` is a real wire value.
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "compaction"
  | "refusal"
  | "model_context_window_exceeded";

// Token counts for one model call. `inputTokens` is the uncached, full-price
// input; cache read/write are billed separately by Anthropic. See
// docs/caching.md for how these validate each caching tier.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  // Dollar cost of this one call, as reported by the provider layer (pi-ai's
  // `usage.cost.total`). Optional because a mock or a model with no catalog
  // price leaves it unset; readers treat missing as zero.
  costUsd?: number;
}

export interface AgentRunUsage extends TokenUsage {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  // Summed `costUsd` across every call in the run.
  costUsd: number;
  modelCalls: number;
}

export interface AgentModelRequest {
  // Top-level system blocks (text only), in order. The last one usually carries
  // the 1h cache breakpoint.
  system: TextBlock[];
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  // Zero-based index of this call within the run's tool loop. Lets the adapter's
  // cache_stats line carry the step, which is what makes the write-then-read
  // pattern readable per agent per call.
  step?: number;
}

export interface AgentModelResponse {
  // The provider's response id, persisted with the assistant row so a turn can
  // be traced back to a provider log line.
  id: string;
  content: ContentBlock[];
  stopReason: StopReason | null;
  usage: TokenUsage;
}

// The seam every agent runs against. One method: send a request, get a
// response. Retries, timeouts, auth, and gateway attribution live behind it.
export interface AgentModel {
  // Identifies the model for logs and tests; not used for routing.
  modelId: string;
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
  // Optional telemetry hook. The runner invokes it once per agent execution,
  // including a partially successful execution that later throws.
  reportRunUsage?(usage: AgentRunUsage): void;
}

// A tool the runner can dispatch. `execute` receives input already validated
// against `inputSchema`; a thrown error becomes an error tool_result rather
// than failing the run (the interface agent's send path depends on this).
export interface AgentTool<Input = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<unknown>;
  // Optional custom serialization of the tool's output into result blocks.
  // Defaults to a string passthrough / deterministic JSON.
  toContent?: (output: unknown) => {
    content: ToolResultContent;
    isError?: boolean;
  };
  // True for a call that changes the world outside Zero and cannot be replayed
  // (sending mail, creating a calendar event). The runner claims such a call
  // durably before it leaves and refuses to repeat one whose outcome is unknown.
  externalWrite?: boolean;
}

export type AgentToolSet = Record<string, AgentTool>;

// Define a tool with input inferred from its Zod schema. The cast is the whole
// point of the helper: it keeps `execute` typed at the definition site while the
// tool set stays homogeneous (`AgentTool<unknown>`) for the runner.
export const defineTool = <Schema extends z.ZodType>(def: {
  description: string;
  inputSchema: Schema;
  execute: (input: z.output<Schema>) => Promise<unknown>;
  toContent?: AgentTool["toContent"];
  externalWrite?: boolean;
}): AgentTool => def as unknown as AgentTool;

// Convert a tool set into wire definitions, preserving insertion order. Key
// order inside each definition is fixed here for cache stability.
export const toToolDefinitions = (
  tools: AgentToolSet,
): AgentToolDefinition[] =>
  Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    input_schema: z.toJSONSchema(
      tool.inputSchema,
    ) as AgentToolDefinition["input_schema"],
  }));
