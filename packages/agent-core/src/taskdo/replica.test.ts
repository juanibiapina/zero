import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import { describe, expect, it, vi } from "vitest";

import { createTaskdoReplica, projectTodoData } from "./replica";

const NOW = "2026-09-25T12:00:00.000Z";

function setup(seed?: (store: ReturnType<typeof createMergeableStore>) => void) {
  const store = createMergeableStore();
  seed?.(store);
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

  it("creates a Project with the given icon, or 📁 without one", async () => {
    const { replica } = setup();
    await replica.projects.add("Trip to Japan", "🇯🇵").when("settled");
    await replica.projects.add("Taxes").when("settled");
    expect(replica.snapshot().projects.map(({ title, icon }) => [title, icon])).toEqual(
      expect.arrayContaining([["Trip to Japan", "🇯🇵"], ["Taxes", "📁"]]),
    );
    await replica.close();
  });

  it("exposes TodoTasks mutations through persisted TanStack transactions", async () => {
    const { replica, store, saves } = setup();
    await replica.projects.add("Project").when("settled");
    const project = replica.snapshot().projects[0];
    await replica.tasks.add("Task", null, project.id).when("settled");
    const task = replica.snapshot().tasks[0];
    expect(task).toMatchObject({ recurrence: null, recurrenceDate: null });
    await replica.tasks.edit(task.id, "Edited").when("settled");
    await replica.tasks.reschedule(task.id, "2026-10-01").when("settled");
    await replica.tasks.reorder(task.id, "a5").when("settled");
    await replica.tasks.moveToProject(task.id, null).when("settled");
    await replica.tasks.setRecurrence(task.id, {
      version: 1, origin: "2026-10-01", anchor: "scheduled", weekStartsOn: "MO",
      pattern: { unit: "day", interval: 1 },
    }).when("settled");
    const before = replica.snapshot().tasks[0];
    await replica.tasks.complete(task.id, "2026-10-01").when("settled");
    expect(replica.snapshot().tasks[0]).toMatchObject({ recurrenceDate: "2026-10-02", showUpDate: "2026-10-02" });
    await replica.tasks.undoOccurrence(before, "2026-10-01").when("settled");
    expect(replica.snapshot().tasks[0]).toMatchObject({ recurrenceDate: "2026-10-01", showUpDate: "2026-10-01" });
    expect(store.getCell("tasks", task.id, "recurrence")).toBeTypeOf("string");
    expect(saves()).toBe(9);
    await replica.close();
  });

  it("saves title and recurrence together, preserving repeats during renames and one-off rescheduling", async () => {
    const { replica, saves } = setup();
    await replica.tasks.add("Water plants").when("settled");
    const id = replica.snapshot().tasks[0].id;
    const recurrence = { version: 1 as const, origin: "2026-09-25", anchor: "scheduled" as const, weekStartsOn: "MO" as const, pattern: { unit: "day" as const, interval: 1 } };
    await replica.tasks.edit(id, "Water garden", { kind: "recurring", recurrence }).when("settled");
    expect(saves()).toBe(2);
    expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Water garden", recurrence, recurrenceDate: recurrence.origin, showUpDate: recurrence.origin });
    await replica.tasks.edit(id, "Water flowers").when("settled");
    await replica.tasks.edit(id, "Water later", { kind: "once", date: "2026-09-27" }).when("settled");
    expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Water later", recurrence, recurrenceDate: recurrence.origin, showUpDate: "2026-09-27" });
    await replica.tasks.edit(id, "Water weekly", { kind: "recurring", recurrence: { ...recurrence, origin: "2026-09-28", pattern: { unit: "week", interval: 1, weekdays: ["MO"] } } }).when("settled");
    expect(replica.snapshot().tasks[0]).toMatchObject({ text: "Water weekly", recurrenceDate: "2026-09-28", showUpDate: "2026-09-28", recurrence: { pattern: { unit: "week" } } });
    await replica.close();
  });

  it("stores only Task fields when Undo restores an occurrence read from the collection", async () => {
    const { replica, store } = setup();
    const recurrence = { version: 1 as const, origin: "2026-09-25", anchor: "scheduled" as const, weekStartsOn: "MO" as const, pattern: { unit: "day" as const, interval: 1 } };
    await replica.tasks.add("Water plants", null, null, recurrence).when("settled");
    await replica.tasks.collection.preload();
    const before = replica.tasks.collection.get("id-1")!;
    await replica.tasks.complete(before.id).when("settled");
    await replica.tasks.undoOccurrence(before, "2026-09-25").when("settled");
    expect(store.getCell("tasks", before.id, "recurrenceDate")).toBe("2026-09-25");
    expect(Object.keys(store.getRow("tasks", before.id)).filter((cell) => cell.startsWith("$"))).toEqual([]);
    await replica.close();
  });

  it("brings a Task written outside the collection, by sync or a Medicine, into the collection", async () => {
    const { replica, store } = setup();
    await replica.tasks.collection.preload();
    const subscription = replica.tasks.collection.subscribeChanges(() => {});
    store.setRow("tasks", "synced", { text: "From another device", createdAt: NOW });
    await vi.waitFor(() => expect(replica.tasks.collection.get("synced")).toMatchObject({ text: "From another device" }));
    subscription.unsubscribe();
    await replica.close();
  });

  it("publishes complete Tasks through snapshots and the TanStack collection", async () => {
    const { replica } = setup((store) => {
      store.setRow("tasks", "task", { text: "Task", createdAt: NOW });
    });

    expect(replica.snapshot().tasks[0]).toMatchObject({ recurrence: null, recurrenceDate: null });
    await replica.tasks.collection.preload();
    expect(replica.tasks.collection.get("task")).toMatchObject({ recurrence: null, recurrenceDate: null });
    await replica.close();
  });

  it("retains Project, Waiting, After, settlement, restore, and deletion behavior", async () => {
    const { replica, store } = setup();
    await replica.projects.add("Source").when("settled");
    await replica.projects.add("Target").when("settled");
    const [source, target] = replica.snapshot().projects;
    await replica.tasks.add("Task", null, source.id).when("settled");
    await replica.waits.addWaiting(source.id, "Reply").when("settled");
    await replica.waits.addAfter(source.id, target.id).when("settled");
    await replica.projects.setState(target.id, "done").when("settled");
    expect(replica.snapshot().conditions.map((condition) => condition.kind)).toEqual(["free-text"]);
    await replica.projects.reopen({ ...target, state: "in-play" }).when("settled");
    expect(replica.snapshot().conditions).toHaveLength(2);
    await replica.projects.remove(source.id).when("settled");
    expect(replica.snapshot()).toMatchObject({ tasks: [], conditions: [] });
    expect(store.getCell("projects", source.id, "deletedAt")).toBe(NOW);
    await replica.close();
  });

  it("keeps a done Project in the Project collection, also after reopening", async () => {
    const { replica, store } = setup();
    await replica.projects.add("Finished").when("settled");
    const [project] = replica.snapshot().projects;
    await replica.projects.setState(project.id, "done").when("settled");
    expect(replica.projects.collection.get(project.id)?.state).toBe("done");
    await replica.close();

    const reopened = createTaskdoReplica({ store, queryClient: new QueryClient(), queryKeyScope: ["test"] });
    await reopened.projects.collection.preload();
    expect(reopened.projects.collection.get(project.id)?.state).toBe("done");
    await reopened.close();
  });

  it("maps canonical issues to existing local text and safe repair actions", async () => {
    const { replica, store, saves } = setup();
    store.setRow("projects", "deleted", { title: "Old", icon: "📁", state: "in-play", createdAt: NOW, deletedAt: NOW });
    store.setRow("tasks", "late", { text: "Keep", createdAt: NOW, parent: JSON.stringify({ kind: "project", projectId: "deleted" }), recurrence: "bad" });
    const snapshot = projectTodoData(store);
    expect(snapshot.tasks).toMatchObject([{ id: "late", parent: null, recurrence: null }]);
    expect(snapshot.recoveries).toEqual([
      { table: "tasks", id: "late", text: "Keep", reason: "Invalid recurrence", repair: "clear-task-recurrence" },
      { table: "tasks", id: "late", text: "Keep", reason: "Deleted Project", repair: "make-task-loose" },
    ]);
    expect(await replica.repair(snapshot.recoveries[1])).toBe(true);
    expect(store.hasCell("tasks", "late", "parent")).toBe(false);
    expect(saves()).toBe(1);
    await replica.close();
  });

  it("publishes Prompts that arrive by sync and saves the user's answer", async () => {
    const { replica, store, saves } = setup();
    const seen: number[] = [];
    replica.subscribe((snapshot) => seen.push(snapshot.prompts.length));
    store.setRow("prompts", "p", { title: "Which flight?", text: "Which one?", suggestions: "[\"The 9:40\"]", createdAt: NOW });
    expect(seen.at(-1)).toBe(1);

    await replica.prompts.answer("p", "The 9:40");

    expect(replica.snapshot().prompts[0]).toMatchObject({ seenAt: NOW, answer: { text: "The 9:40" } });
    expect(saves()).toBe(1);
    await expect(replica.prompts.answer("p", "Neither")).rejects.toThrow("This prompt already has an answer");
    await replica.close();
  });

  it("maps canonical conflicts to the established client-facing messages", async () => {
    const { replica } = setup();
    const transaction = replica.tasks.add("Task", null, "missing");
    await expect(transaction.when("settled")).rejects.toThrow("Project was deleted or is not on this device");
    await replica.close();
  });

});
