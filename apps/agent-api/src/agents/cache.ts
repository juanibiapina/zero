// Prompt-caching helpers. Anthropic caches a request's stable prefix in the
// order tools -> system -> messages; we place up to 4 `cache_control`
// breakpoints over that prefix so a later request that shares the byte-identical
// prefix reads it from cache (~0.1x price) instead of re-billing it. This module
// hides the wire placement behind named intent so run.ts and interface.ts
// express *what* to cache, not where the field goes. See docs/caching.md.
//
// Four is the API maximum, and Zero spends all four: tools, system, a caller
// anchor (the interface agent's last stable history message), and the loop's
// sliding breakpoint on the growing tail. The tool loop advances the sliding
// breakpoint to the new tail each step instead of accumulating more.

import type {
  AgentMessage,
  AgentToolDefinition,
  CacheControl,
  CacheTtl,
  ContentBlock,
  TextBlock,
} from "./protocol";

export type { CacheTtl };

// The breakpoint marker itself. `ttl` defaults to 5m at the API; pass "1h" for
// the shared, high-reuse prefixes (tools, static system) where the higher write
// premium is amortized over huge read volume.
export const cacheControl = (ttl?: CacheTtl): CacheControl => ({
  type: "ephemeral" as const,
  ...(ttl ? { ttl } : {}),
});

// The top-level `system` field as a single text block carrying a breakpoint.
// A bare system string cannot carry cache_control, hence the block form.
export const cachedSystem = (text: string, ttl?: CacheTtl): TextBlock[] => [
  { type: "text", text, cache_control: cacheControl(ttl) },
];

// Mark the last tool definition with a breakpoint. Anthropic caches the whole
// serialized tool block up to this marker, so one breakpoint on the final tool
// covers every tool schema. Order-preserving; returns a new array so callers
// keep their originals untouched.
export const markLastTool = (
  tools: AgentToolDefinition[],
  ttl?: CacheTtl,
): AgentToolDefinition[] => {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: cacheControl(ttl) }];
};

// Add a breakpoint to a message. The marker goes on the message's last content
// block (a string content is promoted to a single text block). Used for the
// messages-region sliding window (last stable message + current message).
export const markCacheBreakpoint = (
  message: AgentMessage,
  ttl?: CacheTtl,
): AgentMessage => {
  const blocks: ContentBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (blocks.length === 0) return message;
  const last = blocks[blocks.length - 1];
  return {
    ...message,
    content: [
      ...blocks.slice(0, -1),
      { ...last, cache_control: cacheControl(ttl) },
    ],
  };
};

// The loop-owned sliding message-region breakpoint. Called on a per-request
// snapshot of the messages array before every step: it marks the LAST message
// so a cache write always sits within Anthropic's 20-block lookback of the
// growing tail (see docs/caching.md). Because it advances to the new tail each
// step, step N reads everything through step N-1 and writes only step N-1's
// delta — the write-then-read pattern that caches a growing conversation.
//
// Pure: returns a new array and marks a clone of the last message, so the
// runner's persisted `messages` and the model's verbatim round-tripped blocks
// stay clean. Exactly one sliding breakpoint is added, at the tail; any caller
// anchor breakpoint earlier in the array is preserved untouched. This keeps the
// per-request budget within the 4-breakpoint API max (tools + system + anchor +
// sliding). An empty array is returned unchanged (nothing to mark).
export const slideMessageBreakpoint = (
  messages: AgentMessage[],
  ttl?: CacheTtl,
): AgentMessage[] => {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  return [
    ...messages.slice(0, lastIdx),
    markCacheBreakpoint(messages[lastIdx], ttl),
  ];
};
