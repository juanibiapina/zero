import { createMergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";
import { MedicineModel, medicineOccurrences, medicineState, type MedicineInput } from "./model";
import { medicineSchedule } from "./notifications";

const supplement: MedicineInput = { name: "Magnesium", instructions: null, startsOn: "2026-10-01", endsOn: null, paused: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [
    { id: "morning", remindAt: "07:45", alarmAt: "08:00", amount: 1 },
    { id: "evening", remindAt: "19:45", alarmAt: "20:00", amount: 1 },
  ] };

function setup(input: MedicineInput = supplement, pillsLeft = 10) {
  const clock = { at: "2026-10-01T07:00:00" };
  const model = new MedicineModel(createMergeableStore(), () => new Date(clock.at));
  model.add("m", input, pillsLeft);
  return { clock, model };
}

describe("Pausing a medicine", () => {
  it("stops its doses and reminders and keeps its pills until it resumes", () => {
    const { model } = setup();
    model.setPaused("m", true);
    const paused = model.get("m")!;
    expect(medicineState(paused, "2026-10-01")).toBe("paused");
    expect(medicineOccurrences(paused, "2026-10-01")).toEqual([]);
    expect(medicineSchedule(model.snapshot()).reminders).toEqual([]);
    expect(paused.supply?.pillsLeft).toBe(10);
    model.setPaused("m", false);
    expect(medicineState(model.get("m")!, "2026-10-01")).toBe("active");
    expect(medicineSchedule(model.snapshot()).reminders).toHaveLength(2);
  });

  it("keeps a course that runs until the pills run out paused, and counts its last day from the resume day", () => {
    const { clock, model } = setup({ ...supplement, untilEmpty: true });
    expect(model.get("m")?.endsOn).toBe("2026-10-05");
    model.setPaused("m", true);
    clock.at = "2026-10-08T07:00:00";
    expect(medicineState(model.get("m")!, "2026-10-08")).toBe("paused");
    model.setPaused("m", false);
    expect(model.get("m")?.endsOn).toBe("2026-10-12");
    expect(medicineState(model.get("m")!, "2026-10-08")).toBe("active");
  });

  it("still ends a paused course on its fixed last day", () => {
    const { model } = setup({ ...supplement, endsOn: "2026-10-03" });
    model.setPaused("m", true);
    expect(medicineState(model.get("m")!, "2026-10-04")).toBe("ended");
  });

  it("refuses a medicine taken as needed", () => {
    const { model } = setup({ ...supplement, asNeeded: true, doses: [] });
    expect(() => model.setPaused("m", true)).toThrow("A medicine taken as needed has no schedule to pause");
  });
});
