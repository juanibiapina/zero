import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { MedicineModel, type MedicineInput } from "./model";
import { medicineSchedule } from "./notifications";

const course: MedicineInput = { name: "Antibiotic", instructions: null, startsOn: "2026-10-01", endsOn: "2026-10-03", paused: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 1 }] };

function setup(at = "2026-10-05T09:00:00") {
  const clock = { at };
  const model = new MedicineModel(createMergeableStore(), () => new Date(clock.at));
  model.add("m", course);
  return { clock, model };
}

describe("Archiving a medicine", () => {
  it("archives an ended medicine and keeps its history", () => {
    const { model } = setup();
    model.take({ id: JSON.stringify(["m", "morning", "2026-10-03"]), medicineId: "m", slotId: "morning", on: "2026-10-03", scheduledAt: "2026-10-03T06:00:00.000Z", takenAt: null, skippedAt: null }, "a", "2026-10-03T06:01:00.000Z");
    model.archive("m");
    expect(model.get("m")?.archivedAt).toBe(new Date("2026-10-05T09:00:00").toISOString());
    expect(model.snapshot().doses.map((dose) => dose.on)).toEqual(["2026-10-03"]);
  });

  it("refuses a medicine that is still running", () => {
    const { model } = setup("2026-10-02T09:00:00");
    expect(() => model.archive("m")).toThrow("Only an ended medicine can be archived");
    expect(model.get("m")?.archivedAt).toBeNull();
  });

  it("unarchives back to an ended medicine", () => {
    const { model } = setup();
    model.archive("m");
    model.unarchive("m");
    expect(model.get("m")?.archivedAt).toBeNull();
  });

  it("stays archived when its details change", () => {
    const { model } = setup();
    model.archive("m");
    model.edit("m", { ...course, name: "Amoxicillin" });
    expect(model.get("m")?.name).toBe("Amoxicillin");
    expect(model.get("m")?.archivedAt).not.toBeNull();
  });

  it("has no reminders", () => {
    const { model } = setup();
    model.archive("m");
    expect(medicineSchedule(model.snapshot()).reminders).toEqual([]);
  });
});
