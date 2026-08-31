import { createTimezoneSync, type TimezoneSync } from "@zero/agent-core";

// Web adapters for the shared timezone sync core. Web also derives `region` from
// the locale and sends it with the zone, so the gateway owns that here.

const STORE_KEY = "zero.timezone.synced";

export function createWebTimezoneSync(): TimezoneSync {
  return createTimezoneSync({
    clock: {
      zone: () => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        } catch {
          return null;
        }
      },
    },
    store: {
      read: async () => {
        try {
          return localStorage.getItem(STORE_KEY);
        } catch {
          return null;
        }
      },
      write: async (zone) => {
        try {
          localStorage.setItem(STORE_KEY, zone);
        } catch {
          // A blocked store just re-evaluates next open; the PATCH already ran.
        }
      },
    },
    gateway: {
      setTimezone: async (zone) => {
        let region: string | undefined;
        try {
          region = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).region;
        } catch {
          // The timezone stays useful when a browser reports an odd locale.
        }
        const res = await fetch("/api/user-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone: zone, ...(region ? { region } : {}) }),
        });
        if (!res.ok) throw new Error(`PATCH /api/user-settings failed: ${res.status}`);
      },
    },
  });
}
