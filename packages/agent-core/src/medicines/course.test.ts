import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { TodoModel } from "../taskdo/model";
import { finishesCourse, MedicineModel, medicineLastDoseAt, medicineOccurrences, medicineState, type MedicineInput } from "./model";
import { medicineSchedule } from "./notifications";

const twiceDaily: MedicineInput = { name: "Amoxicillin", instructions: null, startsOn: "2026-10-01", endsOn: null, untilEmpty: true, paused: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [
    { id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 1 },
    { id: "evening", remindAt: "19:45", alarmAt: "20:00", amount: 1 },
  ] };

function setup(input: MedicineInput = twiceDaily, pillsLeft = 10) {
  const store = createMergeableStore();
  const clock = { at: "2026-10-01T07:00:00" };
  const now = () => new Date(clock.at);
  let next = 0;
  const model = new MedicineModel(store, now, () => `task-${++next}`);
  const todo = new TodoModel({ store, now });
  model.add("m", input, pillsLeft);
  const dose = (day: string, slot: string) => medicineOccurrences(model.get("m")!, day).find((item) => item.slotId === slot)!;
  const endsOn = () => model.get("m")?.endsOn;
  const restockTasks = () => todo.project().tasks.filter((task) => task.parent?.kind === "medicine");
  return { clock, model, dose, endsOn, restockTasks };
}

describe("A course that runs until the pills run out", () => {
  it("ends on the day the last pill is due", () => {
    const { model, endsOn } = setup();
    expect(model.get("m")).toMatchObject({ untilEmpty: true, supply: { pillsLeft: 10 } });
    expect(endsOn()).toBe("2026-10-05");
  });

  it("keeps the last day when a dose is taken, also when the receipt replays", () => {
    const { model, dose, endsOn } = setup();
    model.take(dose("2026-10-01", "morning"), "a");
    const receipt = { ...dose("2026-10-01", "evening"), actionId: "native", kind: "taken" as const, takenAt: "2026-10-01T20:01:00Z" };
    model.applyReceipts([receipt], "phone");
    model.applyReceipts([receipt], "phone");
    expect(model.get("m")?.supply?.pillsLeft).toBe(8);
    expect(endsOn()).toBe("2026-10-05");
  });

  it("moves the last day later when a dose is skipped or a Taken is undone", () => {
    const { model, dose, endsOn } = setup();
    model.skip(dose("2026-10-01", "morning"), "skip");
    expect(endsOn()).toBe("2026-10-06");
    model.take(dose("2026-10-01", "evening"), "take");
    model.undo(dose("2026-10-01", "evening").id, "undo");
    expect(model.get("m")?.supply?.pillsLeft).toBe(10);
    expect(endsOn()).toBe("2026-10-06");
  });

  it("ends when the last pill is taken, and continues after a restock", () => {
    const { clock, model, dose, endsOn } = setup(twiceDaily, 1);
    expect(endsOn()).toBe("2026-10-01");
    model.take(dose("2026-10-01", "morning"), "a");
    expect(endsOn()).toBe("2026-10-01");
    clock.at = "2026-10-03T09:00:00";
    expect(medicineState(model.get("m")!, "2026-10-03")).toBe("ended");
    model.restock("m", 4);
    expect(endsOn()).toBe("2026-10-04");
    expect(medicineState(model.get("m")!, "2026-10-03")).toBe("active");
  });

  it("ends yesterday when a recount finds no pills and today's doses are still open", () => {
    const { clock, model, endsOn } = setup();
    clock.at = "2026-10-03T07:00:00";
    model.setSupply("m", { pillsLeft: 0, leadDays: 14 });
    expect(endsOn()).toBe("2026-10-02");
  });

  it("counts only the chosen weekdays and each dose's pills", () => {
    const { endsOn } = setup({ ...twiceDaily, weekdays: [1, 3, 5], doses: [{ id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 2 }] }, 7);
    expect(endsOn()).toBe("2026-10-07");
  });

  it("reaches far ahead for a large count", () => {
    const { endsOn } = setup({ ...twiceDaily, doses: [twiceDaily.doses[0]] }, 100);
    expect(endsOn()).toBe("2027-01-08");
  });

  it("follows schedule edits", () => {
    const { model, endsOn } = setup();
    model.edit("m", { ...twiceDaily, doses: [twiceDaily.doses[0]] });
    expect(endsOn()).toBe("2026-10-10");
  });

  it("never adds a restock Task", () => {
    const { model, dose, restockTasks } = setup(twiceDaily, 4);
    model.take(dose("2026-10-01", "morning"), "a");
    model.setSupply("m", { pillsLeft: 2, leadDays: 30 });
    expect(restockTasks()).toEqual([]);
  });

  it("needs a pill count", () => {
    const store = createMergeableStore();
    const model = new MedicineModel(store, () => new Date("2026-10-01T07:00:00"));
    expect(() => model.add("m", twiceDaily)).toThrow("Count your pills first");
  });

  it("keeps its last day as a fixed one when the count is cleared", () => {
    const { model } = setup();
    model.clearSupply("m");
    expect(model.get("m")).toMatchObject({ untilEmpty: false, endsOn: "2026-10-05", supply: null });
  });
});

const threeDaily: MedicineInput = { ...twiceDaily, doses: [
  { id: "morning", remindAt: "07:30", alarmAt: "08:00", amount: 1 },
  { id: "noon", remindAt: "13:30", alarmAt: "14:00", amount: 1 },
  { id: "evening", remindAt: "19:30", alarmAt: "20:00", amount: 1 },
] };

describe("A course whose pills run out partway through a day", () => {
  const slots = (model: MedicineModel, day = "2026-10-01") => medicineOccurrences(model.get("m")!, day).map((dose) => dose.slotId);

  it("plans only the doses the pills cover on the last day", () => {
    const { model, endsOn } = setup(threeDaily, 2);
    expect(endsOn()).toBe("2026-10-01");
    expect(slots(model)).toEqual(["morning", "noon"]);
    expect(medicineLastDoseAt(model.get("m")!)).toBe("14:00");
  });

  it("sets no reminder for a dose the pills do not cover", () => {
    const { model } = setup(threeDaily, 2);
    const evening = medicineSchedule(model.snapshot()).reminders.find((reminder) => reminder.at === "20:00")!;
    expect(evening.recurrence.until).toBe("2026-09-30");
    const morning = medicineSchedule(model.snapshot()).reminders.find((reminder) => reminder.at === "08:00")!;
    expect(morning.recurrence.until).toBe("2026-10-01");
  });

  it("ends when the last pill is taken, and the dose after it never appears", () => {
    const { clock, model, dose } = setup(threeDaily, 2);
    model.take(dose("2026-10-01", "morning"), "a");
    expect(finishesCourse(model.get("m")!, "noon")).toBe(true);
    clock.at = "2026-10-01T14:00:00";
    model.take(dose("2026-10-01", "noon"), "b");
    expect(model.get("m")?.supply?.pillsLeft).toBe(0);
    expect(medicineState(model.get("m")!, "2026-10-01")).toBe("ended");
    expect(slots(model)).toEqual(["morning", "noon"]);
  });

  it("does not finish the course on a Take that leaves pills", () => {
    const { model } = setup(threeDaily, 2);
    expect(finishesCourse(model.get("m")!, "morning")).toBe(false);
  });

  it("keeps the count when a dose is skipped and the skip is undone", () => {
    const { model, dose } = setup(threeDaily, 3);
    model.take(dose("2026-10-01", "morning"), "a");
    model.take(dose("2026-10-01", "noon"), "b");
    const evening = dose("2026-10-01", "evening");
    model.skip(evening, "c");
    expect(model.get("m")?.supply?.pillsLeft).toBe(1);
    model.undo(evening.id, "d");
    expect(model.get("m")?.supply?.pillsLeft).toBe(1);
    expect(slots(model)).toEqual(["morning", "noon", "evening"]);
  });

  it("comes back when the last Take is undone", () => {
    const { model, dose } = setup(threeDaily, 2);
    model.take(dose("2026-10-01", "morning"), "a");
    model.take(dose("2026-10-01", "noon"), "b");
    model.undo(dose("2026-10-01", "noon").id, "c");
    expect(model.get("m")?.supply?.pillsLeft).toBe(1);
    expect(medicineState(model.get("m")!, "2026-10-01")).toBe("active");
    expect(slots(model)).toEqual(["morning", "noon"]);
  });

  it("continues with the rest of the day after a restock", () => {
    const { model, dose } = setup(threeDaily, 2);
    model.take(dose("2026-10-01", "morning"), "a");
    model.take(dose("2026-10-01", "noon"), "b");
    model.restock("m", 4);
    expect(medicineState(model.get("m")!, "2026-10-01")).toBe("active");
    expect(slots(model)).toEqual(["morning", "noon", "evening"]);
    expect(slots(model, "2026-10-02")).toEqual(["morning", "noon", "evening"]);
    expect(model.get("m")?.endsOn).toBe("2026-10-02");
  });

  it("ends before the first open dose when a recount finds no pills", () => {
    const { model, dose } = setup(threeDaily, 9);
    model.take(dose("2026-10-01", "morning"), "a");
    model.setSupply("m", { pillsLeft: 0, leadDays: 14 });
    expect(model.get("m")?.endsOn).toBe("2026-10-01");
    expect(slots(model)).toEqual(["morning"]);
  });

  it("covers the whole last day when the pills reach its last dose", () => {
    const { model } = setup(threeDaily, 3);
    expect(slots(model)).toEqual(["morning", "noon", "evening"]);
    expect(slots(model, "2026-10-02")).toEqual([]);
  });

  it("drops the part-day end when the count is cleared", () => {
    const { model } = setup(threeDaily, 2);
    model.clearSupply("m");
    expect(slots(model)).toEqual(["morning", "noon", "evening"]);
  });
});
