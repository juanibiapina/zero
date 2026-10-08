import { describe, expect, it } from "vitest";
import { createMergeableStore } from "tinybase";
import { QueryClient } from "@tanstack/react-query";
import { MedicineDraft } from "./draft";
import { MedicineModel, medicineOccurrences, type MedicineInput } from "./model";
import { createTaskdoReplica } from "../taskdo/replica";

const today = "2026-10-03";
const custom: MedicineInput = {
  name: "Existing medicine", instructions: "After food", startsOn: "2026-10-01", endsOn: "2026-10-12", paused: true, weekdays: [1, 3, 5],
  doses: [{ id: "morning", alarmAt: "09:10", remindAt: "08:40", amount: 1 }, { id: "evening", alarmAt: "22:00", remindAt: "20:00", amount: 1 }],
};

describe("Medicine drafts", () => {
  it("starts a once-daily routine with a reminder one hour before the alarm", () => {
    const input = MedicineDraft.create(today).change({ name: "Daily medicine" }).commit();
    expect(input.doses.map(({ alarmAt, remindAt }) => ({ alarmAt, remindAt }))).toEqual([{ alarmAt: "20:00", remindAt: "19:00" }]);
  });
  it.each([
    [1, ["20:00"], ["19:00"]],
    [2, ["08:00", "20:00"], ["07:45", "19:45"]],
    [3, ["08:00", "14:00", "20:00"], ["07:30", "13:30", "19:30"]],
    [4, ["08:00", "12:00", "16:00", "20:00"], ["07:45", "11:45", "15:45", "19:45"]],
  ] as const)("suggests %i daily times with their default reminders", (count, times, reminders) => {
    const input = MedicineDraft.create(today).change({ name: "Daily medicine" }).frequency(count).commit();
    expect(input.doses.map((dose) => dose.alarmAt)).toEqual(times);
    expect(input.doses.map((dose) => dose.remindAt)).toEqual(reminders);
    expect(input.startsOn).toBe(today);
    expect(input.endsOn).toBeNull();
  });
  it("sets a dose's heads-up lead and keeps it when the dose moves, never before midnight", () => {
    const draft = MedicineDraft.create(today, custom).heads("morning", 15).time("morning", "alarmAt", "10:00");
    expect(draft.commit().doses[0]).toMatchObject({ alarmAt: "10:00", remindAt: "09:45" });
    expect(draft.time("morning", "alarmAt", "00:30").heads("morning", 60).commit().doses[0].remindAt).toBe("00:00");
  });
  it("adds a third custom dose with a thirty-minute reminder while preserving existing slots", () => {
    const input = MedicineDraft.create(today, custom).addTime().commit();
    expect(input.doses.slice(0, 2)).toEqual(custom.doses);
    expect(input.doses[2]).toMatchObject({ alarmAt: "08:00", remindAt: "07:30" });
  });
  it("keeps custom slots, leads, dates, and pause when only the name changes", () => {
    const draft = MedicineDraft.create(today, custom).change({ name: "Renamed" });
    expect(draft.commit()).toEqual({ ...custom, name: "Renamed" });
  });
  it("retains the existing evening dose when more suggested times are added", () => {
    const original = MedicineDraft.create(today).change({ name: "Routine" }).commit();
    const next = MedicineDraft.create(today, original).frequency(3).commit();
    expect(next.doses.find((slot) => slot.alarmAt === "20:00")?.id).toBe(original.doses[0].id);
    expect(new Set(next.doses.map((slot) => slot.id)).size).toBe(3);
  });
  it("keeps a custom reminder lead when moving a dose and rejects midnight or duplicate alarms", () => {
    const draft = MedicineDraft.create(today, custom).time("morning", "alarmAt", "07:00");
    expect(draft.commit().doses[0]).toEqual({ id: "morning", alarmAt: "07:00", remindAt: "06:30", amount: 1 });
    expect(() => draft.time("morning", "alarmAt", "00:00").commit()).toThrow("same day");
    expect(() => draft.time("morning", "alarmAt", "22:00").commit()).toThrow("different alarm time");
  });
  it("calculates the inclusive course end and retains invalid duration text for correction", () => {
    const draft = MedicineDraft.create(today).change({ name: "Course" }).withCourse({ kind: "days", days: "10" });
    expect(draft.commit().endsOn).toBe("2026-10-12");
    expect(draft.change({ startsOn: "2026-10-04" }).commit().endsOn).toBe("2026-10-13");
    const invalid = draft.withCourse({ kind: "days", days: "0" });
    expect(() => invalid.commit()).toThrow("whole number");
    expect(invalid.course).toEqual({ kind: "days", days: "0" });
  });
  it("keeps the confirmed snapshot when editing a dose's future time", () => {
    const model = new MedicineModel(createMergeableStore(), () => new Date(`${today}T12:00:00`));
    const medicine = model.add("medicine", MedicineDraft.create(today).change({ name: "Routine" }).commit());
    const dose = medicineOccurrences(medicine, today)[0];
    model.take(dose, "confirmation", `${today}T20:05:00Z`);
    model.edit(medicine.id, MedicineDraft.create(today, medicine).time(dose.slotId, "alarmAt", "21:00").commit());
    expect(model.getDose(dose.id)).toMatchObject({ scheduledAt: dose.scheduledAt, takenAt: `${today}T20:05:00Z` });
    expect(model.get(medicine.id)?.doses[0].alarmAt).toBe("21:00");
  });
  it("adds a valid final custom time when all twenty-three whole hours are occupied", () => {
    const input = { ...custom, doses: Array.from({ length: 23 }, (_, index) => ({ id: `slot-${index}`, alarmAt: `${String(index + 1).padStart(2, "0")}:00`, remindAt: `${String(index).padStart(2, "0")}:45`, amount: 1 })) };
    const next = MedicineDraft.create(today, input).addTime();
    expect(next.commit().doses).toHaveLength(24);
    expect(() => next.addTime()).toThrow("up to 24");
  });
  it("gives copied or re-added slots fresh identities and starts a fresh ongoing course", () => {
    const copied = MedicineDraft.create(today, custom, true).commit();
    expect(copied).toMatchObject({ startsOn: today, endsOn: null, paused: false });
    expect(copied.doses.map((dose) => dose.alarmAt)).toEqual(custom.doses.map((dose) => dose.alarmAt));
    expect(copied.doses.some((dose) => custom.doses.some((old) => old.id === dose.id))).toBe(false);
  });
  it("retries a failed local creation without duplicating or reviving a deleted routine", async () => {
    let failing = true;
    const replica = createTaskdoReplica({ store: createMergeableStore(), queryClient: new QueryClient(), queryKeyScope: ["draft-retry"], save: async () => { if (failing) throw new Error("Storage full"); } });
    const input = MedicineDraft.create(today).change({ name: "Routine" }).commit();
    await expect(replica.medicines.add(input, "draft")).rejects.toThrow("Storage full");
    const createdAt = replica.snapshot().medicines[0].createdAt;
    failing = false;
    await replica.medicines.add({ ...input, name: "Corrected" }, "draft");
    expect(replica.snapshot().medicines).toHaveLength(1);
    expect(replica.snapshot().medicines[0]).toMatchObject({ id: "draft", name: "Corrected", createdAt });
    await replica.medicines.remove("draft");
    await expect(replica.medicines.add(input, "draft")).rejects.toThrow("already exists");
    expect(replica.snapshot().medicines).toHaveLength(0);
    await replica.close();
  });
  it("starts daily and keeps chosen weekdays through edits and Add again", () => {
    expect(MedicineDraft.create(today).change({ name: "Routine" }).commit().weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(MedicineDraft.create(today, custom).commit().weekdays).toEqual([1, 3, 5]);
    expect(MedicineDraft.create(today, custom, true).commit().weekdays).toEqual([1, 3, 5]);
  });
  it("toggles weekdays in order and never removes the last one", () => {
    let draft = MedicineDraft.create(today).change({ name: "Routine" });
    for (const day of [7, 2, 4, 6] as const) draft = draft.toggleWeekday(day);
    expect(draft.commit().weekdays).toEqual([1, 3, 5]);
    expect(draft.changed).toBe(true);
    expect(draft.toggleWeekday(2).commit().weekdays).toEqual([1, 2, 3, 5]);
    let single = draft.toggleWeekday(1).toggleWeekday(3);
    expect(single.commit().weekdays).toEqual([5]);
    single = single.toggleWeekday(5);
    expect(single.commit().weekdays).toEqual([5]);
  });
});
