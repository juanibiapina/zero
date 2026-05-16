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
}

export const fmtErr = (err: unknown): FormattedError => {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
};
