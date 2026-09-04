// The list-screen React hooks, one copy for the web app (Captures, Projects,
// Upcoming). Kept per-app rather than in @zero/agent-core so the app's own React
// is the only instance (a workspace lib that called hooks would resolve its own
// React copy and break the rules-of-hooks dispatcher). The mobile app has its
// own mirror in apps/agent-mobile/src/lib/screen-hooks.ts.

import { useEffect, useState } from "react";

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

// Refetch the entity's list when the browser tab becomes visible again, so a
// list changed elsewhere (Telegram, another device) shows up without a cold
// start.
export function useForegroundRefetch(refetch: () => void | Promise<void>): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);
}
