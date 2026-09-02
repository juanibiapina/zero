import { describe, expect, it } from "vitest";

import type { Capture } from "./types";
import { upcomingSections } from "./upcoming";

const cap = (
  id: string,
  showUpDate: string | null,
  createdAt = "2023-01-01T00:00:00.000Z",
  processedAt: string | null = null,
  sortKey: string | null = null,
): Capture => ({ id, text: id, createdAt, processedAt, showUpDate, sortKey });

describe("upcomingSections", () => {
  const today = "2024-03-09";

  it("returns an empty array when there are no future-dated captures", () => {
    const list = [cap("undated", null), cap("todayItem", today), cap("past", "2024-03-01")];
    expect(upcomingSections(list, today)).toEqual([]);
  });

  it("excludes undated, already-shown (<= today) and processed captures", () => {
    const list = [
      cap("undated", null),
      cap("todayItem", today),
      cap("past", "2024-03-01"),
      cap("processedFuture", "2024-03-20", "2023-01-01T00:00:00.000Z", "2024-03-08T00:00:00.000Z"),
      cap("future", "2024-03-10"),
    ];
    const sections = upcomingSections(list, today);
    expect(sections).toHaveLength(1);
    expect(sections[0].date).toBe("2024-03-10");
    expect(sections[0].captures.map((c) => c.id)).toEqual(["future"]);
  });

  it("emits one section per distinct future day, date-ascending", () => {
    const list = [
      cap("d12", "2024-03-12"),
      cap("d10", "2024-03-10"),
      cap("d11", "2024-03-11"),
    ];
    const sections = upcomingSections(list, today);
    expect(sections.map((s) => s.date)).toEqual([
      "2024-03-10",
      "2024-03-11",
      "2024-03-12",
    ]);
    expect(sections.map((s) => s.captures.map((c) => c.id))).toEqual([
      ["d10"],
      ["d11"],
      ["d12"],
    ]);
  });

  it("orders captures within a day by sortKey asc, null last, createdAt tiebreak", () => {
    const day = "2024-03-10";
    const list = [
      cap("late", day, "2023-03-01T00:00:00.000Z", null, null),
      cap("keyedB", day, "2023-01-01T00:00:00.000Z", null, "a1"),
      cap("keyedA", day, "2023-01-01T00:00:00.000Z", null, "a0"),
    ];
    const sections = upcomingSections(list, today);
    expect(sections).toHaveLength(1);
    expect(sections[0].captures.map((c) => c.id)).toEqual(["keyedA", "keyedB", "late"]);
  });
});
