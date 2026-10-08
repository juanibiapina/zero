import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { TaskDomain } from "./domain";

const NOW = "2026-09-26T10:00:00.000Z";

function setup() {
  const store = createMergeableStore();
  let saves = 0;
  let erased = false;
  const domain = new TaskDomain({
    store,
    save: async () => { saves++; },
    isErased: async () => erased,
    now: () => new Date(NOW),
  });
  return { domain, store, saves: () => saves, erase: () => { erased = true; } };
}

describe("TaskDomain adapter", () => {
  it("saves successful mutations with the existing retry and no-op policy", async () => {
    const { domain, saves } = setup();
    await domain.addProject("p", "Project");
    await domain.addProject("p", "Retry");
    await domain.addTask("task", "Task", null, { kind: "project", projectId: "p" });
    await domain.addTask("task", "Retry", null, { kind: "project", projectId: "p" });
    await domain.completeTask("task");
    await domain.completeTask("task");
    await domain.reopenTask("task");
    await domain.reopenTask("task");
    await domain.deleteWaitingCondition("missing");
    await domain.deleteProject("missing");

    expect(saves()).toBe(5);
  });

  it("lists only Projects that are not done", async () => {
    const { domain } = setup();
    await domain.addProject("open", "Open");
    await domain.addProject("done", "Done");
    await domain.setProjectState("done", "done");

    expect(domain.listProjects().map((project) => project.id)).toEqual(["open"]);
  });

  it("maps canonical conflicts to the established RPC values", async () => {
    const { domain } = setup();
    expect(await domain.addTask("task", "Task", null, { kind: "project", projectId: "missing" })).toBeNull();
    expect(await domain.patchTask("missing", { text: "x" })).toBeNull();
    await domain.addTask("task", "Task", null);
    expect(await domain.patchTask("task", { parent: { kind: "project", projectId: "missing" } })).toBe("missing-project");
    expect(await domain.addProjectAfter("after", "missing", "also-missing")).toEqual({ conflict: "missing-source" });
  });

  it("maps canonical issues to the exact REST recovery shapes", async () => {
    const { domain, store } = setup();
    await domain.addProject("deleted", "Deleted");
    await domain.deleteProject("deleted");
    store.setRow("projects", "bad-project", { title: "Bad" });
    store.setRow("tasks", "late", { text: "Late", createdAt: NOW, parent: JSON.stringify({ kind: "project", projectId: "deleted" }) });
    store.setRow("tasks", "bad-task", { parent: JSON.stringify({ kind: "project", projectId: "missing" }), recurrence: "bad" });
    store.setRow("conditions", "bad-condition", { projectId: "missing", kind: "free-text", text: "Wait", createdAt: NOW });

    expect(domain.listProjectRecoveries()).toEqual([{ projectId: "bad-project", reason: "invalid-project" }]);
    expect(domain.listRecoveries()).toEqual([
      { taskId: "late", projectId: "deleted", reason: "deleted-project" },
      { taskId: "bad-task", projectId: "missing", reason: "invalid-task" },
      { taskId: "bad-task", projectId: "missing", reason: "invalid-recurrence" },
      { taskId: "bad-task", projectId: "missing", reason: "missing-project" },
    ]);
    expect(domain.listConditionRecoveries()).toEqual([
      { conditionId: "bad-condition", projectId: "missing", refId: null, reason: "missing-source" },
    ]);
  });

  it("preserves deterministic timestamps and manual REST ordering", async () => {
    const { domain, store } = setup();
    store.setRow("tasks", "unkeyed", { text: "Unkeyed", createdAt: "2026-01-01T00:00:00.000Z" });
    const task = await domain.addTask("keyed", "Keyed", null);
    expect(task).toMatchObject({
      createdAt: NOW,
      completedAt: null,
      recurrence: null,
      recurrenceDate: null,
    });
    expect(domain.listTasks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ recurrence: null, recurrenceDate: null }),
    ]));
    expect(domain.listTasks().map((row) => row.id)).toEqual(["keyed", "unkeyed"]);
  });

  it("rejects every mutation after erasure with the established messages", async () => {
    const { domain, erase } = setup();
    erase();
    await expect(domain.addTask("task", "Task", null)).rejects.toThrow("Todo account erased");
    await expect(domain.addProject("project", "Project")).rejects.toThrow("Account erased");
  });
});

describe("TaskDomain catalog operations", () => {
  it("saves only when an operation changes the workspace", async () => {
    const { domain, saves } = setup();
    const created = await domain.run("tasks_create", { id: "t", text: "Task" }, "2026-09-26");
    await domain.run("tasks_create", { id: "t", text: "Task" }, "2026-09-26");
    const listed = await domain.run("tasks_list", {}, "2026-09-26");

    expect(created).toMatchObject({ ok: true, changed: true });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [{ id: "t" }] } });
    expect(saves()).toBe(1);
  });

  it("mints ids for operations that omit them", async () => {
    const { domain } = setup();
    const outcome = await domain.run("projects_create", { title: "Trip" }, "2026-09-26");
    expect(outcome.ok && (outcome.value as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects writes on an erased account without saving", async () => {
    const { domain, saves, erase } = setup();
    erase();
    expect(await domain.run("tasks_create", { text: "Late" }, "2026-09-26")).toEqual({ ok: false, error: "Account erased" });
    expect(saves()).toBe(0);
  });
});
