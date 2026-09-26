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

