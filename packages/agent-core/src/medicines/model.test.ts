import { afterEach, describe, expect, it } from "vitest";
import { createMergeableStore } from "tinybase";
import { MedicineModel, medicineCadence, medicineEndDate, medicineNextDay, medicineOccurrences, medicineState, type MedicineInput, type MedicineReceipt } from "./model";

const input: MedicineInput = { name: "Daily pill", instructions: "1 pill", startsOn: "2026-10-02", endsOn: "2026-10-11", paused: false, weekdays: [1, 2, 3, 4, 5, 6, 7],
  doses: [{ id: "morning", remindAt: "07:00", alarmAt: "08:00" }, { id: "evening", remindAt: "20:00", alarmAt: "22:00" }] };
const now = () => new Date("2026-10-02T12:00:00");
function setup() { const store = createMergeableStore(); const model = new MedicineModel(store, now); model.add("medicine", input); return { model, store }; }

describe("daily medicines", () => {
  it("records one dose independently and retains its exact confirmation through restart", () => {
    const { model, store } = setup(); const doses = medicineOccurrences(model.get("medicine")!, "2026-10-02");
    model.take(doses[0], "taken1", "2026-10-02T07:42:00Z");
    const reopened = new MedicineModel(store, now);
    expect(reopened.getDose(doses[0].id)?.takenAt).toBe("2026-10-02T07:42:00Z");
    expect(reopened.getDose(doses[1].id)).toBeNull();
    reopened.undo(doses[0].id, "undo1");
    expect(reopened.getDose(doses[0].id)?.takenAt).toBeNull();
  });
  it("includes the last day and stops after it without extending for a pause", () => {
    const { model } = setup(); const medicine = model.get("medicine")!;
    expect(medicineEndDate("2026-10-02", 10)).toBe("2026-10-11");
    expect(medicineOccurrences(medicine, "2026-10-11")).toHaveLength(2);
    expect(medicineOccurrences(medicine, "2026-10-12")).toEqual([]);
    model.edit(medicine.id, { ...input, paused: true });
    expect(medicineOccurrences(model.get(medicine.id)!, "2026-10-03")).toEqual([]);
    expect(medicineState(model.get(medicine.id)!, "2026-10-12")).toBe("ended");
  });
  it("preserves the schedule confirmed against when another offline device edits it", () => {
    const { store, model } = setup(); const other = createMergeableStore(); other.setMergeableContent(store.getMergeableContent());
    const dose = medicineOccurrences(model.get("medicine")!, "2026-10-02")[1]; model.present(dose);
    other.merge(store);
    model.take(dose, "take", "2026-10-02T20:35:00Z");
    const otherModel = new MedicineModel(other, now);
    otherModel.edit("medicine", { ...input, doses: [{ id: "evening", remindAt: "20:00", alarmAt: "23:00" }] });
    otherModel.present({ ...dose, scheduledAt: new Date("2026-10-02T23:00:00").toISOString() });
    store.merge(other);
    expect(model.getDose(dose.id)?.scheduledAt).toBe(dose.scheduledAt);
    expect(model.getDose(dose.id)?.takenAt).toBe("2026-10-02T20:35:00Z");
  });
  it("does not recreate a taken dose when an imported receipt replays after Undo", () => {
    const { model } = setup(); const dose = medicineOccurrences(model.get("medicine")!, "2026-10-02")[0];
    const receipt: MedicineReceipt = { ...dose, actionId: "native1", kind: "taken", takenAt: "2026-10-02T07:40:00Z" };
    model.applyReceipts([receipt], "device"); model.undo(dose.id, "undo"); model.applyReceipts([receipt], "device");
    expect(model.getDose(dose.id)?.takenAt).toBeNull();
  });
  it("hides late offline dose receipts after the medicine is deleted", () => {
    const { model } = setup(); const dose = medicineOccurrences(model.get("medicine")!, "2026-10-02")[0];
    model.take(dose, "take"); model.remove("medicine");
    model.applyReceipts([{ ...dose, kind: "taken", actionId: "late", takenAt: now().toISOString() }], "device");
    expect(model.snapshot()).toEqual({ medicines: [], doses: [], recoveries: [] });
  });
  it("rejects invalid schedules and retains malformed synchronized intent for recovery", () => {
    const { model, store } = setup();
    expect(() => model.edit("medicine", { ...input, doses: [] })).toThrow("Add between");
    expect(() => model.edit("medicine", { ...input, endsOn: "2026-09-30" })).toThrow("last day");
    store.setCell("medicines", "medicine", "details", "broken");
    expect(model.snapshot().medicines).toEqual([]);
    expect(model.snapshot().recoveries[0]?.table).toBe("medicines");
    expect(store.getCell("medicines", "medicine", "details")).toBe("broken");
  });
});

describe("medicines on chosen weekdays", () => {
  const monWedFri = { ...input, startsOn: "2026-10-06", endsOn: null, weekdays: [1, 3, 5] } as MedicineInput;
  const zone = process.env.TZ;
  afterEach(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

  it("has doses only on the chosen weekdays, starting on the first one after the start day", () => {
    const { model } = setup(); model.add("mwf", monWedFri); const medicine = model.get("mwf")!;
    const week = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"];
    expect(week.filter((on) => medicineOccurrences(medicine, on).length)).toEqual(["2026-10-07", "2026-10-09", "2026-10-12"]);
  });
  it.each(["Pacific/Kiritimati", "America/Los_Angeles"])("reads the weekday from the date alone in %s", (tz) => {
    process.env.TZ = tz;
    const { model } = setup(); model.add("mwf", monWedFri);
    expect(medicineOccurrences(model.get("mwf")!, "2026-10-09")).toHaveLength(2);
    expect(medicineOccurrences(model.get("mwf")!, "2026-10-10")).toEqual([]);
  });
  it("reads a medicine saved without weekdays as daily", () => {
    const { model, store } = setup(); const { weekdays: _weekdays, ...legacy } = input;
    store.setCell("medicines", "medicine", "details", JSON.stringify(legacy));
    expect(model.get("medicine")?.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(medicineOccurrences(model.get("medicine")!, "2026-10-04")).toHaveLength(2);
  });
  it.each([[[]], [[0]], [[8]], [[1, 1]], [[3, 1]], [[1.5]]])("rejects weekdays %j", (weekdays) => {
    const { model } = setup();
    expect(() => model.edit("medicine", { ...input, weekdays } as MedicineInput)).toThrow("day of the week");
  });
  it("finds the next dose day, ignoring pause, until the course ends", () => {
    const medicine = { ...monWedFri, id: "mwf", createdAt: "2026-10-01T00:00:00Z" };
    expect(medicineNextDay(medicine, "2026-10-09")).toBe("2026-10-09");
    expect(medicineNextDay(medicine, "2026-10-10")).toBe("2026-10-12");
    expect(medicineNextDay(medicine, "2026-10-01")).toBe("2026-10-07");
    expect(medicineNextDay({ ...medicine, paused: true }, "2026-10-10")).toBe("2026-10-12");
    expect(medicineNextDay({ ...medicine, endsOn: "2026-10-11" }, "2026-10-10")).toBeNull();
  });
  it("describes how often a medicine is taken", () => {
    const one = [input.doses[0]];
    expect(medicineCadence({ ...input, doses: one })).toBe("Once a day");
    expect(medicineCadence(input)).toBe("2 times a day");
    expect(medicineCadence({ ...monWedFri, doses: one })).toBe("Mon, Wed, Fri");
    expect(medicineCadence(monWedFri)).toBe("2 times on Mon, Wed, Fri");
  });
});
