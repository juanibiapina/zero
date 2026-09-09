import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import {
  capturesSpec,
  createInMemoryApi,
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
        sortKey: null,
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
    unprocessCapture: async (id) => {
      await sleep(5);
      const capture = server.find((c) => c.id === id);
      if (!capture) throw new Error(`no capture ${id}`);
      capture.processedAt = null;
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
    reorderCapture: async (id, sortKey) => {
      await sleep(5);
      const capture = server.find((c) => c.id === id);
      if (!capture) throw new Error(`no capture ${id}`);
      capture.sortKey = sortKey;
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
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
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
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
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
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
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

  it("reordering a capture sets its sortKey and routes to reorderCapture, not edit/reschedule/process", async () => {
    const base = fakeRest([
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: "a0" },
    ]);
    let processCalls = 0;
    let editCalls = 0;
    let rescheduleCalls = 0;
    let reorderCalls = 0;
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
      reorderCapture: (id, sortKey) => {
        reorderCalls++;
        return base.reorderCapture(id, sortKey);
      },
    };
    const api = createInMemoryApi({ queryClient: new QueryClient(), rest });

    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );
    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);

    const tx = api.reorder("s1", "a5");
    await tx.isPersisted.promise;
    await sleep(50);

    const rows = captures.toArray as Capture[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sortKey).toBe("a5");
    expect(rows[0].processedAt).toBeNull();
    expect(reorderCalls).toBe(1);
    expect(rescheduleCalls).toBe(0);
    expect(editCalls).toBe(0);
    expect(processCalls).toBe(0);
  });

  it("processing a capture removes it once, without a reappear flicker", async () => {
    const api = createInMemoryApi({
      queryClient: new QueryClient(),
      rest: fakeRest([
        { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
        { id: "s2", text: "beta", createdAt: "2020-01-02T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
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

  it("unprocessing a capture returns it to the inbox, routing to unprocessCapture not edit", async () => {
    const rest = fakeRest([
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
    ]);
    const editSpy = vi.spyOn(rest, "editCapture");
    const api = createInMemoryApi({ queryClient: new QueryClient(), rest });

    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );
    captures.subscribeChanges(() => {});

    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);

    const done = api.process("s1");
    await done.isPersisted.promise;
    await sleep(50);
    expect(captures.toArray.map((c: Capture) => c.text)).toEqual([]);

    const back = api.unprocess({
      id: "s1",
      text: "alpha",
      createdAt: "2020-01-01T00:00:00.000Z",
      processedAt: null,
      showUpDate: null,
      sortKey: null,
    });
    await back.isPersisted.promise;
    await sleep(50);
    expect(captures.toArray.map((c: Capture) => c.text)).toEqual(["alpha"]);
    // The clear routed to unprocessCapture, never the catch-all editCapture.
    expect(editSpy).not.toHaveBeenCalled();
  });

  it("unprocesses a capture even after it was reconciled out of the collection", async () => {
    // The device bug in-memory: a foreground refetch (open-only list) evicts the
    // processed capture, so an update-by-id Undo threw. Revive must re-insert it,
    // calling unprocessCapture (not addCapture).
    let unprocessed = 0;
    let added = 0;
    const base = fakeRest([
      { id: "s1", text: "alpha", createdAt: "2020-01-01T00:00:00.000Z", processedAt: null, showUpDate: null, sortKey: null },
    ]);
    const rest = {
      ...base,
      unprocessCapture: (id: string) => {
        unprocessed += 1;
        return base.unprocessCapture(id);
      },
      addCapture: (c: Parameters<typeof base.addCapture>[0]) => {
        added += 1;
        return base.addCapture(c);
      },
    };
    const api = createInMemoryApi({ queryClient: new QueryClient(), rest });

    const captures = createLiveQueryCollection((q) =>
      q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
    );
    captures.subscribeChanges(() => {});
    await api.collection.stateWhenReady();
    await captures.preload();
    await sleep(50);

    await api.process("s1").isPersisted.promise;
    await sleep(50);
    await api.refetch();
    await sleep(50);
    expect(api.collection.has("s1")).toBe(false);

    const back = api.unprocess({
      id: "s1",
      text: "alpha",
      createdAt: "2020-01-01T00:00:00.000Z",
      processedAt: null,
      showUpDate: null,
      sortKey: null,
    });
    await back.isPersisted.promise;
    await sleep(50);

    expect(captures.toArray.map((c: Capture) => c.text)).toEqual(["alpha"]);
    expect(unprocessed).toBe(1);
    expect(added).toBe(0);
  });
});

// The outbox persists queued offline writes by these names and the local cache
// table by the entity name; a write queued by an old build replays on the new
// one by them. Renaming any strands offline writes.
describe("captures durable names", () => {
  it("keeps the collection id and outbox mutationFn names", () => {
    const spec = capturesSpec(fakeRest([]));
    expect(spec.name).toBe("captures");
    expect(Object.keys(spec.verbs).sort()).toEqual([
      "addCapture",
      "editCapture",
      "processCapture",
      "reorderCapture",
      "rescheduleCapture",
      "unprocessCapture",
    ]);
  });
});
