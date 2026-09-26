import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { createTaskdoReplica, projectTodoData } from "./replica";

const NOW = "2026-09-25T12:00:00.000Z";

function setup() {
  const store = createMergeableStore();
  let id = 0;
  let saves = 0;
  let refreshes = 0;
  const replica = createTaskdoReplica({
    store,
    queryClient: new QueryClient(),
    queryKeyScope: ["test"],
    randomId: () => `id-${++id}`,
    now: () => new Date(NOW),
    today: () => "2026-09-25",
    save: async () => { saves++; },
    refresh: async () => { refreshes++; },
  });
  return { replica, store, saves: () => saves, refreshes: () => refreshes };
}

describe("TaskDO replica adapter", () => {
  it("exposes one replica-level refresh operation", async () => {
    const { replica, refreshes } = setup();
    await replica.refresh();
    expect(refreshes()).toBe(1);
    await replica.close();
  });

  it("exposes TodoTasks mutations through persisted TanStack transactions", async () => {
    const { replica, store, saves } = setup();
    await replica.projects.add("Project").isPersisted.promise;
    const project = replica.snapshot().projects[0];
    await replica.tasks.add("Task", null, project.id).isPersisted.promise;
    const task = replica.snapshot().tasks[0];
    await replica.tasks.edit(task.id, "Edited").isPersisted.promise;
    await replica.tasks.reschedule(task.id, "2026-10-01").isPersisted.promise;
    await replica.tasks.reorder(task.id, "a5").isPersisted.promise;
    await replica.tasks.moveToProject(task.id, null).isPersisted.promise;
    await replica.tasks.setRecurrence(task.id, {
      version: 1, origin: "2026-10-01", anchor: "scheduled", weekStartsOn: "MO",
      pattern: { unit: "day", interval: 1 },
    }).isPersisted.promise;
    const before = replica.snapshot().tasks[0];
    await replica.tasks.complete(task.id, "2026-10-01").isPersisted.promise;
    expect(replica.snapshot().tasks[0]).toMatchObject({ recurrenceDate: "2026-10-02", showUpDate: "2026-10-02" });
    await replica.tasks.undoOccurrence(before, "2026-10-01").isPersisted.promise;
    expect(replica.snapshot().tasks[0]).toMatchObject({ recurrenceDate: "2026-10-01", showUpDate: "2026-10-01" });
    expect(store.getCell("tasks", task.id, "recurrence")).toBeTypeOf("string");
    expect(saves()).toBe(9);
    await replica.close();
  });

  it("retains Project, Waiting, After, settlement, restore, and deletion behavior", async () => {
    const { replica, store } = setup();
    await replica.projects.add("Source").isPersisted.promise;
    await replica.projects.add("Target").isPersisted.promise;
    const [source, target] = replica.snapshot().projects;
    await replica.tasks.add("Task", null, source.id).isPersisted.promise;
    await replica.waits.addWaiting(source.id, "Reply").isPersisted.promise;
    await replica.waits.addAfter(source.id, target.id).isPersisted.promise;
    await replica.projects.setState(target.id, "done").isPersisted.promise;
    expect(replica.snapshot().conditions.map((condition) => condition.kind)).toEqual(["free-text"]);
    await replica.projects.reopen({ ...target, state: "in-play" }).isPersisted.promise;
    expect(replica.snapshot().conditions).toHaveLength(2);
    await replica.projects.remove(source.id).isPersisted.promise;
    expect(replica.snapshot()).toMatchObject({ tasks: [], conditions: [] });
    expect(store.getCell("projects", source.id, "deletedAt")).toBe(NOW);
    await replica.close();
  });

  it("maps canonical issues to existing local text and safe repair actions", async () => {
    const { replica, store, saves } = setup();
    store.setRow("projects", "deleted", { title: "Old", icon: "📁", state: "in-play", createdAt: NOW, deletedAt: NOW });
    store.setRow("tasks", "late", { text: "Keep", createdAt: NOW, projectId: "deleted", recurrence: "bad" });
    const snapshot = projectTodoData(store);
    expect(snapshot.tasks).toMatchObject([{ id: "late", projectId: null, recurrence: null }]);
    expect(snapshot.recoveries).toEqual([
      { table: "tasks", id: "late", text: "Keep", reason: "Invalid recurrence", repair: "clear-task-recurrence" },
      { table: "tasks", id: "late", text: "Keep", reason: "Deleted Project", repair: "make-task-loose" },
    ]);
    expect(await replica.repair(snapshot.recoveries[1])).toBe(true);
    expect(store.hasCell("tasks", "late", "projectId")).toBe(false);
    expect(saves()).toBe(1);
    await replica.close();
  });

  it("maps canonical conflicts to the established client-facing messages", async () => {
    const { replica } = setup();
    const transaction = replica.tasks.add("Task", null, "missing");
    await expect(transaction.isPersisted.promise).rejects.toThrow("Project was deleted or is not on this device");
    await replica.close();
  });
});
