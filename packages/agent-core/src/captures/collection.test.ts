import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import {
  createInMemoryApi,
  reconcileCaptureWrites,
  type CapturesRest,
} from "./collection";
import type { Capture } from "./types";

// A fake Captures server with a small latency so the optimistic overlay and the
// reconciling refetch resolve on separate ticks, which is when the flicker
// showed up (the processed row briefly reappearing between the two).
function fakeRest(initial: Capture[]): CapturesRest {
  const server = initial.map((c) => ({ ...c }));
  return {
    fetchCaptures: async () => {
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
        showUpDate: null,
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
    editCapture: async (id, text) => {
      await sleep(5);
      const capture = server.find((c) => c.id === id);
      if (!capture) throw new Error(`no capture ${id}`);
      capture.text = text;
      return { ...capture };
    },
    rescheduleCapture: async (id, showUpDate) => {
      await sleep(5);
      const capture = server.find((c) => c.id === id);
      if (!capture) throw new Error(`no capture ${id}`);
      capture.showUpDate = showUpDate;
      return { ...capture };
    },
  };
}

// One visibility invariant for every Captures write. Keyed by a stable identity
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
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null },
      ]),
    });

    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );

    const snapshots: string[][] = [];
    const record = () => snapshots.push(captures.toArray.map((c: Capture) => c.text));
    captures.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);
    record();

    const tx = api.add("beta");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    // Final state: both are in the Captures (order is not asserted; the live query
    // has no orderBy).
    const finalTexts = captures.toArray.map((c: Capture) => c.text);
    expect([...finalTexts].sort()).toEqual(["alpha", "beta"]);

    // No flicker: once beta appears it never blinks out, and never doubles.
    expectNoFlicker(snapshots, "beta");
  });

  it("editing a capture shows the new text and reconciles, routing to editCapture not process", async () => {
    const base = fakeRest([
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null },
    ]);
    // Count which REST verb each write routes to, so the in-memory onUpdate
    // branch (process vs edit) is asserted, not just the visible text.
    let processCalls = 0;
    let editCalls = 0;
    const rest: CapturesRest = {
      ...base,
      processCapture: (id) => {
        processCalls++;
        return base.processCapture(id);
      },
      editCapture: (id, text) => {
        editCalls++;
        return base.editCapture(id, text);
      },
    };
    const api = createInMemoryApi({ queryClient: new QueryClient(), rest });

    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );
    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);

    const tx = api.edit("s1", "alpha edited");
    await tx.isPersisted.promise;
    await sleep(50);

    const rows = captures.toArray as Capture[];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("alpha edited");
    // Still open, not removed by the edit.
    expect(rows[0].processedAt).toBeNull();
    // Routed to edit, never to process.
    expect(editCalls).toBe(1);
    expect(processCalls).toBe(0);
  });

  it("rescheduling a capture sets its showUpDate and routes to rescheduleCapture, not edit/process", async () => {
    const base = fakeRest([
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null },
    ]);
    let processCalls = 0;
    let editCalls = 0;
    let rescheduleCalls = 0;
    const rest: CapturesRest = {
      ...base,
      processCapture: (id) => {
        processCalls++;
        return base.processCapture(id);
      },
      editCapture: (id, text) => {
        editCalls++;
        return base.editCapture(id, text);
      },
      rescheduleCapture: (id, showUpDate) => {
        rescheduleCalls++;
        return base.rescheduleCapture(id, showUpDate);
      },
    };
    const api = createInMemoryApi({ queryClient: new QueryClient(), rest });

    // The live query keeps only open rows; a rescheduled row stays open (its
    // processedAt is untouched), so it is still visible here — the optimistic
    // date hide is a separate screen-level pass (visibleCaptures).
    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );
    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);

    const tx = api.reschedule("s1", "2099-01-01");
    await tx.isPersisted.promise;
    await sleep(50);

    const rows = captures.toArray as Capture[];
    expect(rows).toHaveLength(1);
    expect(rows[0].showUpDate).toBe("2099-01-01");
    expect(rows[0].processedAt).toBeNull();
    expect(rescheduleCalls).toBe(1);
    expect(editCalls).toBe(0);
    expect(processCalls).toBe(0);
  });

  it("processing a capture removes it once, without a reappear flicker", async () => {
    const api = createInMemoryApi({
      queryClient: new QueryClient(),
      rest: fakeRest([
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null },
        { id: "s2", text: "beta", createdAt: "2020-01-02T00:00:00.000Z", processedAt: null, showUpDate: null },
      ]),
    });

    // Mirror the Captures screen's live query: unprocessed captures only.
    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );

    // Record the captures after every change so a one-tick reappear is caught.
    const snapshots: string[][] = [];
    const record = () => snapshots.push(captures.toArray.map((c: Capture) => c.text));
    captures.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);
    record();
    expect(captures.toArray.map((c: Capture) => c.text)).toEqual(["alpha", "beta"]);

    const tx = api.process("s1");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    // Final state: alpha is gone.
    expect(captures.toArray.map((c: Capture) => c.text)).toEqual(["beta"]);

    // No flicker: once alpha leaves it never comes back (same invariant as add).
    expectNoFlicker(snapshots, "alpha");
  });
});

describe("reconcileCaptureWrites", () => {
  const cap = (id: string, processedAt: string | null = null): Capture => ({
    id,
    text: id,
    createdAt: "2023-01-01T00:00:00.000Z",
    processedAt,
    showUpDate: null,
  });

  it("inserts every server row when the collection is empty", () => {
    const writes = reconcileCaptureWrites([], [cap("a"), cap("b")]);
    expect(writes).toEqual([
      { type: "insert", value: cap("a") },
      { type: "insert", value: cap("b") },
    ]);
  });

  it("updates rows already present instead of re-inserting them", () => {
    const writes = reconcileCaptureWrites(["a"], [cap("a"), cap("b")]);
    expect(writes).toEqual([
      { type: "update", value: cap("a") },
      { type: "insert", value: cap("b") },
    ]);
  });

  it("deletes keys the server no longer returns (processed / removed rows)", () => {
    const writes = reconcileCaptureWrites(["a", "b"], [cap("a")]);
    expect(writes).toEqual([
      { type: "update", value: cap("a") },
      { type: "delete", key: "b" },
    ]);
  });

  it("clears everything when the server captures is empty", () => {
    const writes = reconcileCaptureWrites(["a", "b"], []);
    expect(writes).toEqual([
      { type: "delete", key: "a" },
      { type: "delete", key: "b" },
    ]);
  });

  it("emits no duplicate insert for a key that is already present", () => {
    const writes = reconcileCaptureWrites(["a"], [cap("a")]);
    expect(writes).toEqual([{ type: "update", value: cap("a") }]);
  });
});
