import { describe, expect, it } from "vitest";

import {
  advance,
  parseSchedule,
  type Pattern,
  type Recurrence,
} from "./index";

const context = { today: "2026-09-16", weekStartsOn: "MO" as const };

function parsedRecurrence(phrase: string): Recurrence {
  const result = parseSchedule(`Task ${phrase}`, context);
  expect(result.kind).toBe("scheduled");
  if (result.kind !== "scheduled") throw new Error(`did not parse ${phrase}`);
  expect(result.remainingText).toBe("Task");
  expect(result.consumed.map((match) => match.text).join(" ")).toBe(phrase);
  expect(result.schedule.kind).toBe("recurring");
  if (result.schedule.kind !== "recurring") {
    throw new Error(`did not recur ${phrase}`);
  }
  return result.schedule.recurrence;
}

type ParserCase = {
  phrase: string;
  anchor?: Recurrence["anchor"];
  origin?: string;
  until?: string;
  pattern: Pattern;
};

const todoistCases: ParserCase[] = [
  { phrase: "every day", pattern: { unit: "day", interval: 1 } },
  { phrase: "daily", pattern: { unit: "day", interval: 1 } },
  {
    phrase: "every weekday",
    pattern: {
      unit: "week",
      interval: 1,
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
    },
  },
  {
    phrase: "every workday",
    pattern: { unit: "workday", interval: 1 },
  },
  {
    phrase: "every week",
    pattern: { unit: "week", interval: 1, weekdays: ["WE"] },
  },
  {
    phrase: "every month",
    pattern: {
      unit: "month",
      interval: 1,
      on: [{ kind: "day", day: 16 }],
    },
  },
  {
    phrase: "every year",
    pattern: {
      unit: "year",
      interval: 1,
      on: [{ kind: "date", month: 9, day: 16 }],
    },
  },
  {
    phrase: "every Monday, Friday",
    origin: "2026-09-18",
    pattern: { unit: "week", interval: 1, weekdays: ["MO", "FR"] },
  },
  {
    phrase: "every 2, 15, 27",
    origin: "2026-09-27",
    pattern: {
      unit: "month",
      interval: 1,
      on: [
        { kind: "day", day: 2 },
        { kind: "day", day: 15 },
        { kind: "day", day: 27 },
      ],
    },
  },
  {
    phrase: "every 14 jan, 14 apr, 15 jun, 15 sep",
    origin: "2027-01-14",
    pattern: {
      unit: "year",
      interval: 1,
      on: [
        { kind: "date", month: 1, day: 14 },
        { kind: "date", month: 4, day: 14 },
        { kind: "date", month: 6, day: 15 },
        { kind: "date", month: 9, day: 15 },
      ],
    },
  },
  {
    phrase: "every 15th workday, first workday, last workday",
    origin: "2026-09-21",
    pattern: {
      unit: "month",
      interval: 1,
      on: [
        { kind: "workday", ordinal: 15 },
        { kind: "workday", ordinal: 1 },
        { kind: "workday", ordinal: "last" },
      ],
    },
  },
  {
    phrase: "every 1st wed jan, 3rd thu jul",
    origin: "2027-01-06",
    pattern: {
      unit: "year",
      interval: 1,
      on: [
        { kind: "weekday", month: 1, ordinal: 1, weekday: "WE" },
        { kind: "weekday", month: 7, ordinal: 3, weekday: "TH" },
      ],
    },
  },
  {
    phrase: "every 3 workday",
    pattern: { unit: "workday", interval: 3 },
  },
  {
    phrase: "quarterly",
    pattern: {
      unit: "month",
      interval: 3,
      on: [{ kind: "day", day: 16 }],
    },
  },
  {
    phrase: "every! 2 months",
    anchor: "completed",
    pattern: {
      unit: "month",
      interval: 2,
      on: [{ kind: "day", day: 16 }],
    },
  },
  {
    phrase: "after 10 days",
    anchor: "completed",
    pattern: { unit: "day", interval: 10 },
  },
  { phrase: "every other day", pattern: { unit: "day", interval: 2 } },
  {
    phrase: "every other week",
    pattern: { unit: "week", interval: 2, weekdays: ["WE"] },
  },
  {
    phrase: "every other month",
    pattern: {
      unit: "month",
      interval: 2,
      on: [{ kind: "day", day: 16 }],
    },
  },
  {
    phrase: "every other year",
    pattern: {
      unit: "year",
      interval: 2,
      on: [{ kind: "date", month: 9, day: 16 }],
    },
  },
  {
    phrase: "every other fri",
    origin: "2026-09-25",
    pattern: { unit: "week", interval: 2, weekdays: ["FR"] },
  },
  {
    phrase: "every week on Saturday",
    origin: "2026-09-19",
    pattern: { unit: "week", interval: 1, weekdays: ["SA"] },
  },
  {
    phrase: "every 2 weeks on Thursday",
    origin: "2026-09-17",
    pattern: { unit: "week", interval: 2, weekdays: ["TH"] },
  },
  {
    phrase: "First Tuesday of every month",
    origin: "2026-10-06",
    pattern: {
      unit: "month",
      interval: 1,
      on: [{ kind: "weekday", ordinal: 1, weekday: "TU" }],
    },
  },
  {
    phrase: "every last day",
    origin: "2026-09-30",
    pattern: {
      unit: "month",
      interval: 1,
      on: [{ kind: "day", day: "last" }],
    },
  },
  {
    phrase: "every day starting Sep 20 until Sep 23",
    origin: "2026-09-20",
    until: "2026-09-23",
    pattern: { unit: "day", interval: 1 },
  },
  {
    phrase: "every day for 3 weeks",
    until: "2026-10-07",
    pattern: { unit: "day", interval: 1 },
  },
];

describe("Todoist date-level grammar compatibility", () => {
  for (const fixture of todoistCases) {
    it(fixture.phrase, () => {
      const recurrence = parsedRecurrence(fixture.phrase);
      expect(recurrence.anchor).toBe(fixture.anchor ?? "scheduled");
      expect(recurrence.origin).toBe(fixture.origin ?? "2026-09-16");
      expect(recurrence.until).toBe(fixture.until);
      expect(recurrence.pattern).toEqual(fixture.pattern);
    });
  }
});

function monthly(
  origin: string,
  interval = 1,
  day: number | "last" = Number(origin.slice(8, 10)),
): Recurrence {
  return {
    version: 1,
    origin,
    anchor: "scheduled",
    weekStartsOn: "MO",
    pattern: { unit: "month", interval, on: [{ kind: "day", day }] },
  };
}

const taskEngineCases: Array<{
  name: string;
  recurrence: Recurrence;
  scheduledOn: string;
  completedOn?: string;
  expected: string;
}> = [
  {
    name: "monthly interval",
    recurrence: monthly("2016-08-28", 3, 28),
    scheduledOn: "2016-08-28",
    expected: "2016-11-28",
  },
  {
    name: "January 31 clamps into non-leap February",
    recurrence: monthly("2017-01-31", 1, 31),
    scheduledOn: "2017-01-31",
    expected: "2017-02-28",
  },
  {
    name: "explicit day returns after a clamp",
    recurrence: monthly("2017-01-31", 1, 31),
    scheduledOn: "2017-02-28",
    expected: "2017-03-31",
  },
  {
    name: "six-month day 30 clamps into February",
    recurrence: monthly("2026-08-30", 6, 30),
    scheduledOn: "2026-08-30",
    expected: "2027-02-28",
  },
  {
    name: "six-month day 30 returns after February",
    recurrence: monthly("2026-08-30", 6, 30),
    scheduledOn: "2027-02-28",
    expected: "2027-08-30",
  },
  {
    name: "February 29 remains in a leap year",
    recurrence: monthly("2027-08-29", 6, 29),
    scheduledOn: "2027-08-29",
    expected: "2028-02-29",
  },
  {
    name: "last day tracks each month end",
    recurrence: monthly("2017-11-30", 1, "last"),
    scheduledOn: "2017-11-30",
    expected: "2017-12-31",
  },
];

describe("rrule-temporal selector compatibility", () => {
  const base = {
    version: 1 as const,
    anchor: "scheduled" as const,
    weekStartsOn: "MO" as const,
  };

  const cases: Array<{
    name: string;
    recurrence: Recurrence;
    scheduledOn: string;
    expected: string;
  }> = [
    {
      name: "multiple weekdays stay inside the current week",
      recurrence: {
        ...base,
        origin: "2026-09-14",
        pattern: { unit: "week", interval: 1, weekdays: ["MO", "FR"] },
      },
      scheduledOn: "2026-09-14",
      expected: "2026-09-18",
    },
    {
      name: "multiple weekdays continue into the next week",
      recurrence: {
        ...base,
        origin: "2026-09-14",
        pattern: { unit: "week", interval: 1, weekdays: ["MO", "FR"] },
      },
      scheduledOn: "2026-09-18",
      expected: "2026-09-21",
    },
    {
      name: "biweekly phase follows origin",
      recurrence: {
        ...base,
        origin: "2026-09-18",
        pattern: { unit: "week", interval: 2, weekdays: ["FR"] },
      },
      scheduledOn: "2026-09-18",
      expected: "2026-10-02",
    },
    {
      name: "monthly third Tuesday",
      recurrence: {
        ...base,
        origin: "2026-09-15",
        pattern: {
          unit: "month",
          interval: 1,
          on: [{ kind: "weekday", ordinal: 3, weekday: "TU" }],
        },
      },
      scheduledOn: "2026-09-15",
      expected: "2026-10-20",
    },
    {
      name: "yearly ordinal weekday",
      recurrence: {
        ...base,
        origin: "2026-07-16",
        pattern: {
          unit: "year",
          interval: 1,
          on: [{ kind: "weekday", month: 7, ordinal: 3, weekday: "TH" }],
        },
      },
      scheduledOn: "2026-07-16",
      expected: "2027-07-15",
    },
    {
      name: "yearly February 29 clamps in a non-leap year",
      recurrence: {
        ...base,
        origin: "2028-02-29",
        pattern: {
          unit: "year",
          interval: 1,
          on: [{ kind: "date", month: 2, day: 29 }],
        },
      },
      scheduledOn: "2028-02-29",
      expected: "2029-02-28",
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      expect(
        advance(fixture.recurrence, {
          scheduledOn: fixture.scheduledOn,
          completedOn: fixture.scheduledOn,
        }),
      ).toEqual({ kind: "next", scheduledOn: fixture.expected });
    });
  }
});

describe("tasks.org calendar compatibility", () => {
  for (const fixture of taskEngineCases) {
    it(fixture.name, () => {
      expect(
        advance(fixture.recurrence, {
          scheduledOn: fixture.scheduledOn,
          completedOn: fixture.completedOn ?? fixture.scheduledOn,
        }),
      ).toEqual({ kind: "next", scheduledOn: fixture.expected });
    });
  }

  it("completion anchor uses completion day before due date", () => {
    expect(
      advance(
        { ...monthly("2016-08-30"), anchor: "completed" },
        { scheduledOn: "2016-08-30", completedOn: "2016-08-29" },
      ),
    ).toEqual({ kind: "next", scheduledOn: "2016-09-29" });
  });

  it("completion anchor uses completion day after due date", () => {
    expect(
      advance(
        { ...monthly("2016-08-28"), anchor: "completed" },
        { scheduledOn: "2016-08-28", completedOn: "2016-08-29" },
      ),
    ).toEqual({ kind: "next", scheduledOn: "2016-09-29" });
  });

  it("inclusive until keeps its final clamped occurrence", () => {
    expect(
      advance(
        { ...monthly("2026-01-30", 1, 30), until: "2026-02-28" },
        { scheduledOn: "2026-01-30", completedOn: "2026-01-30" },
      ),
    ).toEqual({ kind: "next", scheduledOn: "2026-02-28" });
  });

  it("until finishes before a later clamped occurrence", () => {
    expect(
      advance(
        { ...monthly("2026-01-30", 1, 30), until: "2026-02-15" },
        { scheduledOn: "2026-01-30", completedOn: "2026-01-30" },
      ),
    ).toEqual({ kind: "finished" });
  });
});
