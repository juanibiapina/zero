import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import {
  createInMemoryApi,
  inboxReconcileWrites,
  type CapturesRest,
} from "./collection";
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

// One visibility invariant for every Inbox write. Keyed by a stable identity
// (the capture text here), an item's presence across the recorded snapshots must
// form a single contiguous block of `true`: once it appears it stays until an
// operation removes it, once removed it never returns, and it is never shown
// twice at once. A vanish-then-reappear or a reappear-then-vanish breaks the
// contiguity; a duplicate breaks the count. Reused across add and process so a
// future op (delete, edit) inherits the same check.
function expectNoFlicker(snapshots: string[][], id: string): void {
  for (const snapshot of snapshots) {
    expect(snapshot.filter((x) => x === id).length).toBeLessThanOrEqual(1);
  }
  const present = snapshots.map((s) => s.includes(id));
  const firstTrue = present.indexOf(true);
  if (firstTrue === -1) return;
  const lastTrue = present.lastIndexOf(true);
  for (let i = firstTrue; i <= lastTrue; i++) {
    expect(present[i]).toBe(true);
  }
}

describe("captures collection", () => {
  it("adding a capture shows it once, without a vanish/reappear flicker", async () => {
    const api = createInMemoryApi({
      queryClient: new QueryClient(),
      rest: fakeRest([
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null },
      ]),
    });

    const inbox = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );

    const snapshots: string[][] = [];
    const record = () => snapshots.push(inbox.toArray.map((c: Capture) => c.text));
    inbox.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await inbox.preload();
    await sleep(50);
    record();

    const tx = api.add("beta");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    // Final state: both are in the Inbox (order is not asserted; the live query
    // has no orderBy).
    const finalTexts = inbox.toArray.map((c: Capture) => c.text);
    expect([...finalTexts].sort()).toEqual(["alpha", "beta"]);

    // No flicker: once beta appears it never blinks out, and never doubles.
    expectNoFlicker(snapshots, "beta");
  });

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

    // No flicker: once alpha leaves it never comes back (same invariant as add).
    expectNoFlicker(snapshots, "alpha");
  });
});

describe("inboxReconcileWrites", () => {
  const cap = (id: string, processedAt: string | null = null): Capture => ({
    id,
    text: id,
    createdAt: "2023-01-01T00:00:00.000Z",
    processedAt,
  });

  it("inserts every server row when the collection is empty", () => {
    const writes = inboxReconcileWrites([], [cap("a"), cap("b")]);
    expect(writes).toEqual([
      { type: "insert", value: cap("a") },
      { type: "insert", value: cap("b") },
    ]);
  });

  it("updates rows already present instead of re-inserting them", () => {
    const writes = inboxReconcileWrites(["a"], [cap("a"), cap("b")]);
    expect(writes).toEqual([
      { type: "update", value: cap("a") },
      { type: "insert", value: cap("b") },
    ]);
  });

  it("deletes keys the server no longer returns (processed / removed rows)", () => {
    const writes = inboxReconcileWrites(["a", "b"], [cap("a")]);
    expect(writes).toEqual([
      { type: "update", value: cap("a") },
      { type: "delete", key: "b" },
    ]);
  });

  it("clears everything when the server inbox is empty", () => {
    const writes = inboxReconcileWrites(["a", "b"], []);
    expect(writes).toEqual([
      { type: "delete", key: "a" },
      { type: "delete", key: "b" },
    ]);
  });

  it("emits no duplicate insert for a key that is already present", () => {
    const writes = inboxReconcileWrites(["a"], [cap("a")]);
    expect(writes).toEqual([{ type: "update", value: cap("a") }]);
  });
});
