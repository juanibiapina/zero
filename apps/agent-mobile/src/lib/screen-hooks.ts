// The list-screen React hooks, one copy for the mobile app (Captures, Projects,
// Upcoming). Kept per-app rather than in @zero/agent-core so the app's own React
// is the only instance (a workspace lib that called hooks would resolve its own
// React copy and break the rules-of-hooks dispatcher). The web app has its own
// mirror in apps/agent-web/src/lib/screen-hooks.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

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

// The load-error channel an entity's data layer exposes.
export type LoadErrorSource = {
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

// Read a data layer's current load (sync) error, re-reading whenever it changes.
export function useLoadError(source: LoadErrorSource): string | null {
  const [error, setError] = useState<string | null>(() => source.getLoadError());
  useEffect(() => {
    const read = () => setError(source.getLoadError());
    read();
    return source.subscribeLoadError(read);
  }, [source]);
  return error;
}

// Refetch the entity's list when the app returns to the foreground, so a list
// changed elsewhere (Telegram, another device) shows up without a cold start.
export function useForegroundRefetch(refetch: () => void | Promise<void>): void {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => sub.remove();
  }, [refetch]);
}

// Pull-to-refresh spinner state for a list screen. `onRefresh` sets `refreshing`
// true, awaits the caller's refetch (a screen composes one call over every
// collection it shows), then clears the spinner — in a `finally` so a failed
// pull still stops spinning (the load-error channel surfaces the failure). A
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

