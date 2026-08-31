import { describe, expect, it } from "vitest";

import { localToday, tomorrow, visibleCaptures } from "./dates";
import type { Capture } from "./types";

const cap = (
  id: string,
  showUpDate: string | null,
  createdAt = "2023-01-01T00:00:00.000Z",
  processedAt: string | null = null,
): Capture => ({ id, text: id, createdAt, processedAt, showUpDate });

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

  it("orders visible captures oldest first by createdAt", () => {
    const rows = visibleCaptures(
      [
        cap("late", null, "2023-02-01T00:00:00.000Z"),
        cap("early", null, "2023-01-01T00:00:00.000Z"),
      ],
      today,
    );
    expect(rows.map((c) => c.id)).toEqual(["early", "late"]);
  });
});
