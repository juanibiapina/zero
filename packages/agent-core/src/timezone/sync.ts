// Silent automatic timezone sync, shared by web + mobile. See docs/timezone.md.
//
// The core compares the device zone to a persisted baseline (the store) and
// PATCHes only when they differ, so the steady state issues no network. Three
// injected ports keep it DOM-free; each surface supplies its own adapters.

// The OS timezone.
export type DeviceClock = { zone: () => string | null };

// The persisted baseline: the last zone we believe the server holds. Must
// survive relaunch, or every cold start would PATCH.
export type TimezoneStore = {
  read: () => Promise<string | null>;
  write: (zone: string) => Promise<void>;
};

// Our own API.
export type SettingsGateway = { setTimezone: (zone: string) => Promise<void> };

export type TimezoneSyncDeps = {
  clock: DeviceClock;
  store: TimezoneStore;
  gateway: SettingsGateway;
};

// Canonical IANA name or "UTC". One implementation in both runtimes, so it lives
// in the core. The server 400s junk when supportedValuesOf is unavailable.
export function isCanonicalZone(zone: string): boolean {
  try {
    return zone === "UTC" || Intl.supportedValuesOf("timeZone").includes(zone);
  } catch {
    return zone.length > 0;
  }
}

async function reconcile(deps: TimezoneSyncDeps, baseline: string | null): Promise<void> {
  const zone = deps.clock.zone();
  if (!zone || !isCanonicalZone(zone)) return;
  if (zone === baseline) return;
  await deps.gateway.setTimezone(zone);
  await deps.store.write(zone); // advance the baseline only on a confirmed write
}

export type TimezoneSync = {
  // Run once when the signed-in tree mounts. If the app already fetched the
  // server's zone, pass it as `serverZone`: it seeds the store and baseline.
  onColdStart: (serverZone?: string | null) => Promise<void>;
  // Run on warm foreground (mobile AppState -> active). Baseline is the store.
  onForeground: () => Promise<void>;
};

// The in-flight guard coalesces concurrent triggers. Failures are swallowed: a
// failed PATCH leaves the store untouched, so it retries on the next trigger.
export function createTimezoneSync(deps: TimezoneSyncDeps): TimezoneSync {
  let inFlight: Promise<void> | null = null;

  const run = (baseline: () => Promise<string | null>): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await reconcile(deps, await baseline());
      } catch {
        // Silent: timezone is background plumbing.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    onColdStart: (serverZone?: string | null) =>
      run(async () => {
        if (serverZone && isCanonicalZone(serverZone)) {
          await deps.store.write(serverZone);
          return serverZone;
        }
        return deps.store.read();
      }),
    onForeground: () => run(() => deps.store.read()),
  };
}
