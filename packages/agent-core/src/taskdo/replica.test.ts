import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { createTaskdoReplica, projectTodoData, repairTodoRecovery } from "./replica";

const createdAt = "2026-09-25T12:00:00.000Z";
const project = (title: string) => ({ title, createdAt, state: "in-play", icon: "📁" });

describe("TaskDO replica projection", () => {
  it("keeps an offline child visible and offers a safe repair for its deleted Project", () => {
    const server = createMergeableStore();
    server.setRow("projects", "p", project("Project"));
    const offline = createMergeableStore().merge(server);
    server.setCell("projects", "p", "deletedAt", createdAt);
    offline.setRow("tasks", "late", { text: "Do not lose", createdAt, projectId: "p" });
    server.merge(offline);
    offline.merge(server);

    expect(projectTodoData(server)).toEqual(projectTodoData(offline));
    expect(projectTodoData(server).tasks).toMatchObject([{ id: "late", text: "Do not lose", projectId: null }]);
    const recovery = projectTodoData(server).recoveries[0];
    expect(recovery).toEqual({
      table: "tasks", id: "late", text: "Do not lose", reason: "Deleted Project", repair: "make-task-loose",
    });
    expect(repairTodoRecovery(server, recovery)).toBe(true);
    expect(server.hasCell("tasks", "late", "projectId")).toBe(false);
  });

  it("deterministically rejects cyclic Afters and retains invalid recurrence intent", () => {
    const a = createMergeableStore();
    a.setRow("projects", "x", project("X"));
    a.setRow("projects", "y", project("Y"));
    const b = createMergeableStore().merge(a);
    a.setRow("conditions", "a", {
      kind: "project-status", projectId: "x", refId: "y", targetStatus: "done", createdAt,
    });
    b.setRow("conditions", "b", {
      kind: "project-status", projectId: "y", refId: "x", targetStatus: "done", createdAt,
    });
    b.setRow("tasks", "invalid", { text: "Work", createdAt, recurrence: "{broken" });
    a.merge(b);
    b.merge(a);

    expect(projectTodoData(a)).toEqual(projectTodoData(b));
    expect(projectTodoData(a).conditions.map((row) => row.id)).toEqual(["a"]);
    expect(projectTodoData(a).recoveries).toEqual(expect.arrayContaining([
      { table: "conditions", id: "b", text: "b", reason: "Cyclic After relationship", repair: "remove-after" },
      { table: "tasks", id: "invalid", text: "Work", reason: "Invalid recurrence", repair: "clear-task-recurrence" },
    ]));
    expect(a.getCell("tasks", "invalid", "recurrence")).toBe("{broken");
  });
});

describe("TaskDO replica APIs", () => {
  it("applies shared mutations, After settlement, restoration, and deletion cascades", async () => {
    const store = createMergeableStore();
    let id = 0;
    const replica = createTaskdoReplica({
      store,
      queryClient: new QueryClient(),
      queryKeyScope: ["test"],
      randomId: () => `id-${++id}`,
      now: () => new Date(createdAt),
      today: () => "2026-09-25",
    });

    await replica.projectsApi.add("Source").isPersisted.promise;
    await replica.projectsApi.add("Target").isPersisted.promise;
    const [source, target] = replica.snapshot().projects;
    await replica.api.add("Task", null, source.id).isPersisted.promise;
    await replica.waitsApi.addAfter(source.id, target.id).isPersisted.promise;

    await replica.projectsApi.setState(target.id, "done").isPersisted.promise;
    expect(replica.snapshot().conditions).toEqual([]);
    await replica.projectsApi.reopen({ ...target, state: "in-play" }).isPersisted.promise;
    expect(replica.snapshot().conditions).toHaveLength(1);

    await replica.projectsApi.remove(source.id).isPersisted.promise;
    expect(replica.snapshot()).toMatchObject({ tasks: [], conditions: [] });
    expect(store.getCell("projects", source.id, "deletedAt")).toBe(createdAt);
    await replica.close();
  });
});
