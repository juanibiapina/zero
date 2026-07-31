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

// The blocks Zero produces or reads. Model responses may contain other block
// types (thinking, server tool use); those are round-tripped verbatim into the
// next request rather than reserialized, so they never need a type here.
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock;

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
}

// What the model reports about this request's prompt-cache prefix relative to
// the request named by `previousMessageId`. Chain-relative, NOT a cache
// hit/miss signal: a fully cached request can still report a divergence (see
// docs/caching.md).
export type CacheDiagnostic =
  // Zero passed no previous message id (first call of a run).
  | { state: "initial" }
  // A previous id was passed and the prefix matched it.
  | { state: "no_divergence" }
  // The comparison had not finished when the response was serialized.
  | { state: "pending" }
  | {
      state:
        | "model_changed"
        | "system_changed"
        | "tools_changed"
        | "messages_changed"
        | "previous_message_not_found"
        | "unavailable";
      missedInputTokens?: number;
    };

export interface AgentModelRequest {
  // Top-level system blocks (text only), in order. The last one usually carries
  // the 1h cache breakpoint.
  system: TextBlock[];
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  // The id of this client's previous response in the same run, for cache
  // divergence reporting. `null` opts in with nothing to compare against;
  // `undefined` opts out entirely.
  previousMessageId?: string | null;
  // True when `previousMessageId` names a response from an earlier run of this
  // conversation (the previous turn, or a run this one resumed) rather than from
  // this run's own loop. A divergence reported on such a request is a cross-turn
  // cache break, which has different causes from one inside a run, so the log
  // line has to distinguish them.
  crossRun?: boolean;
  // Zero-based index of this call within the run's tool loop, for per-step cache
  // diagnostics. Lets the adapter's cache_diagnostic line carry the step so the
  // write-then-read pattern is readable per agent per call.
  step?: number;
}

export interface AgentModelResponse {
  // The `msg_...` id, threaded into the next request's diagnostics.
  id: string;
  content: ContentBlock[];
  stopReason: StopReason | null;
  usage: TokenUsage;
  diagnostic: CacheDiagnostic;
}

// The seam every agent runs against. One method: send a request, get a
// response. Retries, timeouts, auth, and gateway attribution live behind it.
export interface AgentModel {
  // Identifies the model for logs and tests; not used for routing.
  modelId: string;
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
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
