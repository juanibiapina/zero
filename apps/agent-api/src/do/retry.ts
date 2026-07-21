// Shared helpers for Durable Object stub error handling and retry.
//
// Cloudflare DO stubs can throw errors with .retryable or .overloaded flags.
// A retryable error means the stub is broken and a fresh one is needed.
// Overloaded errors should never be retried.
//
// See: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/

export interface DOError {
  retryable?: boolean;
  overloaded?: boolean;
}

export const isDOError = (err: unknown): err is Error & DOError =>
  err instanceof Error;

export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 100;
export const MAX_BACKOFF_MS = 20_000;

export const doBackoff = (attempt: number): Promise<void> => {
  const ms = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * Math.random() * Math.pow(2, attempt),
  );
  return new Promise((r) => setTimeout(r, ms));
};

// ---------------------------------------------------------------------------
// withDORetry — Proxy-based retry for DO RPC stubs
// ---------------------------------------------------------------------------

/**
 * Wraps a DO stub so every method call retries on transient (.retryable)
 * errors, fetching a fresh stub between attempts. The returned object has
 * the same type as the stub, so callers are unaffected.
 */
export function withDORetry<S extends object>(getStub: () => S): S {
  let stub = getStub();

  return new Proxy({} as S, {
    get(_target, prop) {
      const value = (stub as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;

      return async (...args: unknown[]) => {
        let attempt = 0;
        while (true) {
          try {
            return await (stub as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args);
          } catch (err: unknown) {
            if (
              isDOError(err) &&
              err.retryable &&
              attempt + 1 < MAX_ATTEMPTS
            ) {
              await doBackoff(attempt);
              attempt++;
              stub = getStub();
              continue;
            }
            throw err;
          }
        }
      };
    },
  });
}
