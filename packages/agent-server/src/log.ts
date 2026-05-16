// One JSON object per line; container stdout is forwarded into the same
// Workers Logs index the worker writes to. Conventions match
// apps/api/src/log.ts: snake_case fields, `service`+`msg` on every line,
// `logError` for failures, wrap Error instances with `fmtErr()`
// (workers-sdk#10513), no content/results/bodies as fields.

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
