/**
 * ============================================================================
 * Structured Logging (agent-server)
 * ============================================================================
 *
 * Every log line is a single JSON object on stdout/stderr. The Cloudflare
 * container forwards stdout into the same Workers Logs index that the
 * worker writes to, so the dashboard can filter on `service`, `msg`,
 * `tool_name`, etc. directly.
 *
 * Conventions:
 *   - snake_case field names
 *   - every log carries `service` (constant) and `msg` (event name)
 *   - failure paths use `logError` (Cloudflare maps console.error -> level=error)
 *   - `Error` instances must be passed through `fmtErr()` because the
 *     indexer serialises raw Error objects to `{}`
 *     (see github.com/cloudflare/workers-sdk/issues/10513)
 *   - no message content, no tool results, no request bodies in fields
 */

const SERVICE = "agent-server";

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
}

export const fmtErr = (err: unknown): FormattedError => {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
};
