import { describe, expect, it } from "vitest";

import { todoSyncPresentation } from "./sync-presentation";

describe("todo sync presentation", () => {
  it("distinguishes a reconnect from offline", () => {
    expect(todoSyncPresentation({
      signedIn: true,
      durable: true,
      sync: { phase: "connecting", lastSyncedAt: null },
    })).toMatchObject({ kind: "busy", label: "Connecting" });
    expect(todoSyncPresentation({
      signedIn: true,
      durable: true,
      sync: { phase: "offline", lastSyncedAt: null },
    })).toMatchObject({ kind: "offline", label: "Offline" });
  });

  it("prioritizes unsafe local persistence and labels guest work as device-local", () => {
    expect(todoSyncPresentation({
      signedIn: true,
      durable: false,
      sync: { phase: "synced", lastSyncedAt: null },
    }).kind).toBe("warning");
    expect(todoSyncPresentation({
      signedIn: false,
      durable: true,
      sync: { phase: "offline", lastSyncedAt: null },
    })).toMatchObject({ kind: "local", label: "Saved on this device" });
  });
});
