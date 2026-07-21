// Prompt-caching helpers. Anthropic caches a request's stable prefix in the
// order tools -> system -> messages; we place up to 4 `cache_control`
// breakpoints over that prefix so a later request that shares the byte-identical
// prefix reads it from cache (~0.1x price) instead of re-billing it. This module
// hides the provider-option wire shape behind named intent so run.ts and
// interface.ts express *what* to cache, not the format. See docs/caching.md.

import type { ModelMessage, ToolSet } from "ai";

export type CacheTtl = "5m" | "1h";

// The providerOptions blob that marks a cache breakpoint for Anthropic. `ttl`
// defaults to 5m at the provider; pass "1h" for the shared, high-reuse prefixes
// (tools, static system) where the higher write premium is amortized over huge
// read volume.
export const cacheControl = (ttl?: CacheTtl) => ({
  anthropic: {
    cacheControl: { type: "ephemeral" as const, ...(ttl ? { ttl } : {}) },
  },
});

// A leading system message carrying a cache breakpoint. Passed as the first
// entry of the messages array (with allowSystemInMessages) so the SDK hoists it
// to the top-level `system` field and honors its cache_control. The string
// `system` param cannot carry cache_control, hence the conversion to a message.
export const cachedSystemMessage = (
  text: string,
  ttl?: CacheTtl,
): ModelMessage => ({
  role: "system",
  content: text,
  providerOptions: cacheControl(ttl),
});

// Mark the last tool in the set with a cache breakpoint. Anthropic caches over
// the whole serialized tool block up to this marker, so one breakpoint on the
// final tool covers every tool schema. Order-preserving; returns a new set so
// callers keep their original tools untouched.
export const markLastTool = (tools: ToolSet, ttl?: CacheTtl): ToolSet => {
  const keys = Object.keys(tools);
  if (keys.length === 0) return tools;
  const lastKey = keys[keys.length - 1];
  return {
    ...tools,
    [lastKey]: { ...tools[lastKey], providerOptions: cacheControl(ttl) },
  };
};

// Add a cache breakpoint to a message, preserving its content. The provider
// applies message-level cache_control to the message's last content block. Used
// for the messages-region sliding window (last stable message + current
// message).
export const markCacheBreakpoint = (
  message: ModelMessage,
  ttl?: CacheTtl,
): ModelMessage => ({ ...message, providerOptions: cacheControl(ttl) });
