import { describe, expect, it } from "vitest";

import { localToday, tomorrow, visibleCaptures } from "./dates";
import type { Capture } from "./types";

const cap = (
  id: string,
  showUpDate: string | null,
  createdAt = "2023-01-01T00:00:00.000Z",
  processedAt: string | null = null,
  sortKey: string | null = null,
): Capture => ({ id, text: id, createdAt, processedAt, showUpDate, sortKey });

describe("localToday", () => {
  it("formats a fixed date as YYYY-MM-DD in device local time", () => {
    // Local components, so build the Date from local parts to avoid a UTC skew.
    const now = new Date(2024, 2, 9, 15, 30); // 2024-03-09 15:30 local
    expect(localToday(now)).toBe("2024-03-09");
  });

  it("zero-pads month and day", () => {
    expect(localToday(new Date(2024, 0, 5))).toBe("2024-01-05");
  });
});

describe("tomorrow", () => {
  it("advances a normal day", () => {
    expect(tomorrow("2024-03-09")).toBe("2024-03-10");
  });

  it("rolls over a month boundary", () => {
    expect(tomorrow("2024-01-31")).toBe("2024-02-01");
  });

  it("rolls over a year boundary", () => {
    expect(tomorrow("2024-12-31")).toBe("2025-01-01");
  });

  it("handles a leap day", () => {
    expect(tomorrow("2024-02-28")).toBe("2024-02-29");
    expect(tomorrow("2024-02-29")).toBe("2024-03-01");
  });

  it("does not skip a day across a spring-forward DST date", () => {
    // 2024-03-10 is a US DST spring-forward day; noon-UTC parsing avoids a
    // same-date result.
    expect(tomorrow("2024-03-10")).toBe("2024-03-11");
  });
});

describe("visibleCaptures", () => {
  const today = "2024-03-09";

  it("always shows a null-date capture", () => {
    const rows = visibleCaptures([cap("a", null)], today);
    expect(rows.map((c) => c.id)).toEqual(["a"]);
  });

  it("shows a capture whose showUpDate field is missing (undefined)", () => {
    // A row from a server that predates showUpDate arrives without the field.
    // It must be treated as always-visible, not hidden.
    const legacy = {
      id: "a",
      text: "a",
      createdAt: "2023-01-01T00:00:00.000Z",
      processedAt: null,
    } as unknown as Capture;
    expect(visibleCaptures([legacy], today).map((c) => c.id)).toEqual(["a"]);
  });

  it("shows a capture whose show-up date is today", () => {
    expect(visibleCaptures([cap("a", today)], today).map((c) => c.id)).toEqual(["a"]);
  });

  it("rolls an overdue (past) capture into today", () => {
    expect(visibleCaptures([cap("a", "2020-01-01")], today).map((c) => c.id)).toEqual(["a"]);
  });

  it("hides a future-dated capture", () => {
    expect(visibleCaptures([cap("a", "2099-01-01")], today)).toEqual([]);
  });

  it("hides a processed capture even when its date has arrived", () => {
    const processed = cap("a", null, "2023-01-01T00:00:00.000Z", "2023-01-02T00:00:00.000Z");
    expect(visibleCaptures([processed], today)).toEqual([]);
  });

  it("orders visible captures oldest first by createdAt when sortKey is absent", () => {
    const rows = visibleCaptures(
      [
        cap("late", null, "2023-02-01T00:00:00.000Z"),
        cap("early", null, "2023-01-01T00:00:00.000Z"),
      ],
      today,
    );
    expect(rows.map((c) => c.id)).toEqual(["early", "late"]);
  });

  it("orders by sortKey ascending ahead of createdAt", () => {
    const rows = visibleCaptures(
      [
        // Newer createdAt but a smaller sortKey → comes first.
        cap("b", null, "2023-02-01T00:00:00.000Z", null, "a0"),
        cap("a", null, "2023-01-01T00:00:00.000Z", null, "a1"),
      ],
      today,
    );
    expect(rows.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("sorts a null sortKey last (newest-at-bottom)", () => {
    const rows = visibleCaptures(
      [
        cap("new", null, "2023-03-01T00:00:00.000Z", null, null),
        cap("keyed", null, "2023-01-01T00:00:00.000Z", null, "a0"),
      ],
      today,
    );
    expect(rows.map((c) => c.id)).toEqual(["keyed", "new"]);
  });

  it("compares sortKey by codepoint, not case-folded (uppercase before lowercase)", () => {
    const rows = visibleCaptures(
      [
        cap("lower", null, "2023-01-01T00:00:00.000Z", null, "a"),
        cap("upper", null, "2023-01-01T00:00:00.000Z", null, "Z"),
      ],
      today,
    );
    // ASCII 'Z' (90) < 'a' (97); localeCompare would fold and flip this.
    expect(rows.map((c) => c.id)).toEqual(["upper", "lower"]);
  });
});
