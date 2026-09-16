import { describe, expect, it } from "vitest";

import { advance, parseSchedule, type Recurrence } from "./index";

const monthlyOn31: Recurrence = {
  version: 1,
  origin: "2027-01-31",
  anchor: "scheduled",
  weekStartsOn: "MO",
  pattern: {
    unit: "month",
    interval: 1,
    on: [{ kind: "day", day: 31 }],
  },
};

describe("advance", () => {
  it("clamps an invalid month day and returns to the anchor", () => {
    expect(
      advance(monthlyOn31, {
        scheduledOn: "2027-01-31",
        completedOn: "2027-02-10",
      }),
    ).toEqual({ kind: "next", scheduledOn: "2027-02-28" });

    expect(
      advance(monthlyOn31, {
        scheduledOn: "2027-02-28",
        completedOn: "2027-03-02",
      }),
    ).toEqual({ kind: "next", scheduledOn: "2027-03-31" });
  });

  it("re-anchors completed recurrence to the completion date", () => {
    const recurrence: Recurrence = {
      version: 1,
      origin: "2027-01-01",
      anchor: "completed",
      weekStartsOn: "MO",
      pattern: { unit: "day", interval: 3 },
    };

    expect(
      advance(recurrence, {
        scheduledOn: "2027-01-01",
        completedOn: "2027-01-15",
      }),
    ).toEqual({ kind: "next", scheduledOn: "2027-01-18" });
  });

  it("finishes after the inclusive until occurrence", () => {
    expect(
      advance(
        { ...monthlyOn31, until: "2027-02-28" },
        { scheduledOn: "2027-02-28", completedOn: "2027-03-05" },
      ),
    ).toEqual({ kind: "finished" });
  });

  it("counts workdays without counting weekends", () => {
    const recurrence: Recurrence = {
      version: 1,
      origin: "2026-09-18",
      anchor: "scheduled",
      weekStartsOn: "MO",
      pattern: { unit: "workday", interval: 2 },
    };
    expect(
      advance(recurrence, {
        scheduledOn: "2026-09-18",
        completedOn: "2026-09-18",
      }),
    ).toEqual({ kind: "next", scheduledOn: "2026-09-22" });
  });

  it("finds ordinal weekdays in a month", () => {
    const recurrence: Recurrence = {
      version: 1,
      origin: "2026-09-15",
      anchor: "scheduled",
      weekStartsOn: "MO",
      pattern: {
        unit: "month",
        interval: 1,
        on: [{ kind: "weekday", ordinal: 3, weekday: "TU" }],
      },
    };
    expect(
      advance(recurrence, {
        scheduledOn: "2026-09-15",
        completedOn: "2026-09-15",
      }),
    ).toEqual({ kind: "next", scheduledOn: "2026-10-20" });
  });
});

describe("parseSchedule", () => {
  const context = { today: "2026-09-16" as const, weekStartsOn: "MO" as const };

  it("extracts a monthly recurrence from a complete title", () => {
    expect(parseSchedule("Pay rent every 1st", context)).toMatchObject({
      kind: "scheduled",
      remainingText: "Pay rent",
      schedule: {
        kind: "recurring",
        recurrence: {
          origin: "2026-10-01",
          anchor: "scheduled",
          pattern: {
            unit: "month",
            interval: 1,
            on: [{ kind: "day", day: 1 }],
          },
        },
      },
    });
  });

  it("extracts a one-time date and leaves time words in the title", () => {
    expect(parseSchedule("Call Ana tomorrow at 3pm", context)).toMatchObject({
      kind: "scheduled",
      remainingText: "Call Ana at 3pm",
      schedule: { kind: "once", date: "2026-09-17" },
      consumed: [{ text: "tomorrow" }],
    });
  });

  it("normalizes after syntax to completion anchoring", () => {
    expect(parseSchedule("Water plants after 3 days", context)).toMatchObject({
      kind: "scheduled",
      remainingText: "Water plants",
      schedule: {
        kind: "recurring",
        recurrence: {
          anchor: "completed",
          origin: "2026-09-16",
          pattern: { unit: "day", interval: 3 },
        },
      },
    });
  });

  it("parses multiple weekdays and an inclusive end", () => {
    expect(
      parseSchedule(
        "Train every Monday, Friday starting Sep 18 until Oct 2",
        context,
      ),
    ).toMatchObject({
      kind: "scheduled",
      remainingText: "Train",
      schedule: {
        kind: "recurring",
        recurrence: {
          origin: "2026-09-18",
          until: "2026-10-02",
          pattern: { unit: "week", weekdays: ["MO", "FR"] },
        },
      },
    });
  });

  it("parses multiple ordinal weekdays in named months", () => {
    expect(
      parseSchedule("Review every 1st wed jan, 3rd thu jul", context),
    ).toMatchObject({
      kind: "scheduled",
      remainingText: "Review",
      schedule: {
        kind: "recurring",
        recurrence: {
          pattern: {
            unit: "year",
            on: [
              { kind: "weekday", month: 1, ordinal: 1, weekday: "WE" },
              { kind: "weekday", month: 7, ordinal: 3, weekday: "TH" },
            ],
          },
        },
      },
    });
  });

  it("parses a weekday inside a relative future week as one date", () => {
    expect(
      parseSchedule("Plan review in two weeks on Tuesday", context),
    ).toMatchObject({
      kind: "scheduled",
      remainingText: "Plan review",
      schedule: { kind: "once", date: "2026-09-29" },
      consumed: [{ text: "in two weeks on Tuesday" }],
    });
  });

  it("does not reinterpret subdaily recurrence", () => {
    expect(parseSchedule("Take medicine every 12 hours", context)).toEqual({
      kind: "none",
    });
  });
});
