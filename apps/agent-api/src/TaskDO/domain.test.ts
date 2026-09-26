import { describe, expect, it } from "vitest";
import { createMergeableStore, type MergeableStore } from "tinybase";
import type { Recurrence } from "@zeroapps/recurrence";

import { TaskDomain } from "./domain";

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_C = "project-c";

const daily: Recurrence = {
  version: 1,
  origin: "2026-10-01",
  anchor: "scheduled",
  weekStartsOn: "MO",
  pattern: { unit: "day", interval: 1 },
};

function setup(initialNow = "2026-09-26T10:00:00.000Z") {
  const store = createMergeableStore();
  let now = initialNow;
  let saves = 0;
  let erased = false;
  const domain = new TaskDomain({
    store,
    save: async () => { saves++; },
    isErased: async () => erased,
    now: () => new Date(now),
  });
  return {
    domain,
    store,
    saves: () => saves,
    setNow: (value: string) => { now = value; },
    erase: () => { erased = true; },
  };
}

async function addProjects(domain: TaskDomain, ...ids: string[]) {
  for (const id of ids) await domain.addProject(id, id);
}

describe("TaskDomain tasks", () => {
  it("creates a task once and returns the original row on a retried id", async () => {
    const { domain, saves } = setup();

    const created = await domain.addTask("task-a", "first", null);
    const retried = await domain.addTask("task-a", "replacement", "2027-01-01");

    expect(created).toMatchObject({
      id: "task-a",
      text: "first",
      createdAt: "2026-09-26T10:00:00.000Z",
      showUpDate: null,
      completedAt: null,
      projectId: null,
    });
    expect(retried).toEqual(created);
    expect(domain.listTasks()).toEqual([created]);
    expect(saves()).toBe(1);
  });

  it("rejects missing and deleted projects and reports synced broken references", async () => {
    const { domain, store } = setup();
    expect(await domain.addTask("missing", "task", null, PROJECT_A)).toBeNull();

    await domain.addProject(PROJECT_A, "A");
    await domain.deleteProject(PROJECT_A);
    expect(await domain.addTask("deleted", "task", null, PROJECT_A)).toBeNull();

    store.setRow("tasks", "raw-missing", {
      text: "raw",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: "never-existed",
    });
    store.setRow("tasks", "raw-deleted", {
      text: "raw",
      createdAt: "2026-01-01T00:00:00.000Z",
      projectId: PROJECT_A,
    });
    expect(domain.listTasks().map((task) => ({ id: task.id, projectId: task.projectId }))).toEqual([
      { id: "raw-missing", projectId: null },
      { id: "raw-deleted", projectId: null },
    ]);
    expect(domain.listRecoveries()).toEqual([
      { taskId: "raw-missing", projectId: "never-existed", reason: "missing-project" },
      { taskId: "raw-deleted", projectId: PROJECT_A, reason: "deleted-project" },
    ]);
  });

  it("edits, reschedules, reorders, assigns, and unassigns a task", async () => {
    const { domain } = setup();
    await domain.addProject(PROJECT_A, "A");
    await domain.addTask("task-a", "draft", null);

    expect(await domain.editTask("task-a", "final")).toMatchObject({ text: "final" });
    expect(await domain.patchTask("task-a", {
      showUpDate: "2027-01-01",
      sortKey: "a5",
      projectId: PROJECT_A,
    })).toMatchObject({
      text: "final",
      showUpDate: "2027-01-01",
      sortKey: "a5",
      projectId: PROJECT_A,
    });
    expect(await domain.patchTask("task-a", { showUpDate: null, projectId: null })).toMatchObject({
      showUpDate: null,
      projectId: null,
    });
    expect(await domain.patchTask("task-a", { projectId: PROJECT_B })).toBe("missing-project");
    expect(await domain.patchTask("unknown", { text: "x" })).toBeNull();
  });

  it("completes and reopens idempotently with deterministic timestamps", async () => {
    const { domain, saves, setNow } = setup();
    await domain.addTask("task-a", "task", null);
    setNow("2026-09-26T11:00:00.000Z");

    const completed = await domain.completeTask("task-a");
    expect(completed?.completedAt).toBe("2026-09-26T11:00:00.000Z");
    expect(await domain.completeTask("task-a")).toEqual(completed);
    expect(domain.listTasks()).toEqual([]);

    const reopened = await domain.reopenTask("task-a");
    expect(reopened?.completedAt).toBeNull();
    expect(await domain.reopenTask("task-a")).toEqual(reopened);
    expect(domain.listTasks()).toEqual([reopened]);
    expect(saves()).toBe(3);
  });

  it("advances and idempotently undoes a recurring occurrence", async () => {
    const { domain } = setup();
    await domain.addTask("daily", "daily", null, null, null, daily);

    const advanced = await domain.completeTaskOccurrence("daily", "2026-10-01", "2026-10-01");
    expect(advanced).toMatchObject({
      recurrenceDate: "2026-10-02",
      showUpDate: "2026-10-02",
      completedAt: null,
    });
    expect(await domain.completeTaskOccurrence("daily", "2026-10-01", "2026-10-01")).toEqual(advanced);

    const undone = await domain.undoTaskOccurrence("daily", "2026-10-02", "2026-10-01", null);
    expect(undone).toMatchObject({ recurrenceDate: "2026-10-01", showUpDate: null, completedAt: null });
    expect(await domain.undoTaskOccurrence("daily", "2026-10-02", "2026-10-01", null)).toEqual(undone);
  });

  it("completes a recurring task at its inclusive end and reopens non-recurring occurrences", async () => {
    const { domain } = setup();
    await domain.addTask("finite", "finite", null, null, null, { ...daily, until: daily.origin });
    expect(await domain.completeTaskOccurrence("finite", daily.origin, daily.origin)).toMatchObject({
      completedAt: "2026-09-26T10:00:00.000Z",
    });

    await domain.addTask("once", "once", null);
    await domain.completeTaskOccurrence("once", "2026-10-01", "2026-10-01");
    expect(await domain.undoTaskOccurrence("once", "2026-10-01", "2026-10-01", null)).toMatchObject({
      completedAt: null,
    });
  });

  it("reports and refuses to advance or undo an invalid synchronized recurrence", async () => {
    const { domain, store } = setup();
    store.setRow("tasks", "broken", {
      text: "broken",
      createdAt: "2026-01-01T00:00:00.000Z",
      recurrence: "not-json",
      recurrenceDate: "2026-10-01",
    });

    expect(domain.listRecoveries()).toEqual([
      { taskId: "broken", projectId: null, reason: "invalid-recurrence" },
    ]);
    expect(await domain.completeTaskOccurrence("broken", "2026-10-01", "2026-10-01")).toBe("invalid-recurrence");
    expect(await domain.undoTaskOccurrence("broken", "2026-10-02", "2026-10-01", null)).toBe("invalid-recurrence");
  });

  it("orders keyed tasks first and tolerates malformed synchronized sort keys", async () => {
    const { domain, store, setNow } = setup();
    store.setRow("tasks", "bad-key", {
      text: "bad",
      createdAt: "2026-01-01T00:00:00.000Z",
      sortKey: "\u0000invalid",
    });
    store.setRow("tasks", "unkeyed", {
      text: "unkeyed",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    setNow("2026-01-03T00:00:00.000Z");

    const added = await domain.addTask("new", "new", null);

    expect(added?.sortKey).toBeTruthy();
    expect(domain.listTasks().map((task) => task.id)).toEqual(["bad-key", "new", "unkeyed"]);
  });

  it("reports malformed synchronized task and project rows without hiding valid rows", () => {
    const { domain, store } = setup();
    store.setRow("projects", "invalid-project", { title: "missing fields" });
    store.setRow("tasks", "invalid-task", { projectId: "invalid-project", recurrence: "{}" });
    store.setRow("tasks", "valid-task", { text: "valid", createdAt: "2026-01-01T00:00:00.000Z" });

    expect(domain.listProjectRecoveries()).toEqual([
      { projectId: "invalid-project", reason: "invalid-project" },
    ]);
    expect(domain.listRecoveries()).toEqual([
      { taskId: "invalid-task", projectId: "invalid-project", reason: "invalid-task" },
      { taskId: "invalid-task", projectId: "invalid-project", reason: "invalid-recurrence" },
      { taskId: "invalid-task", projectId: "invalid-project", reason: "missing-project" },
    ]);
    expect(domain.listTasks().map((task) => task.id)).toEqual(["valid-task"]);
  });
});

describe("TaskDomain projects and conditions", () => {
  it("creates and edits a project, preserves retry idempotency, and hides Done projects", async () => {
    const { domain, saves } = setup();
    const created = await domain.addProject(PROJECT_A, "A", {
      icon: "🅰️",
      description: "first",
      sourceCaptureId: "capture-a",
    });
    expect(await domain.addProject(PROJECT_A, "replacement")).toEqual(created);
    expect(await domain.editProject(PROJECT_A, { title: "Edited", icon: "✅", description: null })).toMatchObject({
      title: "Edited",
      icon: "✅",
      description: null,
    });
    expect(await domain.setProjectState(PROJECT_A, "backlog")).toMatchObject({ state: "backlog" });
    expect(await domain.setProjectState(PROJECT_A, "done")).toMatchObject({ state: "done" });
    expect(domain.listProjects()).toEqual([]);
    expect(await domain.setProjectState(PROJECT_A, "done")).toMatchObject({ state: "done" });
    expect(saves()).toBe(4);
  });

  it("deletes a project and cascades its tasks, manual conditions, and incoming and outgoing Afters", async () => {
    const { domain } = setup();
    await addProjects(domain, PROJECT_A, PROJECT_B, PROJECT_C);
    await domain.addTask("task-a", "A", null, PROJECT_A);
    await domain.addTask("task-b", "B", null, PROJECT_B);
    await domain.addWaitingCondition("manual-a", PROJECT_A, "wait");
    await domain.addProjectAfter("after-out", PROJECT_A, PROJECT_B);
    await domain.addProjectAfter("after-in", PROJECT_C, PROJECT_A);

    expect(await domain.deleteProject(PROJECT_A)).toEqual({ tasks: 1, conditions: 1, afters: 2 });
    expect(domain.listTasks().map((task) => task.id)).toEqual(["task-b"]);
    expect(domain.listWaitingConditions()).toEqual([]);
    expect(domain.listProjects().map((project) => project.id)).toEqual([PROJECT_B, PROJECT_C]);
    expect(await domain.deleteProject(PROJECT_A)).toEqual({ tasks: 0, conditions: 0, afters: 0 });
  });

  it("adds, resolves, and deletes a manual Waiting condition idempotently", async () => {
    const { domain, saves } = setup();
    await domain.addProject(PROJECT_A, "A");
    const created = await domain.addWaitingCondition("wait-a", PROJECT_A, "reply");
    expect(await domain.addWaitingCondition("wait-a", PROJECT_A, "replacement")).toEqual(created);
    expect(domain.listWaitingConditions()).toEqual([created]);

    const resolved = await domain.resolveWaitingCondition("wait-a");
    expect(resolved?.resolvedAt).toBe("2026-09-26T10:00:00.000Z");
    expect(await domain.resolveWaitingCondition("wait-a")).toEqual(resolved);
    expect(domain.listWaitingConditions()).toEqual([]);
    await domain.deleteWaitingCondition("wait-a");
    await domain.deleteWaitingCondition("wait-a");
    expect(saves()).toBe(4);
  });

  it.each([
    ["missing-source", "after", PROJECT_A, PROJECT_B],
    ["missing-target", "after", PROJECT_A, PROJECT_B],
    ["target-done", "after", PROJECT_A, PROJECT_B],
    ["self", "after", PROJECT_A, PROJECT_A],
  ] as const)("rejects an After with %s", async (conflict, id, source, target) => {
    const { domain } = setup();
    if (conflict !== "missing-source") await domain.addProject(source, "source");
    if (conflict === "target-done") await domain.addProject(target, "target", { state: "done" });
    else if (conflict !== "missing-target" && target !== source) await domain.addProject(target, "target");
    expect(await domain.addProjectAfter(id, source, target)).toEqual({ conflict });
  });

  it("rejects After duplicates, cycles, and reused ids while retrying the same relationship", async () => {
    const { domain } = setup();
    await addProjects(domain, PROJECT_A, PROJECT_B, PROJECT_C);
    const created = await domain.addProjectAfter("after-ab", PROJECT_A, PROJECT_B);
    expect(await domain.addProjectAfter("after-ab", PROJECT_A, PROJECT_B)).toEqual(created);
    expect(await domain.addProjectAfter("after-ab-2", PROJECT_A, PROJECT_B)).toEqual({ conflict: "duplicate" });
    expect(await domain.addProjectAfter("after-bc", PROJECT_B, PROJECT_C)).toHaveProperty("relationship");
    expect(await domain.addProjectAfter("after-ca", PROJECT_C, PROJECT_A)).toEqual({ conflict: "cycle" });
    await domain.addWaitingCondition("used-id", PROJECT_A, "manual");
    expect(await domain.addProjectAfter("used-id", PROJECT_A, PROJECT_C)).toEqual({ conflict: "id-conflict" });
  });

  it("settles and reopens After relationships when the target changes state", async () => {
    const { domain, setNow } = setup();
    await addProjects(domain, PROJECT_A, PROJECT_B);
    await domain.addProjectAfter("after", PROJECT_A, PROJECT_B);
    setNow("2026-09-26T11:00:00.000Z");

    await domain.setProjectState(PROJECT_B, "done");
    expect(domain.listWaitingConditions()).toEqual([]);
    expect(domain.listConditionRecoveries()).toEqual([]);

    await domain.setProjectState(PROJECT_B, "in-play");
    expect(domain.listWaitingConditions()).toMatchObject([{ id: "after", resolvedAt: null }]);
  });

  it("reports every malformed synchronized condition class while retaining a stable valid subset", async () => {
    const { domain, store } = setup();
    await addProjects(domain, PROJECT_A, PROJECT_B, PROJECT_C);
    await domain.setProjectState(PROJECT_C, "done");
    const raw = (id: string, row: Parameters<MergeableStore["setRow"]>[2]) =>
      store.setRow("conditions", id, row);
    raw("00-invalid", { projectId: PROJECT_A, kind: "free-text", text: "" });
    raw("01-missing-source", { projectId: "missing", kind: "free-text", text: "x", createdAt: "1" });
    raw("02-missing-target", { projectId: PROJECT_A, kind: "project-status", refId: "missing", targetStatus: "done", createdAt: "2" });
    raw("03-target-done", { projectId: PROJECT_A, kind: "project-status", refId: PROJECT_C, targetStatus: "done", createdAt: "3" });
    raw("04-self", { projectId: PROJECT_A, kind: "project-status", refId: PROJECT_A, targetStatus: "done", createdAt: "4" });
    raw("05-valid", { projectId: PROJECT_A, kind: "project-status", refId: PROJECT_B, targetStatus: "done", createdAt: "5" });
    raw("06-duplicate", { projectId: PROJECT_A, kind: "project-status", refId: PROJECT_B, targetStatus: "done", createdAt: "6" });
    raw("07-cycle", { projectId: PROJECT_B, kind: "project-status", refId: PROJECT_A, targetStatus: "done", createdAt: "7" });

    expect(domain.listWaitingConditions().map((condition) => condition.id)).toEqual(["05-valid"]);
    expect(domain.listConditionRecoveries().map(({ conditionId, reason }) => ({ conditionId, reason }))).toEqual([
      { conditionId: "00-invalid", reason: "invalid-row" },
      { conditionId: "01-missing-source", reason: "missing-source" },
      { conditionId: "02-missing-target", reason: "missing-target" },
      { conditionId: "03-target-done", reason: "target-done" },
      { conditionId: "04-self", reason: "self" },
      { conditionId: "06-duplicate", reason: "duplicate" },
      { conditionId: "07-cycle", reason: "cycle" },
    ]);
  });

  it("blocks all mutations once the account is erased", async () => {
    const { domain, erase } = setup();
    erase();
    await expect(domain.addTask("task", "task", null)).rejects.toThrow("Todo account erased");
    await expect(domain.addProject(PROJECT_A, "A")).rejects.toThrow("Account erased");
  });
});
