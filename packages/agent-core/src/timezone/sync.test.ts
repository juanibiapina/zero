import { describe, expect, it, vi } from "vitest";

import {
  createTimezoneSync,
  isCanonicalZone,
  type DeviceClock,
  type SettingsGateway,
  type TimezoneStore,
} from "./sync";

// The three ports as in-memory fakes; tests drive the module through its interface.
function harness(opts: { zone?: string | null; stored?: string | null; fail?: boolean } = {}) {
  const map = new Map<string, string>();
  if (opts.stored != null) map.set("k", opts.stored);

  let zone: string | null = opts.zone ?? "Europe/Berlin";
  const clock: DeviceClock = { zone: () => zone };

  const store: TimezoneStore = {
    read: async () => map.get("k") ?? null,
    write: async (z) => {
      map.set("k", z);
    },
  };

  const setTimezone = vi.fn(async (_z: string) => {
    if (opts.fail) throw new Error("PATCH failed");
  });
  const gateway: SettingsGateway = { setTimezone };

  return {
    sync: createTimezoneSync({ clock, store, gateway }),
    setTimezone,
    setZone: (z: string | null) => {
      zone = z;
    },
    stored: () => map.get("k") ?? null,
  };
}

describe("isCanonicalZone", () => {
  it("accepts canonical IANA names and UTC, rejects junk", () => {
    expect(isCanonicalZone("Europe/Berlin")).toBe(true);
    expect(isCanonicalZone("UTC")).toBe(true);
    expect(isCanonicalZone("Not/AZone")).toBe(false);
    expect(isCanonicalZone("")).toBe(false);
  });
});

describe("createTimezoneSync", () => {
  it("does nothing when the device zone equals the stored baseline", async () => {
    const h = harness({ zone: "Europe/Berlin", stored: "Europe/Berlin" });
    await h.sync.onForeground();
    expect(h.setTimezone).not.toHaveBeenCalled();
  });

  it("PATCHes once and advances the store when the zone changed", async () => {
    const h = harness({ zone: "America/New_York", stored: "Europe/Berlin" });
    await h.sync.onForeground();
    expect(h.setTimezone).toHaveBeenCalledTimes(1);
    expect(h.setTimezone).toHaveBeenCalledWith("America/New_York");
    expect(h.stored()).toBe("America/New_York");
  });

  it("PATCHes on a fresh install (empty store)", async () => {
    const h = harness({ zone: "Europe/Berlin", stored: null });
    await h.sync.onForeground();
    expect(h.setTimezone).toHaveBeenCalledTimes(1);
    expect(h.stored()).toBe("Europe/Berlin");
  });

  it("never sends a non-canonical device zone", async () => {
    const h = harness({ zone: "Not/AZone", stored: "Europe/Berlin" });
    await h.sync.onForeground();
    expect(h.setTimezone).not.toHaveBeenCalled();
  });

  it("never sends when the device reports no zone", async () => {
    const h = harness({ zone: null, stored: "Europe/Berlin" });
    await h.sync.onForeground();
    expect(h.setTimezone).not.toHaveBeenCalled();
  });

  it("does not advance the store when the PATCH fails, so it retries", async () => {
    const h = harness({ zone: "America/New_York", stored: "Europe/Berlin", fail: true });
    await h.sync.onForeground();
    expect(h.setTimezone).toHaveBeenCalledTimes(1);
    expect(h.stored()).toBe("Europe/Berlin");
  });

  it("coalesces concurrent foreground calls into one PATCH", async () => {
    const h = harness({ zone: "America/New_York", stored: "Europe/Berlin" });
    await Promise.all([h.sync.onForeground(), h.sync.onForeground()]);
    expect(h.setTimezone).toHaveBeenCalledTimes(1);
  });

  it("onColdStart adopts a serverZone baseline before comparing", async () => {
    const h = harness({ zone: "Europe/Berlin", stored: null });
    await h.sync.onColdStart("Europe/Berlin");
    expect(h.setTimezone).not.toHaveBeenCalled();
    expect(h.stored()).toBe("Europe/Berlin");
  });

  it("onColdStart PATCHes when the serverZone differs from the device", async () => {
    const h = harness({ zone: "America/New_York", stored: null });
    await h.sync.onColdStart("Europe/Berlin");
    expect(h.setTimezone).toHaveBeenCalledTimes(1);
    expect(h.setTimezone).toHaveBeenCalledWith("America/New_York");
    expect(h.stored()).toBe("America/New_York");
  });

  it("onColdStart ignores a junk serverZone and falls back to the store", async () => {
    const h = harness({ zone: "Europe/Berlin", stored: "Europe/Berlin" });
    await h.sync.onColdStart("Not/AZone");
    expect(h.setTimezone).not.toHaveBeenCalled();
    expect(h.stored()).toBe("Europe/Berlin");
  });
});
