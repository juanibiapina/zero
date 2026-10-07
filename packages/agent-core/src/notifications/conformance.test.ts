import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextOccurrence, occursOn } from "./recurrence";
import { parseSchedule, type Recurrence, type ScheduleError } from "./schedule";

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`./conformance/${name}`, import.meta.url), "utf8")) as T;

type ParseCase = { name: string; input: unknown; expected: { ok: true } | { error: ScheduleError } };
type RecurrenceCase = {
  name: string;
  recurrence: Recurrence;
  occursOn: { date: string; expected: boolean }[];
  nextOccurrence: { from: string; expected: string | null }[];
};

describe("schedule conformance", () => {
  it.each(fixture<{ cases: ParseCase[] }>("schedule-parse.json").cases)("parses $name", ({ input, expected }) => {
    const result = parseSchedule(input);
    expect(result.ok ? { ok: true } : { error: result.error }).toEqual(expected);
  });

  it.each(fixture<{ cases: RecurrenceCase[] }>("recurrence.json").cases)("follows the recurrence: $name", ({ recurrence, occursOn: occurs, nextOccurrence: next }) => {
    expect(occurs.map(({ date }) => ({ date, expected: occursOn(recurrence, date) }))).toEqual(occurs);
    expect(next.map(({ from }) => ({ from, expected: nextOccurrence(recurrence, from) }))).toEqual(next);
  });
});
