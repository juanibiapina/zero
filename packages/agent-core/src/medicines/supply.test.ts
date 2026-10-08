import { describe, expect, it } from "vitest";
import type { Medicine } from "./model";
import { daysLeft, restockThreshold, supplyIsLow, supplyLabel } from "./supply";

const medicine = (over: Partial<Medicine> = {}, pillsLeft: number | null = 60, leadDays = 14): Medicine => ({
  id: "m", name: "Pill", instructions: null, startsOn: "2026-10-01", endsOn: null, paused: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7], doses: [{ id: "evening", remindAt: "19:00", alarmAt: "20:00", amount: 2 }],
  createdAt: "2026-10-01T00:00:00Z", supply: pillsLeft === null ? null : { pillsLeft, leadDays, refill: null }, ...over,
});

describe("Medicine supply", () => {
  it("needs the pills the schedule uses in the lead days", () => {
    expect(restockThreshold(medicine(), 14)).toBe(28);
    expect(restockThreshold(medicine({ doses: [
      { id: "a", remindAt: "07:00", alarmAt: "08:00", amount: 2 },
      { id: "b", remindAt: "19:00", alarmAt: "20:00", amount: 1 },
    ] }), 10)).toBe(30);
    expect(restockThreshold(medicine({ weekdays: [1, 3, 5] }), 14)).toBe(12);
    expect(restockThreshold(medicine({ weekdays: [1, 3, 5] }), 3)).toBe(3);
    expect(restockThreshold(medicine(), 0)).toBe(0);
  });

  it("is low at or below the threshold", () => {
    expect(supplyIsLow(medicine({}, 29), "2026-10-16")).toBe(false);
    expect(supplyIsLow(medicine({}, 28), "2026-10-16")).toBe(true);
    expect(supplyIsLow(medicine({}, 0), "2026-10-16")).toBe(true);
    expect(supplyIsLow(medicine({}, 0, 0), "2026-10-16")).toBe(true);
    expect(supplyIsLow(medicine({}, null), "2026-10-16")).toBe(false);
  });

  it("is never low while paused, after the course, or when the course needs no more pills", () => {
    expect(supplyIsLow(medicine({ paused: true }, 4), "2026-10-16")).toBe(false);
    expect(supplyIsLow(medicine({ endsOn: "2026-10-10" }, 4), "2026-10-16")).toBe(false);
    expect(supplyIsLow(medicine({ endsOn: "2026-10-18" }, 6), "2026-10-16")).toBe(false);
    expect(supplyIsLow(medicine({ endsOn: "2026-10-18" }, 5), "2026-10-16")).toBe(true);
  });

  it("says about how many days the pills last", () => {
    expect(daysLeft(medicine())).toBe(30);
    expect(daysLeft(medicine({ weekdays: [1, 3, 5] }, 24))).toBe(28);
    expect(daysLeft(medicine({}, 0))).toBe(0);
    expect(daysLeft(medicine({ paused: true }))).toBeNull();
    expect(daysLeft(medicine({ doses: [{ id: "a", remindAt: "07:00", alarmAt: "08:00", amount: 200 }] }, 1000))).toBe(5);
    expect(supplyLabel(medicine())).toBe("60 pills left · about 30 days");
    expect(supplyLabel(medicine({ paused: true }, 1))).toBe("1 pill left");
    expect(supplyLabel(medicine({}, null))).toBeNull();
  });
});
