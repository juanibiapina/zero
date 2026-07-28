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
  // Stamped only on a DO isolate reset (workerd setDurableObjectResetError,
  // src/workerd/jsg/util.c++). Distinct from `retryable`, which workerd sets on
  // *every* DISCONNECTED exception including plain network drops.
  durableObjectReset?: boolean;
}

export const isDOError = (err: unknown): err is Error & DOError =>
  err instanceof Error;

const RESET_MESSAGE = "Durable Object reset because its code was updated";

// True when a caught error is a DO isolate reset (the platform tore down the
// isolate mid-turn because a new Worker version deployed). The alarm's
// at-least-once retry re-runs such a turn, so the orchestrator defers to it
// instead of sending a fallback.
//
// The message-string branch is the evidence-backed path: it is what was
// actually observed reaching our catch in the 2026-07-27 incident. The
// `durableObjectReset` property is confirmed in workerd source but not observed
// in our own logs; we OR both so either signal triggers the deferral.
//
// Keys on `durableObjectReset`, NOT bare `retryable`: `retryable` is set on
// every DISCONNECTED (plain network drops included), which the alarm does not
// necessarily retry cleanly.
export const isDurableObjectReset = (err: unknown): boolean =>
  err instanceof Error &&
  ((err as Error & DOError).durableObjectReset === true ||
    err.message.includes(RESET_MESSAGE));

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
