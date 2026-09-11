import { describe, expect, it } from "vitest";

import {
  dayLabel,
  monthMatrix,
  parseLocalDay,
  scheduleLabel,
  tomorrow,
  weekdayShort,
} from "./dates";

describe("tomorrow", () => {
  it("advances one calendar day, across a month boundary", () => {
    expect(tomorrow("2024-01-31")).toBe("2024-02-01");
    expect(tomorrow("2024-02-28")).toBe("2024-02-29"); // leap year
    expect(tomorrow("2024-12-31")).toBe("2025-01-01");
  });
});

describe("parseLocalDay", () => {
  it("parses a YYYY-MM-DD from local parts (no UTC slip)", () => {
    const d = parseLocalDay("2024-03-05");
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(5);
  });
});

describe("scheduleLabel", () => {
  const today = "2024-01-10";
  it("reads Schedule when unscheduled, Today/Tomorrow, else a date", () => {
    expect(scheduleLabel(null, today)).toBe("Schedule");
    expect(scheduleLabel(undefined, today)).toBe("Schedule");
    expect(scheduleLabel("2024-01-10", today)).toBe("Today");
    expect(scheduleLabel("2024-01-05", today)).toBe("Today"); // overdue reads Today
    expect(scheduleLabel("2024-01-11", today)).toBe("Tomorrow");
    expect(scheduleLabel("2024-02-01", today)).toMatch(/Feb/);
  });
});

describe("weekdayShort", () => {
  it("returns a short weekday for a day", () => {
    // 2024-01-10 is a Wednesday.
    expect(weekdayShort("2024-01-10")).toMatch(/Wed/);
  });
});

describe("dayLabel", () => {
  const today = "2024-01-10";
  it("labels the next day Tomorrow, else a weekday + date", () => {
    expect(dayLabel("2024-01-11", today)).toBe("Tomorrow");
    expect(dayLabel("2024-01-15", today)).toMatch(/Jan/);
  });
});

describe("monthMatrix", () => {
  it("lays out six Monday-first weeks of seven days", () => {
    const weeks = monthMatrix(2024, 0); // January 2024
    expect(weeks).toHaveLength(6);
    for (const week of weeks) expect(week).toHaveLength(7);
    // Jan 1 2024 is a Monday, so the first cell is 2024-01-01.
    expect(weeks[0][0]).toBe("2024-01-01");
  });
});
