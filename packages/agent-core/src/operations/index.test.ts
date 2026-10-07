import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { MedicineModel, medicineOccurrences } from "../medicines/model";
import { runTodoOperation, todoOperations, type OperationContext, type OperationOutcome } from "./index";

function workspace(today = "2026-03-10") {
  let next = 0;
  const ctx: OperationContext = {
    store: createMergeableStore(),
    now: () => new Date(`${today}T09:00:00Z`),
    today,
    newId: () => `id-${++next}`,
  };
  const run = (name: string, input: unknown = {}) => runTodoOperation(ctx, name, input);
  const value = <T>(outcome: OperationOutcome): T => {
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value as T;
  };
  return { ctx, run, value };
}

const daily = (origin: string) => ({
  version: 1, origin, anchor: "scheduled", weekStartsOn: "MO", pattern: { unit: "day", interval: 1 },
});

describe("todo operation catalog", () => {
  it("names every operation uniquely in MCP tool form", () => {
    const names = todoOperations.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("offers a list operation for every synchronized entity table", () => {
    const reads = todoOperations.filter((operation) => operation.kind === "read").map((operation) => operation.name);
    expect(reads).toEqual(expect.arrayContaining(["tasks_list", "projects_list", "conditions_list", "medicines_list", "recoveries_list"]));
  });

  it("creates Tasks with generated ids and lists them in manual order", () => {
    const { run, value } = workspace();
    value(run("tasks_create", { text: "Buy milk" }));
    value(run("tasks_create", { text: "Call Ana", showUpDate: "2026-03-12" }));

    const { tasks } = value<{ tasks: Array<{ id: string; text: string; showUpDate: string | null }> }>(run("tasks_list"));
    expect(tasks.map((task) => [task.id, task.text, task.showUpDate])).toEqual([
      ["id-1", "Buy milk", null],
      ["id-2", "Call Ana", "2026-03-12"],
    ]);
  });

  it("treats a replayed create with the same id as unchanged", () => {
    const { run } = workspace();
    run("tasks_create", { id: "t1", text: "Once" });
    expect(run("tasks_create", { id: "t1", text: "Once" })).toMatchObject({ ok: true, changed: false });
  });

  it("rejects invalid input with a readable error and writes nothing", () => {
    const { run, value } = workspace();
    const outcome = run("tasks_create", { text: "", showUpDate: "tomorrow" });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/showUpDate/);
    expect(value<{ tasks: unknown[] }>(run("tasks_list")).tasks).toEqual([]);
  });

  it("reports model conflicts by name", () => {
    const { run } = workspace();
    expect(run("tasks_create", { text: "Orphan", projectId: "nope" })).toEqual({ ok: false, error: "missing-project" });
    expect(run("tasks_complete", { id: "nope" })).toEqual({ ok: false, error: "missing-task" });
    expect(run("no_such_tool")).toEqual({ ok: false, error: "unknown operation: no_such_tool" });
  });

  it("advances a recurring Task on completion and does not advance twice on replay", () => {
    const { run, value } = workspace();
    value(run("tasks_create", { id: "r", text: "Stretch", recurrence: daily("2026-03-10") }));

    const first = value<{ recurrenceDate: string; completedAt: string | null }>(run("tasks_complete", { id: "r" }));
    expect(first).toMatchObject({ recurrenceDate: "2026-03-11", completedAt: null });

    const { tasks } = value<{ tasks: Array<{ recurrenceDate: string }> }>(run("tasks_list"));
    expect(tasks[0].recurrenceDate).toBe("2026-03-11");
  });

  it("completes and reopens a one-off Task", () => {
    const { run, value } = workspace();
    value(run("tasks_create", { id: "t", text: "File taxes" }));
    value(run("tasks_complete", { id: "t" }));
    expect(value<{ tasks: unknown[] }>(run("tasks_list")).tasks).toEqual([]);
    value(run("tasks_reopen", { id: "t" }));
    expect(value<{ tasks: unknown[] }>(run("tasks_list")).tasks).toHaveLength(1);
  });

  it("reports calculated Project attention and cascades Project deletion", () => {
    const { run, value } = workspace();
    value(run("projects_create", { id: "p", title: "Move flat" }));
    value(run("projects_create", { id: "q", title: "Paint walls" }));
    value(run("tasks_create", { text: "Book van", projectId: "p" }));
    value(run("waiting_create", { projectId: "p", text: "Landlord reply" }));
    value(run("after_create", { projectId: "q", afterProjectId: "p" }));

    const { projects } = value<{ projects: Array<{ id: string; attention: string }> }>(run("projects_list"));
    expect(projects.map((project) => [project.id, project.attention])).toEqual([["p", "waiting"], ["q", "after"]]);

    expect(run("after_create", { projectId: "p", afterProjectId: "q" })).toEqual({ ok: false, error: "cycle" });
    expect(value(run("projects_delete", { id: "p" }))).toEqual({ tasks: 1, conditions: 1, afters: 1 });
    expect(value<{ conditions: unknown[] }>(run("conditions_list")).conditions).toEqual([]);
  });

  it("lists done Projects only when asked", () => {
    const { run, value } = workspace();
    value(run("projects_create", { id: "p", title: "Old", state: "done" }));
    expect(value<{ projects: unknown[] }>(run("projects_list")).projects).toEqual([]);
    expect(value<{ projects: unknown[] }>(run("projects_list", { includeDone: true })).projects).toHaveLength(1);
  });

  it("only reads Medicines, because the phone sets alarms only when the app sees a change", () => {
    const medicineOperations = todoOperations.filter((operation) => operation.name.startsWith("medicines_"));
    expect(medicineOperations.map((operation) => [operation.name, operation.kind])).toEqual([["medicines_list", "read"]]);
  });

  it("lists Medicines and their Doses since a date", () => {
    const { ctx, run, value } = workspace();
    const model = new MedicineModel(ctx.store, ctx.now);
    const medicine = model.add("m", {
      name: "Vitamin D", instructions: null, startsOn: "2026-03-01", endsOn: null, paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7],
      doses: [{ id: "morning", remindAt: "08:00", alarmAt: "08:30" }],
    });
    const [old] = medicineOccurrences(medicine, "2026-03-02");
    const [recent] = medicineOccurrences(medicine, "2026-03-09");
    model.take(old, "a1");
    model.take(recent, "a2");

    const listed = value<{ today: string; medicines: Array<{ id: string }>; doses: Array<{ id: string }> }>(run("medicines_list"));
    expect(listed.today).toBe("2026-03-10");
    expect(listed.medicines.map((m) => m.id)).toEqual(["m"]);
    expect(listed.doses.map((dose) => dose.id)).toEqual([recent.id]);
  });

  it("reports invalid synchronized rows as recoveries instead of listing them", () => {
    const { ctx, run, value } = workspace();
    ctx.store.setRow("tasks", "bad", { text: "Lost", createdAt: "2026-03-01T00:00:00Z", projectId: "gone" });

    expect(value(run("recoveries_list"))).toEqual({
      todo: [{ table: "tasks", id: "bad", projectId: "gone", reason: "missing-project" }],
      medicines: [],
    });
  });
});
