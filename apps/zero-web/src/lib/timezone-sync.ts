import { createTimezoneSync, type TimezoneSync } from "@zero/agent-core";

// Web adapters for the shared timezone sync core.

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
        const res = await fetch("/api/user-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone: zone }),
        });
        if (!res.ok) throw new Error(`PATCH /api/user-settings failed: ${res.status}`);
      },
    },
  });
}
