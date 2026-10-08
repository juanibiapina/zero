import type { Recurrence } from "@zeroapps/recurrence";
import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { projectParent } from "../tasks/parent";

import { TodoModel } from "./model";

const NOW = "2026-09-26T10:00:00.000Z";
const daily: Recurrence = {
  version: 1,
  origin: "2026-10-01",
  anchor: "scheduled",
  weekStartsOn: "MO",
  pattern: { unit: "day", interval: 1 },
};

function setup() {
  const store = createMergeableStore();
  let now = NOW;
  const model = new TodoModel({ store, now: () => new Date(now) });
  return { model, store, setNow: (value: string) => { now = value; } };
}

function addProjects(model: TodoModel, ...ids: string[]) {
  for (const id of ids) model.createProject({ id, title: id });
}

describe("canonical TinyBase todo model", () => {
  it("normalizes absent recurrence cells to the complete Task shape", () => {
    const { model, store } = setup();
    store.setRow("tasks", "task", { text: "Task", createdAt: NOW });

    expect(model.getTask("task")).toMatchObject({
      id: "task",
      recurrence: null,
      recurrenceDate: null,
    });
    expect(model.project().tasks).toMatchObject([{
      id: "task",
      recurrence: null,
      recurrenceDate: null,
    }]);
  });

  it("creates Tasks idempotently with stable rows, timestamps, and trailing order keys", () => {
    const { model, store, setNow } = setup();
    store.setRow("tasks", "bad", { text: "bad", createdAt: "2026-01-01T00:00:00.000Z", sortKey: "\u0000bad" });
    setNow("2026-09-27T00:00:00.000Z");

    const created = model.createTask({ id: "task", text: "first" });
    const retried = model.createTask({ id: "task", text: "replacement", showUpDate: "2027-01-01" });

    expect(created).toMatchObject({ ok: true, changed: true, value: { text: "first", createdAt: "2026-09-27T00:00:00.000Z" } });
    expect(retried).toEqual({ ...created, changed: false });
    expect(model.project().tasks.map((task) => task.id)).toEqual(["bad", "task"]);
  });

  it("rejects missing Projects and classifies late offline children without hiding them", () => {
    const { model, store } = setup();
    expect(model.createTask({ id: "missing", text: "x", parent: projectParent("p") })).toEqual({ ok: false, conflict: "missing-project" });
    model.createProject({ id: "p", title: "P" });
    model.deleteProject("p");
    store.setRow("tasks", "late", { text: "Keep", createdAt: NOW, projectId: "p" });

    expect(model.project().tasks).toMatchObject([{ id: "late", parent: null }]);
    expect(model.project().issues).toContainEqual({ table: "tasks", id: "late", projectId: "p", reason: "deleted-project" });
  });

  it("edits, schedules, assigns, completes, and reopens Tasks", () => {
    const { model, setNow } = setup();
    model.createProject({ id: "p", title: "P" });
    model.createTask({ id: "task", text: "draft" });
    expect(model.patchTask("task", { text: "final", showUpDate: "2027-01-01", parent: projectParent("p"), sortKey: "a5" }))
      .toMatchObject({ ok: true, value: { text: "final", showUpDate: "2027-01-01", parent: { kind: "project", projectId: "p" }, sortKey: "a5" } });
    expect(model.patchTask("task", { parent: projectParent("missing") })).toEqual({ ok: false, conflict: "missing-project" });
    setNow("2026-09-26T11:00:00.000Z");
    expect(model.completeTask("task")).toMatchObject({ ok: true, changed: true, value: { completedAt: "2026-09-26T11:00:00.000Z" } });
    expect(model.completeTask("task")).toMatchObject({ ok: true, changed: false });
    expect(model.reopenTask("task")).toMatchObject({ ok: true, changed: true, value: { completedAt: null } });
  });

  it("advances recurring Tasks once, supports Undo, and rejects invalid recurrence", () => {
    const { model, store } = setup();
    model.createTask({ id: "daily", text: "daily", recurrence: daily });
    expect(model.completeOccurrence("daily", daily.origin, daily.origin)).toMatchObject({
      ok: true, changed: true, value: { recurrenceDate: "2026-10-02", showUpDate: "2026-10-02" },
    });
    expect(model.completeOccurrence("daily", daily.origin, daily.origin)).toMatchObject({ ok: true, changed: false });
    expect(model.undoOccurrence("daily", "2026-10-02", daily.origin, null)).toMatchObject({
      ok: true, value: { recurrenceDate: daily.origin, showUpDate: null, completedAt: null },
    });
    store.setRow("tasks", "broken", { text: "broken", createdAt: NOW, recurrence: "bad", recurrenceDate: daily.origin });
    expect(model.completeOccurrence("broken", daily.origin, daily.origin)).toEqual({ ok: false, conflict: "invalid-recurrence" });
  });

  it("creates, edits, transitions, restores, and tombstones Projects with cascades", () => {
    const { model } = setup();
    addProjects(model, "a", "b", "c");
    model.createTask({ id: "task", text: "task", parent: projectParent("a") });
    model.createWaiting("wait", "a", "reply");
    model.createAfter("out", "a", "b");
    model.createAfter("in", "c", "a");
    expect(model.editProject("a", { title: "A", description: "Outcome" })).toMatchObject({ ok: true, value: { title: "A", description: "Outcome" } });
    expect(model.deleteProject("a")).toEqual({ ok: true, changed: true, value: { tasks: 1, conditions: 1, afters: 2 } });
    expect(model.project()).toMatchObject({ tasks: [], conditions: [] });
  });

  it("settles and restores Afters with target state and rejects graph conflicts", () => {
    const { model, setNow } = setup();
    addProjects(model, "a", "b", "c");
    expect(model.createAfter("ab", "a", "b")).toHaveProperty("value");
    expect(model.createAfter("ab2", "a", "b")).toEqual({ ok: false, conflict: "duplicate" });
    expect(model.createAfter("bc", "b", "c")).toHaveProperty("value");
    expect(model.createAfter("ca", "c", "a")).toEqual({ ok: false, conflict: "cycle" });
    setNow("2026-09-26T11:00:00.000Z");
    model.setProjectState("b", "done");
    expect(model.project().conditions.map((condition) => condition.id)).toEqual(["bc"]);
    model.setProjectState("b", "in-play");
    expect(model.project().conditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ab", resolvedAt: null })]));
  });

  it("classifies every malformed relationship deterministically and repairs only safe issues", () => {
    const { model, store } = setup();
    addProjects(model, "a", "b", "done");
    model.setProjectState("done", "done");
    const rows = {
      "00-invalid": { projectId: "a", kind: "free-text", text: "" },
      "01-missing-source": { projectId: "missing", kind: "free-text", text: "x", createdAt: "1" },
      "02-missing-target": { projectId: "a", kind: "project-status", refId: "missing", targetStatus: "done", createdAt: "2" },
      "03-target-done": { projectId: "a", kind: "project-status", refId: "done", targetStatus: "done", createdAt: "3" },
      "04-self": { projectId: "a", kind: "project-status", refId: "a", targetStatus: "done", createdAt: "4" },
      "05-valid": { projectId: "a", kind: "project-status", refId: "b", targetStatus: "done", createdAt: "5" },
      "06-duplicate": { projectId: "a", kind: "project-status", refId: "b", targetStatus: "done", createdAt: "6" },
      "07-cycle": { projectId: "b", kind: "project-status", refId: "a", targetStatus: "done", createdAt: "7" },
    };
    for (const [id, row] of Object.entries(rows)) store.setRow("conditions", id, row);
    expect(model.project().conditions.map((condition) => condition.id)).toEqual(["05-valid"]);
    expect(model.project().issues.filter((issue) => issue.table === "conditions").map((issue) => issue.reason)).toEqual([
      "invalid-condition", "missing-source", "missing-target", "target-done", "self", "duplicate", "cycle",
    ]);
    const issue = model.project().issues.find((candidate) => candidate.table === "conditions" && candidate.id === "06-duplicate")!;
    expect(model.repair(issue)).toBe(true);
    expect(model.repair(issue)).toBe(false);
  });

  it("keeps raw row representation stable", () => {
    const { model, store } = setup();
    model.createProject({ id: "p", title: "P", description: null });
    model.createTask({ id: "task", text: "Task", recurrence: daily, parent: projectParent("p") });
    model.createAfter("after", "p", "p2");
    expect(store.getRow("projects", "p")).toEqual({ title: "P", icon: "📁", state: "in-play", createdAt: NOW });
    expect(store.getRow("tasks", "task")).toMatchObject({
      text: "Task", createdAt: NOW, projectId: "p", recurrence: JSON.stringify(daily),
      recurrenceDate: daily.origin, showUpDate: daily.origin,
    });
  });

  it("keeps create idempotent while explicit restore revives terminal rows", () => {
    const { model } = setup();
    model.createTask({ id: "task", text: "Task" });
    model.completeTask("task");
    expect(model.createTask({ id: "task", text: "Replacement" })).toMatchObject({
      ok: true, changed: false, value: { text: "Task", completedAt: NOW },
    });
    expect(model.restoreTask({ ...model.getTask("task")!, completedAt: null })).toMatchObject({
      ok: true, changed: true, value: { text: "Task", completedAt: null },
    });

    model.createProject({ id: "project", title: "Project" });
    model.setProjectState("project", "done");
    expect(model.restoreProject({ ...model.getProject("project")!, state: "in-play" })).toMatchObject({
      ok: true, changed: true, value: { state: "in-play" },
    });
  });

  it("projects open Tasks, Waiting conditions, and Afters, and every Project", () => {
    const { model } = setup();
    addProjects(model, "a", "b");
    model.createTask({ id: "open", text: "Open" });
    model.createTask({ id: "done", text: "Done" });
    model.completeTask("done");
    model.createWaiting("open-wait", "a", "Open");
    model.createWaiting("done-wait", "a", "Done");
    model.resolveWaiting("done-wait");
    model.createAfter("after", "a", "b");
    model.setProjectState("b", "done");
    model.setProjectState("a", "done");

    expect(model.project()).toMatchObject({
      tasks: [{ id: "open" }],
      projects: [{ id: "a", state: "done" }, { id: "b", state: "done" }],
      conditions: [{ id: "open-wait" }],
    });
  });

  it("finishes inclusive recurrence and repairs invalid recurrence without dropping the Task", () => {
    const { model, store } = setup();
    model.createTask({ id: "finite", text: "Finite", recurrence: { ...daily, until: daily.origin } });
    expect(model.completeOccurrence("finite", daily.origin, daily.origin)).toMatchObject({
      ok: true, value: { completedAt: NOW },
    });
    store.setRow("tasks", "broken", { text: "Keep", createdAt: NOW, recurrence: "{broken", recurrenceDate: daily.origin });
    const issue = model.project().issues.find((candidate) => candidate.table === "tasks" && candidate.id === "broken")!;
    expect(model.repair(issue)).toBe(true);
    expect(store.getRow("tasks", "broken")).toEqual({ text: "Keep", createdAt: NOW });
  });

  it("classifies malformed entities independently while retaining valid rows", () => {
    const { model, store } = setup();
    store.setRow("projects", "bad-project", { title: "Bad" });
    store.setRow("tasks", "bad-task", { projectId: "bad-project", recurrence: "{}" });
    store.setRow("tasks", "valid", { text: "Valid", createdAt: NOW });

    expect(model.project().tasks.map((task) => task.id)).toEqual(["valid"]);
    expect(model.project().issues).toEqual([
      { table: "projects", id: "bad-project", reason: "invalid-project" },
      { table: "tasks", id: "bad-task", projectId: "bad-project", reason: "invalid-task" },
      { table: "tasks", id: "bad-task", projectId: "bad-project", reason: "invalid-recurrence" },
      { table: "tasks", id: "bad-task", projectId: "bad-project", reason: "missing-project" },
    ]);
  });
});
