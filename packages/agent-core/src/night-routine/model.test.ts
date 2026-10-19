import { createMergeableStore, type MergeableStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { NightRoutineModel, nightOf, nightView, readNights } from "./model";

function setup(at = "2026-10-19T20:00:00", store: MergeableStore = createMergeableStore()) {
  const clock = { at };
  let next = 0;
  const model = new NightRoutineModel(store, () => new Date(clock.at), () => `s${++next}`);
  const view = () => nightView(readNights(store), new Date(clock.at));
  return { store, clock, model, view };
}

const texts = (steps: { text: string }[]) => steps.map((step) => step.text);

describe("Which night a moment belongs to", () => {
  it("counts the evening and the small hours as one night, and starts the next at 08:00", () => {
    expect(nightOf(new Date("2026-10-19T20:00:00"))).toBe("2026-10-19");
    expect(nightOf(new Date("2026-10-19T23:50:00"))).toBe("2026-10-19");
    expect(nightOf(new Date("2026-10-20T00:30:00"))).toBe("2026-10-19");
    expect(nightOf(new Date("2026-10-20T07:59:00"))).toBe("2026-10-19");
    expect(nightOf(new Date("2026-10-20T08:00:00"))).toBe("2026-10-20");
  });
});

describe("The night routine", () => {
  it("starts empty, opening at 21:00", () => {
    const { view } = setup();
    expect(view()).toMatchObject({ night: "2026-10-19", state: "open", steps: [], opensAt: "21:00", showIcon: false });
  });

  it("adds steps to the end of tonight's list", () => {
    const { model, view } = setup();
    model.addStep("Wechseldusche on legs");
    model.addStep("  Meditate ");
    expect(texts(view().open)).toEqual(["Wechseldusche on legs", "Meditate"]);
    expect(() => model.addStep("   ")).toThrow();
  });

  it("hides a completed step until Undo", () => {
    const { model, view } = setup();
    const shower = model.addStep("Shower");
    model.addStep("Meditate");
    model.complete(shower.id);
    expect(texts(view().open)).toEqual(["Meditate"]);
    expect(view().done).toEqual([{ id: shower.id, text: "Shower", doneAt: new Date("2026-10-19T20:00:00").toISOString() }]);
    model.uncomplete(shower.id);
    expect(texts(view().open)).toEqual(["Shower", "Meditate"]);
  });

  it("counts a step done after midnight for the night before", () => {
    const { model, view, clock } = setup();
    const shower = model.addStep("Shower");
    clock.at = "2026-10-20T00:30:00";
    model.complete(shower.id);
    expect(view()).toMatchObject({ night: "2026-10-19", open: [] });
  });

  it("copies tonight's list to the next night with every step open, without changing the past", () => {
    const { model, view, clock, store } = setup();
    const shower = model.addStep("Shower");
    model.addStep("Meditate");
    model.complete(shower.id);
    clock.at = "2026-10-20T21:00:00";
    expect(view()).toMatchObject({ night: "2026-10-20", state: "open", done: [] });
    expect(texts(view().open)).toEqual(["Shower", "Meditate"]);
    expect(store.hasRow("nights", "2026-10-20")).toBe(false);

    model.removeStep(shower.id);
    expect(texts(view().open)).toEqual(["Meditate"]);
    const before = view().history.find((night) => night.night === "2026-10-19")!;
    expect(before.steps.map((step) => [step.text, step.doneAt != null])).toEqual([["Shower", true], ["Meditate", false]]);
  });

  it("renames and moves steps tonight and on later nights", () => {
    const { model, view, clock } = setup();
    const a = model.addStep("A");
    const b = model.addStep("B");
    const c = model.addStep("C");
    model.renameStep(b.id, "Bee");
    model.moveStep(c.id, 0);
    expect(texts(view().open)).toEqual(["C", "A", "Bee"]);
    model.complete(a.id);
    model.moveStep(c.id, 1);
    expect(texts(view().steps)).toEqual(["A", "Bee", "C"]);
    clock.at = "2026-10-20T20:00:00";
    expect(texts(view().open)).toEqual(["A", "Bee", "C"]);
  });

  it("shows the icon from the opening time until the night closes", () => {
    const { model, view, clock } = setup("2026-10-19T20:59:00");
    expect(view().showIcon).toBe(false);
    model.addStep("Shower");
    expect(view().showIcon).toBe(false);
    clock.at = "2026-10-19T21:00:00";
    expect(view().showIcon).toBe(true);
    clock.at = "2026-10-20T01:00:00";
    expect(view().showIcon).toBe(true);
    clock.at = "2026-10-20T08:00:00";
    expect(view().showIcon).toBe(false);
  });

  it("follows a changed opening time, tonight and later", () => {
    const { model, view, clock } = setup("2026-10-19T21:30:00");
    model.addStep("Shower");
    model.setOpensAt("22:00");
    expect(view()).toMatchObject({ opensAt: "22:00", showIcon: false });
    clock.at = "2026-10-20T22:00:00";
    expect(view()).toMatchObject({ opensAt: "22:00", showIcon: true });
    expect(() => model.setOpensAt("07:30")).toThrow();
  });

  it("points the next change at the opening time, then at 08:00", () => {
    const { model, view, clock } = setup("2026-10-19T07:00:00");
    model.setOpensAt("21:00");
    expect(view().nextChange).toEqual(new Date("2026-10-19T08:00:00"));
    clock.at = "2026-10-19T12:00:00";
    expect(view().nextChange).toEqual(new Date("2026-10-19T21:00:00"));
    clock.at = "2026-10-19T23:00:00";
    expect(view().nextChange).toEqual(new Date("2026-10-20T08:00:00"));
  });

  it("closes the night on Going to bed, leaving undone steps undone", () => {
    const { model, view, clock } = setup("2026-10-19T22:00:00");
    const shower = model.addStep("Shower");
    const meditate = model.addStep("Meditate");
    model.complete(meditate.id);
    clock.at = "2026-10-19T23:42:00";
    expect(model.goToBed()).toBe("2026-10-19");
    expect(view()).toMatchObject({ state: "closed", showIcon: false, wentToBedAt: new Date("2026-10-19T23:42:00").toISOString() });
    expect(texts(view().open)).toEqual(["Shower"]);
    expect(() => model.complete(shower.id)).toThrow();
    expect(() => model.addStep("Read")).toThrow();
    expect(() => model.setOpensAt("22:00")).toThrow();

    model.undoBed("2026-10-19");
    expect(view().state).toBe("open");
    model.complete(shower.id);
    expect(view().open).toEqual([]);
  });

  it("closes a forgotten night at 08:00 without a bedtime", () => {
    const { model, view, clock } = setup("2026-10-19T22:00:00");
    const shower = model.addStep("Shower");
    model.complete(shower.id);
    clock.at = "2026-10-20T08:00:00";
    expect(view()).toMatchObject({ night: "2026-10-20", state: "open", wentToBedAt: null });
    expect(texts(view().open)).toEqual(["Shower"]);
    expect(view().history[0]).toMatchObject({ night: "2026-10-19", wentToBedAt: null });
  });

  it("counts done nights per step since the step appeared, up to seven", () => {
    const { model, view, clock } = setup("2026-10-10T22:00:00");
    const shower = model.addStep("Shower");
    for (const day of ["10", "11", "13"]) {
      clock.at = `2026-10-${day}T22:00:00`;
      model.complete(shower.id);
    }
    clock.at = "2026-10-13T23:00:00";
    const meditate = model.addStep("Meditate");
    model.renameStep(shower.id, "Leg shower");
    expect(view().counts[shower.id]).toEqual({ done: 3, nights: 4 });
    expect(view().counts[meditate.id]).toEqual({ done: 0, nights: 1 });
    clock.at = "2026-10-19T22:00:00";
    expect(view().counts[shower.id]).toEqual({ done: 1, nights: 7 });
  });

  it("keeps marks made offline on two devices for the same night", () => {
    const phone = setup("2026-10-19T21:00:00", createMergeableStore("phone"));
    const shower = phone.model.addStep("Shower");
    const meditate = phone.model.addStep("Meditate");
    const tablet = setup("2026-10-19T21:00:00", createMergeableStore("tablet"));
    tablet.store.merge(phone.store);
    phone.model.complete(shower.id);
    tablet.clock.at = "2026-10-19T21:05:00";
    tablet.model.complete(meditate.id);
    phone.store.merge(tablet.store);
    expect(phone.view().open).toEqual([]);
  });

  it("skips an unreadable night when copying forward", () => {
    const { model, view, clock, store } = setup("2026-10-18T22:00:00");
    model.addStep("Shower");
    store.setRow("nights", "2026-10-19", { steps: "not json" });
    clock.at = "2026-10-20T22:00:00";
    expect(texts(view().open)).toEqual(["Shower"]);
    expect(view().history.map((night) => night.night)).toEqual(["2026-10-18"]);
  });
});
