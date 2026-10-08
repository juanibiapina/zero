import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { createInMemoryNotificationDevice } from "../notifications/in-memory-device";
import { createInMemoryTaskdoReplica } from "../taskdo/in-memory";
import { TodoModel } from "../taskdo/model";
import { homeTasks } from "../tasks/home";
import { MedicineModel, medicineOccurrences, type MedicineInput } from "./model";
import { createMedicineReminders } from "./reminders";

const input: MedicineInput = { name: "Ibuprofen", instructions: null, startsOn: "2026-10-01", endsOn: null, paused: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "evening", remindAt: "19:00", alarmAt: "20:00", amount: 2 }] };

function setup() {
  const store = createMergeableStore();
  const clock = { day: "2026-10-01" };
  const now = () => new Date(`${clock.day}T21:00:00`);
  let next = 0;
  const model = new MedicineModel(store, now, () => `task-${++next}`);
  const todo = new TodoModel({ store, now });
  model.add("m", input);
  const dose = (day: string) => medicineOccurrences(model.get("m")!, day)[0];
  const takeOn = (day: string) => { clock.day = day; model.take(dose(day), `take-${day}`); };
  const restockTasks = () => todo.project().tasks.filter((task) => task.parent?.kind === "medicine");
  return { store, clock, model, todo, dose, takeOn, restockTasks };
}

const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);

describe("Medicine supply", () => {
  it("subtracts each Taken once and adds it back on Undo", () => {
    const { model, dose, takeOn } = setup();
    model.setSupply("m", { pillsLeft: 60, leadDays: 14 });
    takeOn("2026-10-01");
    takeOn("2026-10-01");
    expect(model.get("m")?.supply?.pillsLeft).toBe(58);
    model.undo(dose("2026-10-01").id, "undo");
    model.undo(dose("2026-10-01").id, "undo-again");
    expect(model.get("m")?.supply?.pillsLeft).toBe(60);
  });

  it("does not subtract when a receipt replays", () => {
    const { model, dose } = setup();
    model.setSupply("m", { pillsLeft: 60, leadDays: 14 });
    const receipt = { ...dose("2026-10-01"), actionId: "native", kind: "taken" as const, takenAt: "2026-10-01T20:01:00Z" };
    model.applyReceipts([receipt], "phone");
    model.applyReceipts([receipt], "phone");
    expect(model.get("m")?.supply?.pillsLeft).toBe(58);
  });

  it("stops at zero pills", () => {
    const { model, takeOn } = setup();
    model.setSupply("m", { pillsLeft: 1, leadDays: 14 });
    takeOn("2026-10-01");
    expect(model.get("m")?.supply?.pillsLeft).toBe(0);
  });

  it("puts one Buy Task on Home when Taken makes the supply low", () => {
    const { model, todo, takeOn, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 60, leadDays: 14 });
    for (const day of days(1, 15)) takeOn(day);
    expect(restockTasks()).toEqual([]);
    takeOn("2026-10-16");
    expect(model.get("m")?.supply?.pillsLeft).toBe(28);
    expect(restockTasks()).toMatchObject([{ text: "Buy Ibuprofen", showUpDate: null,
      parent: { kind: "medicine", medicineId: "m", role: "restock" } }]);
    expect(homeTasks(todo.project().tasks, [], "2026-10-16").map((task) => task.text)).toEqual(["Buy Ibuprofen"]);
    takeOn("2026-10-17");
    expect(restockTasks()).toHaveLength(1);
  });

  it("adds the Task when a count is set at or below the threshold, but not on a recount while low", () => {
    const { model, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 20, leadDays: 14 });
    expect(restockTasks()).toHaveLength(1);
    model.setSupply("m", { pillsLeft: 10, leadDays: 14 });
    expect(restockTasks()).toHaveLength(1);
  });

  it("adds the Task when an edit raises the threshold past the pills left", () => {
    const { model, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 40, leadDays: 14 });
    model.edit("m", { ...input, doses: [{ ...input.doses[0], amount: 3 }] });
    expect(restockTasks()).toHaveLength(1);
  });

  it("leaves the Task to the user", () => {
    const { model, todo, takeOn, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 30, leadDays: 14 });
    takeOn("2026-10-01");
    const [task] = restockTasks();
    todo.patchTask(task.id, { text: "Pharmacy run", showUpDate: "2026-10-20" });
    model.edit("m", { ...input, name: "Advil", paused: true });
    model.setSupply("m", { pillsLeft: 20, leadDays: 14 });
    expect(todo.getTask(task.id)).toMatchObject({ text: "Pharmacy run", showUpDate: "2026-10-20" });
    todo.store.delRow("tasks", task.id);
    model.setSupply("m", { pillsLeft: 10, leadDays: 14 });
    expect(restockTasks()).toEqual([]);
  });

  it("adds nothing when the Task is completed without restocking", () => {
    const { model, todo, takeOn, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 30, leadDays: 14 });
    takeOn("2026-10-01");
    todo.completeTask(restockTasks()[0].id);
    takeOn("2026-10-02");
    expect(restockTasks()).toEqual([]);
  });

  it("restocks and completes the Task, and Undo brings back both", () => {
    const { model, todo, takeOn, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 30, leadDays: 14 });
    takeOn("2026-10-01");
    const [task] = restockTasks();
    const undo = model.restock("m", 60, task.id);
    expect(model.get("m")?.supply).toMatchObject({ pillsLeft: 88, refill: 60 });
    expect(todo.getTask(task.id)?.completedAt).not.toBeNull();
    model.undoRestock("m", undo, task.id);
    expect(model.get("m")?.supply).toMatchObject({ pillsLeft: 28, refill: null });
    expect(todo.getTask(task.id)?.completedAt).toBeNull();
    expect(restockTasks()).toHaveLength(1);
  });

  it("leaves a deleted Medicine's Task as a loose Task", () => {
    const { model, todo, restockTasks } = setup();
    model.setSupply("m", { pillsLeft: 10, leadDays: 14 });
    const [task] = restockTasks();
    model.remove("m");
    expect(todo.getTask(task.id)).toMatchObject({ text: "Buy Ibuprofen", parent: null });
  });
});

describe("Taken paths", () => {
  async function replicaSetup() {
    const replica = createInMemoryTaskdoReplica();
    const medicine = await replica.medicines.add({ ...input, startsOn: "2026-10-02" }, "m");
    await replica.medicines.setSupply("m", { pillsLeft: 30, leadDays: 14 });
    const dose = medicineOccurrences(medicine, "2026-10-02")[0];
    return { replica, dose };
  }
  const restock = (replica: ReturnType<typeof createInMemoryTaskdoReplica>) =>
    replica.snapshot().tasks.filter((task) => task.parent?.kind === "medicine");

  it("lowers the supply and adds the Task from in-app Taken", async () => {
    const { replica, dose } = await replicaSetup();
    await replica.medicines.take(dose);
    expect(replica.snapshot().medicines[0].supply?.pillsLeft).toBe(28);
    expect(restock(replica)).toHaveLength(1);
  });

  it.each([false, true])("lowers the supply and adds the Task through reminders (enabled: %s)", async (enabled) => {
    const { replica, dose } = await replicaSetup();
    const device = createInMemoryNotificationDevice({ now: () => "2026-10-02T20:05:00Z" });
    const reminders = createMedicineReminders(replica, device, "account");
    if (enabled) await reminders.enable();
    await reminders.take(dose);
    expect(replica.snapshot().medicines[0].supply?.pillsLeft).toBe(28);
    expect(restock(replica)).toHaveLength(1);
    await reminders.close();
  });
});
