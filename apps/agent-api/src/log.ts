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
  // Present when the error is an Anthropic SDK APIError. These name the exact
  // upstream limit and its source: Anthropic 429s carry `anthropic-ratelimit-*`
  // + `retry-after`, and a Cloudflare AI Gateway throttle carries `cf-aig-*` /
  // `cf-ray`. Without them a 429 is unattributable. `requestId` is Anthropic's
  // own request id, the handle for a support escalation.
  statusCode?: number;
  requestId?: string;
  rateLimitHeaders?: Record<string, string>;
  responseBody?: string;
}

// Headers worth keeping on an API error: rate-limit accounting, retry hints,
// and the gateway/Cloudflare trace ids that reveal whether the gateway (not
// Anthropic) returned the 429.
const RATE_LIMIT_HEADER = /ratelimit|retry-after|cf-aig|cf-ray/i;

// Accepts either a `Headers` instance (what the Anthropic SDK attaches) or a
// plain record.
const pickRateLimitHeaders = (
  headers: unknown,
): Record<string, string> | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  const entries =
    typeof (headers as Headers).forEach === "function" &&
    typeof (headers as Headers).get === "function"
      ? [...(headers as Headers).entries()]
      : Object.entries(headers as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
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

  // A transport failure can arrive wrapped; report the API-level detail
  // (status, headers) from the innermost error that carries one.
  const apiErr =
    typeof (err as unknown as Record<string, unknown>).status !== "number" &&
    err.cause instanceof Error
      ? err.cause
      : err;
  const e = apiErr as unknown as Record<string, unknown>;

  if (typeof e.status === "number") base.statusCode = e.status;
  if (typeof e.requestID === "string") base.requestId = e.requestID;
  const rl = pickRateLimitHeaders(e.headers);
  if (rl) base.rateLimitHeaders = rl;
  // The SDK parses the error body; serialize it back for the log line.
  if (e.error !== undefined && e.error !== null) {
    const body =
      typeof e.error === "string" ? e.error : JSON.stringify(e.error);
    base.responseBody = body?.slice(0, 500);
  }
  return base;
};
