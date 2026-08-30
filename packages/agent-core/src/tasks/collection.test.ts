import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createLiveQueryCollection, isNull } from "@tanstack/db";

import {
  createInMemoryTasksApi,
  tasksReconcileWrites,
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
    addTask: async ({ id, text, showUpDate }) => {
      await sleep(5);
      const existing = server.find((t) => t.id === id);
      if (existing) return { ...existing };
      const task: Task = {
        id,
        text,
        showUpDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      server.push(task);
      return { ...task };
    },
    completeTask: async (id) => {
      await sleep(5);
      const task = server.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      task.completedAt = new Date().toISOString();
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
});

describe("tasksReconcileWrites", () => {
  it("inserts every server row when the collection is empty", () => {
    const writes = tasksReconcileWrites([], [task("a"), task("b")]);
    expect(writes).toEqual([
      { type: "insert", value: task("a") },
      { type: "insert", value: task("b") },
    ]);
  });

  it("updates rows already present instead of re-inserting them", () => {
    const writes = tasksReconcileWrites(["a"], [task("a"), task("b")]);
    expect(writes).toEqual([
      { type: "update", value: task("a") },
      { type: "insert", value: task("b") },
    ]);
  });

  it("deletes keys the server no longer returns (completed / removed rows)", () => {
    const writes = tasksReconcileWrites(["a", "b"], [task("a")]);
    expect(writes).toEqual([
      { type: "update", value: task("a") },
      { type: "delete", key: "b" },
    ]);
  });

  it("clears everything when the server list is empty", () => {
    const writes = tasksReconcileWrites(["a", "b"], []);
    expect(writes).toEqual([
      { type: "delete", key: "a" },
      { type: "delete", key: "b" },
    ]);
  });
});
