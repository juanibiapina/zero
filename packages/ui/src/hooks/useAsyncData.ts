/**
 * ============================================================================
 * useAsyncData — the shared async-data-region seam
 * ============================================================================
 *
 * Owns the entire async lifecycle for a single fetch-backed region: run the
 * fetcher on mount and whenever `deps` change, flip `loading` on before each
 * run, and always clear it afterward via try/catch/finally so a rejected fetch
 * can never leave the page spinning. A per-run `cancelled` guard drops
 * stale/out-of-order responses (fast filter changes, unmount) so an older
 * result cannot overwrite a newer one. `reload` re-runs the current fetcher.
 *
 * The fetcher is injected and the hook does no I/O of its own, so one correct
 * implementation here pays back across every data page and its tests.
 */

import { useState, useEffect, useCallback, type DependencyList } from "react";

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `fetcher` is intentionally excluded: it is re-created every render, and
    // the caller declares the real inputs via `deps` (matching the previous
    // per-page useCallback pattern). `nonce` drives `reload`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
