// The list-screen React hooks, one copy for the mobile app (Home, Projects,
// Upcoming). Kept per-app rather than in @zero/agent-core so the app's own React
// is the only instance (a workspace lib that called hooks would resolve its own
// React copy and break the rules-of-hooks dispatcher). The web app has its own
// mirror in apps/zero-web/src/lib/screen-hooks.ts.

import { useCallback, useEffect, useRef, useState } from 'react';

// True only after `active` has held continuously for `ms`. Resets the moment
// `active` goes false, so a fast hydrate never trips it. Delays the "Loading…"
// text so a cached cold start never flashes it.
export function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    // Reset in cleanup (not the effect body) so re-entering the active state
    // waits out the delay again, without a synchronous setState on mount.
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}

// Pull-to-refresh spinner state for a list screen. `onRefresh` sets `refreshing`
// true, awaits the replica refresh, then clears the spinner in a `finally`. A
// ref guards the trailing setState so a late resolve never lands on a torn-down
// screen. The RefreshControl's `refreshing` is controlled, so it stays up until
// this settles.
export function usePullRefresh(refetch: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        await refetch();
      } finally {
        if (mounted.current) setRefreshing(false);
      }
    })();
  }, [refetch]);
  return { refreshing, onRefresh };
}
