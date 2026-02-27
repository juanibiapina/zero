/**
 * ============================================================================
 * Retry Utility
 * ============================================================================
 *
 * Generic retry helper with exponential backoff for critical operations
 * that must not fail silently (e.g. R2 snapshot save/restore).
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base backoff in milliseconds. Doubles on each retry. Default: 1000. */
  backoffMs?: number;
  /** Label for log messages. */
  label?: string;
}

/**
 * Run `fn` up to `maxAttempts` times with exponential backoff.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, backoffMs = 1000, label = "operation" } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.error(`[retry] ${label} failed after ${maxAttempts} attempts`);
  throw lastError;
}
