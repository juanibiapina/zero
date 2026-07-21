// One JSON object per line; Cloudflare Workers Logs auto-extracts fields.
// Conventions:
//   - snake_case field names
//   - every log carries `service` and `msg`
//   - failure paths use `logError` (mapped to level=error)
//   - wrap `Error` instances with `fmtErr()` (workers-sdk#10513 serialises
//     raw Error objects to `{}`)
//   - no message content, tool results, or request bodies in fields

const SERVICE = "worker";

type LogFields = Record<string, unknown>;

export const log = (msg: string, fields?: LogFields): void => {
  console.log({ service: SERVICE, msg, ...fields });
};

export const logError = (msg: string, fields?: LogFields): void => {
  console.error({ service: SERVICE, msg, ...fields });
};

export interface FormattedError {
  message: string;
  name?: string;
  stack?: string;
  // Present when the error is an AI SDK API error (AI_APICallError). These name
  // the exact upstream limit and its source: Anthropic 429s carry
  // `anthropic-ratelimit-*` + `retry-after`, and a Cloudflare AI Gateway
  // throttle carries `cf-aig-*` / `cf-ray`. Without them a 429 is unattributable.
  statusCode?: number;
  url?: string;
  rateLimitHeaders?: Record<string, string>;
  responseBody?: string;
}

// Headers worth keeping on an API error: rate-limit accounting, retry hints,
// and the gateway/Cloudflare trace ids that reveal whether the gateway (not
// Anthropic) returned the 429.
const RATE_LIMIT_HEADER = /ratelimit|retry-after|cf-aig|cf-ray/i;

const pickRateLimitHeaders = (
  headers: unknown,
): Record<string, string> | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (RATE_LIMIT_HEADER.test(k)) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const fmtErr = (err: unknown): FormattedError => {
  if (!(err instanceof Error)) return { message: String(err) };

  const base: FormattedError = {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };

  // AI_RetryError wraps the final upstream failure in `lastError`; unwrap so the
  // API-level detail (status, headers) is what we report.
  const apiErr =
    "lastError" in err && err.lastError instanceof Error
      ? err.lastError
      : err;
  const e = apiErr as unknown as Record<string, unknown>;

  if (typeof e.statusCode === "number") base.statusCode = e.statusCode;
  if (typeof e.url === "string") base.url = e.url;
  const rl = pickRateLimitHeaders(e.responseHeaders);
  if (rl) base.rateLimitHeaders = rl;
  if (typeof e.responseBody === "string") {
    base.responseBody = e.responseBody.slice(0, 500);
  }
  return base;
};
