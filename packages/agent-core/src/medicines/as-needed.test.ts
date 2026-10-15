import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { TodoModel } from "../taskdo/model";
import { MedicineDraft } from "./draft";
import { medicineNextDay, medicineOccurrences, medicineState, MedicineModel, type MedicineInput } from "./model";
import { medicineSchedule } from "./notifications";
import { supplyLabel } from "./supply";

const TODAY = "2026-10-05";
const asNeeded = (name = "Ibuprofen", pillsLeft: number | null = null): MedicineInput =>
  MedicineDraft.create(TODAY).change({ name }).withCourse({ kind: "as-needed", pillsLeft }).commit();

function setup(pillsLeft?: number) {
  const store = createMergeableStore();
  const clock = { at: `${TODAY}T14:30:00` };
  let next = 0;
  const model = new MedicineModel(store, () => new Date(clock.at), () => `id-${++next}`);
  model.add("m", asNeeded(), pillsLeft);
  return { store, clock, model };
}

describe("An as-needed medicine", () => {
  it("has no dose times, no doses and no reminders", () => {
    const { model } = setup();
    const medicine = model.get("m")!;
    expect(medicine).toMatchObject({ name: "Ibuprofen", asNeeded: true, doses: [], endsOn: null });
    expect(medicineState(medicine, TODAY)).toBe("active");
    expect(medicineOccurrences(medicine, TODAY)).toEqual([]);
    expect(medicineNextDay(medicine, TODAY)).toBeNull();
    expect(medicineSchedule(model.snapshot()).reminders).toEqual([]);
  });

  it("records each intake with its time and pills, newest first", () => {
    const { model, clock } = setup();
    model.takeAsNeeded("m", 2);
    clock.at = `${TODAY}T20:00:00`;
    model.takeAsNeeded("m", 1);
    expect(model.snapshot().intakes).toEqual([
      { id: "id-2", medicineId: "m", takenAt: new Date(`${TODAY}T20:00:00`).toISOString(), amount: 1 },
      { id: "id-1", medicineId: "m", takenAt: new Date(`${TODAY}T14:30:00`).toISOString(), amount: 2 },
    ]);
  });

  it("subtracts the pills taken from a counted supply, never below zero", () => {
    const { model } = setup(3);
    model.takeAsNeeded("m", 2);
    expect(supplyLabel(model.get("m")!)).toBe("1 pill left");
    model.takeAsNeeded("m", 2);
    expect(model.get("m")!.supply?.pillsLeft).toBe(0);
  });

  it("gives the pills back when an intake is removed", () => {
    const { model } = setup(10);
    const intake = model.takeAsNeeded("m", 2);
    model.removeIntake(intake.id);
    expect(model.snapshot().intakes).toEqual([]);
    expect(model.get("m")!.supply?.pillsLeft).toBe(10);
  });

  it("adds no restock Task when the pills run out", () => {
    const { model, store } = setup(1);
    model.takeAsNeeded("m", 1);
    expect(new TodoModel({ store }).project().tasks).toEqual([]);
  });

  it("can be archived while in use, and then takes no intakes", () => {
    const { model } = setup();
    model.archive("m");
    expect(model.get("m")!.archivedAt).not.toBeNull();
    expect(() => model.takeAsNeeded("m", 1)).toThrow("Unarchive this medicine to record taking it");
  });

  it("refuses a pill count below one", () => {
    const { model } = setup();
    expect(() => model.takeAsNeeded("m", 0)).toThrow("Take at least one pill");
  });

  it("cannot become a scheduled medicine, nor a scheduled one as needed", () => {
    const { model } = setup();
    const routine = MedicineDraft.create(TODAY).change({ name: "Vitamin D" }).commit();
    expect(() => model.edit("m", routine)).toThrow("A medicine can't switch between scheduled and as needed");
    model.add("r", routine);
    expect(() => model.edit("r", asNeeded("Vitamin D"))).toThrow("A medicine can't switch between scheduled and as needed");
    expect(() => model.takeAsNeeded("r", 1)).toThrow("This medicine follows a schedule");
  });

  it("drops its intakes when it is deleted", () => {
    const { model } = setup();
    model.takeAsNeeded("m", 1);
    model.remove("m");
    expect(model.snapshot()).toMatchObject({ medicines: [], intakes: [], recoveries: [] });
  });
});
