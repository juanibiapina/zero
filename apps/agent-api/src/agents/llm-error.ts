// Classifies a thrown turn error as an LLM capacity condition (rate limit,
// usage/spend cap, or transient overload) so the orchestrator can show a
// clear message instead of the generic fallback. Pure, no I/O.

// Walk .lastError (AI_RetryError) and .cause (ToolExecutionError, wrapped fetch
// errors) to find an underlying API error's status code. The depth guard caps
// recursion so a cyclic or pathologically deep chain can't loop forever.
const statusOf = (err: unknown, depth = 0): number | undefined => {
  if (depth > 5 || !err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.statusCode === "number") return e.statusCode;
  return statusOf(e.lastError, depth + 1) ?? statusOf(e.cause, depth + 1);
};

export const isRateLimitError = (err: unknown): boolean => {
  const status = statusOf(err);
  return status === 429 || status === 529;
};

export const RATE_LIMIT_MESSAGE =
  "I've hit my usage limit for now, so I can't get to that just yet. " +
  "Please try again in a little while.";
