import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import {
  createInMemoryTasksApi,
  tasksSpec,
  type TasksRest,
} from "./collection";
import type { Task } from "./types";

// A fake Tasks server with a small latency so the optimistic overlay and the
// reconciling refetch resolve on separate ticks (where a flicker would show).
function fakeRest(initial: Task[]): TasksRest {
  const server = initial.map((t) => ({ ...t }));
  return {
    fetchTasks: async () => {
      await sleep(5);
      return server.filter((t) => t.completedAt == null).map((t) => ({ ...t }));
    },
    addTask: async ({ id, text, showUpDate, projectId, takenOnAt }) => {
      await sleep(5);
      const existing = server.find((t) => t.id === id);
      if (existing) return { ...existing };
      const task: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
        projectId,
        takenOnAt,
      };
      server.push(task);
      return { ...task };
    },
    setTaskTakenOn: async (id, takenOnAt) => {
      await sleep(5);
      const task = server.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      task.takenOnAt = takenOnAt;
      return { ...task };
    },
    completeTask: async (id) => {
      await sleep(5);
      const task = server.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      task.completedAt = new Date().toISOString();
      return { ...task };
    },
    reopenTask: async (id) => {
      await sleep(5);
      const task = server.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      task.completedAt = null;
      return { ...task };
    },
  };
}

// Presence of an item across snapshots must be a single contiguous block of
// `true`, never doubled. Same invariant as the Capture collection test.
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

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  text: id,
  showUpDate: "2020-01-01",
  createdAt: "2020-01-01T00:00:00.000Z",
  completedAt: null,
  projectId: null,
  takenOnAt: null,
  ...over,
});

describe("tasks collection", () => {
  it("adding a task shows it once, without a vanish/reappear flicker", async () => {
    const api = createInMemoryTasksApi({
      queryClient: new QueryClient(),
      rest: fakeRest([task("s1", { text: "alpha" })]),
    });

    const open = createLiveQueryCollection((q) =>
      q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
    );

    const snapshots: string[][] = [];
    const record = () => snapshots.push(open.toArray.map((t: Task) => t.text));
    open.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await open.preload();
    await sleep(50);
    record();

    const tx = api.add("beta", "2020-01-01");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    const finalTexts = open.toArray.map((t: Task) => t.text);
    expect([...finalTexts].sort()).toEqual(["alpha", "beta"]);
    expectNoFlicker(snapshots, "beta");
  });

  it("completing a task removes it once, without a reappear flicker", async () => {
    const api = createInMemoryTasksApi({
      queryClient: new QueryClient(),
      rest: fakeRest([
        task("s1", { text: "alpha" }),
        task("s2", { text: "beta", createdAt: "2020-01-02T00:00:00.000Z" }),
      ]),
    });

    const open = createLiveQueryCollection((q) =>
      q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
    );

    const snapshots: string[][] = [];
    const record = () => snapshots.push(open.toArray.map((t: Task) => t.text));
    open.subscribeChanges(record);

    await api.collection.stateWhenReady();
    await open.preload();
    await sleep(50);
    record();
    expect(open.toArray.map((t: Task) => t.text).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    const tx = api.complete("s1");
    await tx.isPersisted.promise;
    await sleep(50);
    record();

    expect(open.toArray.map((t: Task) => t.text)).toEqual(["beta"]);
    expectNoFlicker(snapshots, "alpha");
  });

  it("reopening a completed task returns it to the open set", async () => {
    const api = createInMemoryTasksApi({
      queryClient: new QueryClient(),
      rest: fakeRest([task("s1", { text: "alpha" })]),
    });

    const open = createLiveQueryCollection((q) =>
      q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
    );
    open.subscribeChanges(() => {});

    await api.collection.stateWhenReady();
    await open.preload();
    await sleep(50);

    const done = api.complete("s1");
    await done.isPersisted.promise;
    await sleep(50);
    expect(open.toArray.map((t: Task) => t.text)).toEqual([]);

    const back = api.reopen(task("s1", { text: "alpha" }));
    await back.isPersisted.promise;
    await sleep(50);
    expect(open.toArray.map((t: Task) => t.text)).toEqual(["alpha"]);
  });

  it("reopens a task even after it was reconciled out of the collection", async () => {
    // Reproduces the device bug: on the persisted path a foreground refetch (the
    // open-only server list) evicts the completed row, so an update-by-id Undo
    // threw "key not found". The in-memory path evicts the same way on refetch();
    // revive must re-insert the row, calling reopenTask (not addTask).
    let reopened = 0;
    let added = 0;
    const base = fakeRest([task("s1", { text: "alpha" })]);
    const rest: TasksRest = {
      ...base,
      reopenTask: (id) => {
        reopened += 1;
        return base.reopenTask(id);
      },
      addTask: (t) => {
        added += 1;
        return base.addTask(t);
      },
    };
    const api = createInMemoryTasksApi({ queryClient: new QueryClient(), rest });

    const open = createLiveQueryCollection((q) =>
      q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
    );
    open.subscribeChanges(() => {});
    await api.collection.stateWhenReady();
    await open.preload();
    await sleep(50);

    await api.complete("s1").isPersisted.promise;
    await sleep(50);
    // Evict the completed row the way a foreground refetch does on device.
    await api.refetch();
    await sleep(50);
    expect(api.collection.has("s1")).toBe(false);

    const back = api.reopen(task("s1", { text: "alpha" }));
    await back.isPersisted.promise;
    await sleep(50);

    expect(open.toArray.map((t: Task) => t.text)).toEqual(["alpha"]);
    expect(reopened).toBe(1);
    expect(added).toBe(0);
  });
});

// The outbox persists queued offline writes by these names and the local cache
// table by the entity name. Renaming any strands offline writes.
describe("tasks durable names", () => {
  it("keeps the collection id and outbox mutationFn names", () => {
    const spec = tasksSpec(fakeRest([]));
    expect(spec.name).toBe("tasks");
    expect(Object.keys(spec.verbs).sort()).toEqual([
      "addTask",
      "completeTask",
      "reopenTask",
      "setTakenOn",
    ]);
  });
});
