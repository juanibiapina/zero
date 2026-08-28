import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import { createInMemoryApi, type CapturesRest } from "./collection";
import type { Capture } from "./types";

// A fake Captures server with a small latency so the optimistic overlay and the
// reconciling refetch resolve on separate ticks, which is when the flicker
// showed up (the processed row briefly reappearing between the two).
function fakeRest(initial: Capture[]): CapturesRest {
  const server = initial.map((c) => ({ ...c }));
  return {
    fetchInbox: async () => {
      await sleep(5);
      return server.filter((c) => c.processedAt == null).map((c) => ({ ...c }));
    },
    addCapture: async ({ id, text }) => {
      await sleep(5);
      const existing = server.find((c) => c.id === id);
      if (existing) return { ...existing };
      const capture: Capture = {
        id,
        text,
        createdAt: new Date().toISOString(),
        processedAt: null,
      };
      server.push(capture);
      return { ...capture };
    },
    processCapture: async (id) => {
      await sleep(5);
      const capture = server.find((c) => c.id === id);
      if (!capture) throw new Error(`no capture ${id}`);
      capture.processedAt = new Date().toISOString();
      return { ...capture };
    },
  };
}

describe("captures collection", () => {
  it("processing a capture removes it once, without a reappear flicker", async () => {
    const api = createInMemoryApi({
      queryClient: new QueryClient(),
      rest: fakeRest([
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null },
        { id: "s2", text: "beta", createdAt: "2020-01-02T00:00:00.000Z", processedAt: null },
      ]),
    });

    // Mirror the Inbox screen's live query: unprocessed captures only.
    const inbox = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );

    // Record the inbox after every change so a one-tick reappear is caught.
    const snapshots: string[][] = [];
    const record = () => snapshots.push(inbox.toArray.map((c: Capture) => c.text));
    inbox.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await inbox.preload();
    await sleep(50);
    record();
    expect(inbox.toArray.map((c: Capture) => c.text)).toEqual(["alpha", "beta"]);

    const tx = api.process("s1");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    // Final state: alpha is gone.
    expect(inbox.toArray.map((c: Capture) => c.text)).toEqual(["beta"]);

    // No flicker: once alpha leaves a snapshot, it never comes back.
    const firstGone = snapshots.findIndex((s) => !s.includes("alpha"));
    expect(firstGone).toBeGreaterThanOrEqual(0);
    for (const snapshot of snapshots.slice(firstGone)) {
      expect(snapshot).not.toContain("alpha");
    }
  });
});
