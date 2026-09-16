import * as chrono from "chrono-node/en";
import { RRuleTemporal } from "rrule-temporal";
import { Temporal } from "temporal-polyfill";

export type PlainDate = string;
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type WeekStart = "MO" | "SU";

export type MonthSelector =
  | { kind: "day"; day: number | "last" }
  | { kind: "weekday"; ordinal: number | "last"; weekday: Weekday }
  | { kind: "workday"; ordinal: number | "last" };

export type YearSelector =
  | { kind: "date"; month: number; day: number }
  | {
      kind: "weekday";
      month: number;
      ordinal: number | "last";
      weekday: Weekday;
    }
  | { kind: "workday"; month: number; ordinal: number | "last" };

export type Pattern =
  | { unit: "day"; interval: number }
  | { unit: "workday"; interval: number }
  | { unit: "week"; interval: number; weekdays: Weekday[] }
  | { unit: "month"; interval: number; on: MonthSelector[] }
  | { unit: "year"; interval: number; on: YearSelector[] };

export type Recurrence = {
  version: 1;
  origin: PlainDate;
  anchor: "scheduled" | "completed";
  weekStartsOn: WeekStart;
  until?: PlainDate;
  pattern: Pattern;
};

export type AdvanceResult =
  | { kind: "next"; scheduledOn: PlainDate }
  | { kind: "finished" };

export type Schedule =
  | { kind: "once"; date: PlainDate }
  | { kind: "recurring"; recurrence: Recurrence };

export type TextRange = { start: number; end: number; text: string };

export type ParseScheduleResult =
  | {
      kind: "scheduled";
      remainingText: string;
      schedule: Schedule;
      consumed: TextRange[];
    }
  | { kind: "none" };

export type ParseScheduleContext = {
  today: PlainDate;
  weekStartsOn: WeekStart;
  ignored?: TextRange[];
};

export type ValidationError = { path: string; message: string };
export type ValidationResult =
  | { ok: true; value: Recurrence }
  | { ok: false; errors: ValidationError[] };

function compactDate(date: PlainDate): string {
  return date.replaceAll("-", "");
}

function rruleFor(recurrence: Recurrence, origin: PlainDate): RRuleTemporal {
  const pattern = recurrence.pattern;
  const pieces = ["RSCALE=GREGORIAN", "SKIP=BACKWARD"];

  if (pattern.unit === "day") {
    pieces.push("FREQ=DAILY", `INTERVAL=${pattern.interval}`);
  } else if (pattern.unit === "week") {
    pieces.push(
      "FREQ=WEEKLY",
      `INTERVAL=${pattern.interval}`,
      `BYDAY=${pattern.weekdays.join(",")}`,
      `WKST=${recurrence.weekStartsOn}`,
    );
  } else if (pattern.unit === "month") {
    pieces.push("FREQ=MONTHLY", `INTERVAL=${pattern.interval}`);
    const days = pattern.on
      .filter((selector) => selector.kind === "day")
      .map((selector) => (selector.day === "last" ? -1 : selector.day));
    if (days.length > 0) pieces.push(`BYMONTHDAY=${days.join(",")}`);
  } else if (pattern.unit === "year") {
    pieces.push("FREQ=YEARLY", `INTERVAL=${pattern.interval}`);
  } else {
    throw new Error("workday recurrence is not implemented");
  }

  if (recurrence.until) {
    pieces.push(`UNTIL=${compactDate(recurrence.until)}`);
  }

  return new RRuleTemporal({
    rruleString: `DTSTART:${compactDate(origin)}T120000Z\nRRULE:${pieces.join(";")}`,
  });
}

function dateFilter(date: PlainDate): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function plainDateOf(value: ReturnType<RRuleTemporal["next"]>): PlainDate | null {
  if (!value) return null;
  return value.toPlainDate().toString();
}

const weekdayNumber: Record<Weekday, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

function workdaysInMonth(month: Temporal.PlainDate): Temporal.PlainDate[] {
  const result: Temporal.PlainDate[] = [];
  for (let day = 1; day <= month.daysInMonth; day += 1) {
    const date = month.with({ day });
    if (date.dayOfWeek <= 5) result.push(date);
  }
  return result;
}

function ordinal<T>(values: T[], value: number | "last"): T | undefined {
  return value === "last" ? values.at(-1) : values[value - 1];
}

function monthCandidates(
  month: Temporal.PlainDate,
  selectors: MonthSelector[],
): Temporal.PlainDate[] {
  return selectors
    .flatMap((selector) => {
      if (selector.kind === "day") {
        const day =
          selector.day === "last"
            ? month.daysInMonth
            : Math.min(selector.day, month.daysInMonth);
        return [month.with({ day })];
      }
      if (selector.kind === "workday") {
        const date = ordinal(workdaysInMonth(month), selector.ordinal);
        return date ? [date] : [];
      }
      const dates: Temporal.PlainDate[] = [];
      for (let day = 1; day <= month.daysInMonth; day += 1) {
        const date = month.with({ day });
        if (date.dayOfWeek === weekdayNumber[selector.weekday]) dates.push(date);
      }
      const date = ordinal(dates, selector.ordinal);
      return date ? [date] : [];
    })
    .sort((a, b) => Temporal.PlainDate.compare(a, b))
    .filter(
      (date, index, dates) =>
        index === 0 || Temporal.PlainDate.compare(date, dates[index - 1]) !== 0,
    );
}

function nextMonthly(
  recurrence: Recurrence & { pattern: Extract<Pattern, { unit: "month" }> },
  basis: PlainDate,
  origin: PlainDate,
): PlainDate {
  const after = Temporal.PlainDate.from(basis);
  const originDate = Temporal.PlainDate.from(origin).with({ day: 1 });

  for (let offset = 0; offset < 2_400; offset += recurrence.pattern.interval) {
    const month = originDate.add({ months: offset });
    const next = monthCandidates(month, recurrence.pattern.on).find(
      (candidate) => Temporal.PlainDate.compare(candidate, after) > 0,
    );
    if (next) return next.toString();
  }

  throw new Error("recurrence search exceeded 200 years");
}

function nextYearly(
  recurrence: Recurrence & { pattern: Extract<Pattern, { unit: "year" }> },
  basis: PlainDate,
  origin: PlainDate,
): PlainDate {
  const after = Temporal.PlainDate.from(basis);
  const originDate = Temporal.PlainDate.from(origin);
  for (let offset = 0; offset < 400; offset += recurrence.pattern.interval) {
    const year = originDate.year + offset;
    const candidates = recurrence.pattern.on.flatMap((selector) => {
      const month = Temporal.PlainDate.from({ year, month: selector.month, day: 1 });
      if (selector.kind === "date") {
        return [month.with({ day: Math.min(selector.day, month.daysInMonth) })];
      }
      const monthSelector: MonthSelector =
        selector.kind === "workday"
          ? { kind: "workday", ordinal: selector.ordinal }
          : {
              kind: "weekday",
              ordinal: selector.ordinal,
              weekday: selector.weekday,
            };
      return monthCandidates(month, [monthSelector]);
    });
    candidates.sort((a, b) => Temporal.PlainDate.compare(a, b));
    const next = candidates.find(
      (candidate) => Temporal.PlainDate.compare(candidate, after) > 0,
    );
    if (next) return next.toString();
  }
  throw new Error("recurrence search exceeded 400 years");
}

function nextWorkday(basis: PlainDate, interval: number): PlainDate {
  let date = Temporal.PlainDate.from(basis);
  let remaining = interval;
  while (remaining > 0) {
    date = date.add({ days: 1 });
    if (date.dayOfWeek <= 5) remaining -= 1;
  }
  return date.toString();
}

function nextCompleted(recurrence: Recurrence, completedOn: PlainDate): PlainDate {
  const completed = Temporal.PlainDate.from(completedOn);
  const { pattern } = recurrence;
  if (pattern.unit === "workday") {
    return nextWorkday(completedOn, pattern.interval);
  }
  const duration =
    pattern.unit === "day"
      ? { days: pattern.interval }
      : pattern.unit === "week"
        ? { weeks: pattern.interval }
        : pattern.unit === "month"
          ? { months: pattern.interval }
          : { years: pattern.interval };
  return completed.add(duration).toString();
}

export function advance(
  recurrence: Recurrence,
  event: { scheduledOn: PlainDate; completedOn: PlainDate },
): AdvanceResult {
  const basis =
    recurrence.anchor === "scheduled" ? event.scheduledOn : event.completedOn;
  const origin = recurrence.origin;
  let next: PlainDate | null;
  if (recurrence.anchor === "completed") {
    next = nextCompleted(recurrence, event.completedOn);
  } else if (recurrence.pattern.unit === "month") {
    next = nextMonthly(
      recurrence as Recurrence & {
        pattern: Extract<Pattern, { unit: "month" }>;
      },
      basis,
      origin,
    );
  } else if (recurrence.pattern.unit === "year") {
    next = nextYearly(
      recurrence as Recurrence & {
        pattern: Extract<Pattern, { unit: "year" }>;
      },
      basis,
      origin,
    );
  } else if (recurrence.pattern.unit === "workday") {
    next = nextWorkday(basis, recurrence.pattern.interval);
  } else {
    next = plainDateOf(rruleFor(recurrence, origin).next(dateFilter(basis)));
  }
  if (!next || (recurrence.until && next > recurrence.until)) {
    return { kind: "finished" };
  }
  return { kind: "next", scheduledOn: next };
}

const dateOnlyChrono = chrono.casual.clone();
dateOnlyChrono.parsers = dateOnlyChrono.parsers.filter(
  (parser) =>
    !["ENTimeExpressionParser", "ENCasualTimeParser"].includes(
      parser.constructor.name,
    ),
);
dateOnlyChrono.refiners = dateOnlyChrono.refiners.filter(
  (refiner) =>
    !refiner.constructor.name.includes("DateTime") &&
    !refiner.constructor.name.includes("Timezone"),
);

function removeRange(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${text.slice(end)}`
    .replace(/\s+/g, " ")
    .trim();
}

function maskRanges(text: string, ranges: TextRange[]): string {
  let masked = "";
  let offset = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(offset, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    masked += text.slice(offset, start);
    masked += " ".repeat(end - start);
    offset = end;
  }
  return masked + text.slice(offset);
}

function restoreText(
  original: string,
  parsed: ParseScheduleResult,
): ParseScheduleResult {
  if (parsed.kind === "none") return parsed;
  const consumed = parsed.consumed.map((range) => ({
    ...range,
    text: original.slice(range.start, range.end),
  }));
  let remainingText = original;
  for (const range of [...consumed].sort((a, b) => b.start - a.start)) {
    remainingText = `${remainingText.slice(0, range.start)}${remainingText.slice(range.end)}`;
  }
  return {
    ...parsed,
    consumed,
    remainingText: remainingText.replace(/\s+/g, " ").trim(),
  };
}

const monthByName: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const weekdayByName: Record<string, Weekday> = {
  mon: "MO",
  monday: "MO",
  tue: "TU",
  tues: "TU",
  tuesday: "TU",
  wed: "WE",
  wednesday: "WE",
  thu: "TH",
  thur: "TH",
  thurs: "TH",
  thursday: "TH",
  fri: "FR",
  friday: "FR",
  sat: "SA",
  saturday: "SA",
  sun: "SU",
  sunday: "SU",
};

function firstPatternDate(
  pattern: Pattern,
  start: PlainDate,
  weekStartsOn: WeekStart,
): PlainDate {
  const startDate = Temporal.PlainDate.from(start);
  if (pattern.unit === "day") return start;
  if (pattern.unit === "workday") {
    if (startDate.dayOfWeek <= 5) return start;
    return nextWorkday(start, 1);
  }
  if (pattern.unit === "week") {
    for (let offset = 0; offset < 14; offset += 1) {
      const candidate = startDate.add({ days: offset });
      const token = (Object.entries(weekdayNumber).find(([, day]) => day === candidate.dayOfWeek)?.[0] ?? "MO") as Weekday;
      if (pattern.weekdays.includes(token)) return candidate.toString();
    }
  }
  if (pattern.unit === "month") {
    for (let offset = 0; offset < 24; offset += 1) {
      const month = startDate.add({ months: offset }).with({ day: 1 });
      const candidate = monthCandidates(month, pattern.on).find(
        (value) => Temporal.PlainDate.compare(value, startDate) >= 0,
      );
      if (candidate) return candidate.toString();
    }
  }
  if (pattern.unit === "year") {
    for (let offset = 0; offset < 10; offset += 1) {
      const recurrence: Recurrence = {
        version: 1,
        origin: start,
        anchor: "scheduled",
        weekStartsOn,
        pattern,
      };
      const prior = startDate.subtract({ days: 1 }).toString();
      return nextYearly(
        recurrence as Recurrence & { pattern: Extract<Pattern, { unit: "year" }> },
        prior,
        start,
      );
    }
  }
  throw new Error("could not find first recurrence date");
}

type RecurrenceCandidate = {
  start: number;
  end: number;
  recurrence: Omit<Recurrence, "origin">;
  originShiftDays?: number;
};

function parseNumber(value: string | undefined, fallback = 1): number {
  if (!value) return fallback;
  if (value.toLowerCase() === "other") return 2;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
  return words[value.toLowerCase()] ?? Number(value);
}

function parseDateFragment(text: string, today: PlainDate) {
  const reference = new Date(`${today}T12:00:00.000Z`);
  const fragment = text.split(/\s+(?:ending|until)\b/i, 1)[0];
  const result = dateOnlyChrono.parse(fragment, reference, { forwardDate: true })[0];
  if (!result || result.index !== 0) return null;
  return {
    date: result.start.date().toISOString().slice(0, 10),
    length: result.text.length,
  };
}

function parseRecurrence(
  text: string,
  context: { today: PlainDate; weekStartsOn: WeekStart },
): ParseScheduleResult | null {
  const candidates: RecurrenceCandidate[] = [];
  const add = (
    match: RegExpMatchArray,
    pattern: Pattern,
    anchor: Recurrence["anchor"] = "scheduled",
    originShiftDays = 0,
  ) => {
    if (match.index == null) return;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      originShiftDays,
      recurrence: {
        version: 1,
        anchor,
        weekStartsOn: context.weekStartsOn,
        pattern,
      },
    });
  };

  for (const match of text.matchAll(/\b(first|last|\d{1,2}(?:st|nd|rd|th))\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+of\s+every\s+(?:(\d+|one|two|three|four|other)\s+)?months?\b/gi)) {
    const token = match[1].toLowerCase();
    const ordinal = token === "last" ? "last" : token === "first" ? 1 : Number.parseInt(token, 10);
    add(match, {
      unit: "month",
      interval: parseNumber(match[3]),
      on: [{
        kind: "weekday",
        ordinal,
        weekday: weekdayByName[match[2].toLowerCase()],
      }],
    });
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+other\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi)) {
    const weekday = weekdayByName[match[2].toLowerCase()];
    add(
      match,
      { unit: "week", interval: 2, weekdays: [weekday] },
      match[1] ? "completed" : "scheduled",
      7,
    );
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+((?:(?:first|last|\d{1,2}(?:st|nd|rd|th))\s+(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))(?:\s*,\s*(?:first|last|\d{1,2}(?:st|nd|rd|th))\s+(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))*)\b/gi)) {
    const on: YearSelector[] = match[2].split(/\s*,\s*/).map((part) => {
      const pieces = part.match(/(first|last|\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+([a-z]+)/i)!;
      return {
        kind: "weekday" as const,
        month: monthByName[pieces[3].toLowerCase()],
        ordinal: pieces[1].toLowerCase() === "last" ? "last" : pieces[1].toLowerCase() === "first" ? 1 : Number(pieces[1]),
        weekday: weekdayByName[pieces[2].toLowerCase()],
      };
    });
    add(match, { unit: "year", interval: 1, on }, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+((?:(?:first|last|\d{1,2}(?:st|nd|rd|th))\s+workday)(?:\s*,\s*(?:first|last|\d{1,2}(?:st|nd|rd|th))\s+workday)*)\b/gi)) {
    const on: MonthSelector[] = match[2].split(/\s*,\s*/).map((part) => {
      const token = part.split(/\s+/)[0].toLowerCase();
      return {
        kind: "workday" as const,
        ordinal: token === "last" ? "last" : token === "first" ? 1 : Number.parseInt(token, 10),
      };
    });
    add(match, { unit: "month", interval: 1, on }, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+(first|last|\d{1,2}(?:st|nd|rd|th))\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))?\b/gi)) {
    const ordinal = match[2].toLowerCase() === "last" ? "last" : match[2].toLowerCase() === "first" ? 1 : Number.parseInt(match[2], 10);
    const weekday = weekdayByName[match[3].toLowerCase()];
    const month = match[4] ? monthByName[match[4].toLowerCase()] : undefined;
    const pattern: Pattern = month
      ? { unit: "year", interval: 1, on: [{ kind: "weekday", month, ordinal, weekday }] }
      : { unit: "month", interval: 1, on: [{ kind: "weekday", ordinal, weekday }] };
    add(match, pattern, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+(first|last|\d{1,2}(?:st|nd|rd|th))\s+workday\b/gi)) {
    const ordinal = match[2].toLowerCase() === "last" ? "last" : match[2].toLowerCase() === "first" ? 1 : Number.parseInt(match[2], 10);
    add(match, { unit: "month", interval: 1, on: [{ kind: "workday", ordinal }] }, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+last\s+day\b/gi)) {
    add(match, { unit: "month", interval: 1, on: [{ kind: "day", day: "last" }] }, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+((?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))(?:\s*,\s*\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))*)\b/gi)) {
    const on: YearSelector[] = match[2].split(/\s*,\s*/).map((part) => {
      const pieces = part.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/i)!;
      return {
        kind: "date" as const,
        month: monthByName[pieces[2].toLowerCase()],
        day: Number(pieces[1]),
      };
    });
    if (
      on.every(
        (selector) =>
          selector.kind === "date" && selector.day >= 1 && selector.day <= 31,
      )
    ) {
      add(match, { unit: "year", interval: 1, on }, match[1] ? "completed" : "scheduled");
    }
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    const month = monthByName[match[2].toLowerCase()];
    const day = Number(match[3]);
    if (day >= 1 && day <= 31) add(match, { unit: "year", interval: 1, on: [{ kind: "date", month, day }] }, match[1] ? "completed" : "scheduled");
  }

  const holidays: Array<[RegExp, number, number]> = [
    [/\b(?:every|ev)\s+(?:new year day|new year's day)\b/gi, 1, 1],
    [/\b(?:every|ev)\s+(?:valentine|valentine's day)\b/gi, 2, 14],
    [/\b(?:every|ev)\s+halloween\b/gi, 10, 31],
    [/\b(?:every|ev)\s+new year(?:'s)? eve\b/gi, 12, 31],
  ];
  for (const [regex, month, day] of holidays) {
    for (const match of text.matchAll(regex)) {
      add(match, { unit: "year", interval: 1, on: [{ kind: "date", month, day }] });
    }
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+(?:(other|\d+|one|two|three|four)\s+)?weeks?\s+on\s+((?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s*,\s*(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))*)\b/gi)) {
    const weekdays = match[3]
      .split(/\s*,\s*/)
      .map((day) => weekdayByName[day.toLowerCase()]);
    add(
      match,
      { unit: "week", interval: parseNumber(match[2]), weekdays },
      match[1] ? "completed" : "scheduled",
    );
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+((?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s*,\s*(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))*)\b/gi)) {
    const weekdays = match[2].split(/\s*,\s*/).map((day) => weekdayByName[day.toLowerCase()]);
    add(match, { unit: "week", interval: 1, weekdays }, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+((?:\d{1,2}(?:st|nd|rd|th)?)(?:\s*,\s*\d{1,2}(?:st|nd|rd|th)?)*)\b(?!\s+(?:hours?|minutes?|seconds?))/gi)) {
    const days = match[2].split(/\s*,\s*/).map((day) => Number.parseInt(day, 10));
    if (days.every((day) => day >= 1 && day <= 31)) {
      add(match, { unit: "month", interval: 1, on: days.map((day) => ({ kind: "day", day })) }, match[1] ? "completed" : "scheduled");
    }
  }

  for (const match of text.matchAll(/\b(?:every|ev)(!?)\s+(?:(other|\d+|one|two|three|four)\s+)?(workdays?|weekdays?|weekends?|days?|weeks?|months?|years?)\b/gi)) {
    const token = match[3].toLowerCase();
    const interval = parseNumber(match[2]);
    let pattern: Pattern;
    if (token.startsWith("weekday")) pattern = { unit: "week", interval: 1, weekdays: ["MO", "TU", "WE", "TH", "FR"] };
    else if (token.startsWith("weekend")) pattern = { unit: "week", interval: 1, weekdays: ["SA", "SU"] };
    else if (token.startsWith("workday")) pattern = { unit: "workday", interval };
    else if (token.startsWith("day")) pattern = { unit: "day", interval };
    else if (token.startsWith("week")) {
      const today = Temporal.PlainDate.from(context.today);
      const weekday = (Object.entries(weekdayNumber).find(([, value]) => value === today.dayOfWeek)?.[0] ?? "MO") as Weekday;
      pattern = { unit: "week", interval, weekdays: [weekday] };
    } else if (token.startsWith("month")) {
      pattern = { unit: "month", interval, on: [{ kind: "day", day: Temporal.PlainDate.from(context.today).day }] };
    } else {
      const today = Temporal.PlainDate.from(context.today);
      pattern = { unit: "year", interval, on: [{ kind: "date", month: today.month, day: today.day }] };
    }
    add(match, pattern, match[1] ? "completed" : "scheduled");
  }

  for (const match of text.matchAll(/\b(everyday|daily|weekly|monthly|yearly|quarterly)\b/gi)) {
    const token = match[1].toLowerCase();
    const today = Temporal.PlainDate.from(context.today);
    const weekday = (Object.entries(weekdayNumber).find(([, value]) => value === today.dayOfWeek)?.[0] ?? "MO") as Weekday;
    const pattern: Pattern = token === "daily" || token === "everyday"
      ? { unit: "day", interval: 1 }
      : token === "weekly"
        ? { unit: "week", interval: 1, weekdays: [weekday] }
        : token === "monthly" || token === "quarterly"
          ? { unit: "month", interval: token === "quarterly" ? 3 : 1, on: [{ kind: "day", day: today.day }] }
          : { unit: "year", interval: 1, on: [{ kind: "date", month: today.month, day: today.day }] };
    add(match, pattern);
  }

  for (const match of text.matchAll(/\bafter\s+(\d+|one|two|three|four)\s+(workdays?|days?|weeks?|months?|years?)\b/gi)) {
    const interval = parseNumber(match[1]);
    const unit = match[2].toLowerCase();
    const today = Temporal.PlainDate.from(context.today);
    const weekday = (Object.entries(weekdayNumber).find(([, value]) => value === today.dayOfWeek)?.[0] ?? "MO") as Weekday;
    const pattern: Pattern = unit.startsWith("workday")
      ? { unit: "workday", interval }
      : unit.startsWith("day")
        ? { unit: "day", interval }
        : unit.startsWith("week")
          ? { unit: "week", interval, weekdays: [weekday] }
          : unit.startsWith("month")
            ? { unit: "month", interval, on: [{ kind: "day", day: today.day }] }
            : { unit: "year", interval, on: [{ kind: "date", month: today.month, day: today.day }] };
    add(match, pattern, "completed");
  }

  const maximal = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          other.end - other.start > candidate.end - candidate.start,
      ),
  );
  const selected = maximal.sort(
    (a, b) => b.start - a.start || b.end - b.start - (a.end - a.start),
  )[0];
  if (!selected) return null;
  let end = selected.end;
  let start = context.today;
  let until: PlainDate | undefined;

  const startPrefix = text.slice(end).match(/^\s+(?:starting(?:\s+on)?|from)\s+/i);
  if (startPrefix) {
    const parsed = parseDateFragment(text.slice(end + startPrefix[0].length), context.today);
    if (parsed) {
      start = parsed.date;
      end += startPrefix[0].length + parsed.length;
    }
  }

  const endPrefix = text.slice(end).match(/^\s+(?:ending|until)\s+/i);
  if (endPrefix) {
    const parsed = parseDateFragment(text.slice(end + endPrefix[0].length), start);
    if (parsed) {
      until = parsed.date;
      end += endPrefix[0].length + parsed.length;
    }
  } else {
    const duration = text.slice(end).match(/^\s+for\s+(\d+)\s+(days?|weeks?|months?|years?)\b/i);
    if (duration) {
      const amount = Number(duration[1]);
      const unit = duration[2].toLowerCase();
      const startDate = Temporal.PlainDate.from(start);
      until = startDate
        .add(
          unit.startsWith("day")
            ? { days: amount }
            : unit.startsWith("week")
              ? { weeks: amount }
              : unit.startsWith("month")
                ? { months: amount }
                : { years: amount },
        )
        .toString();
      end += duration[0].length;
    }
  }

  const first = firstPatternDate(
    selected.recurrence.pattern,
    start,
    context.weekStartsOn,
  );
  const origin = selected.originShiftDays
    ? (Temporal.PlainDate.from(first)
        .add({ days: selected.originShiftDays })
        .toString())
    : first;
  const matchedText = text.slice(selected.start, end);
  return {
    kind: "scheduled",
    remainingText: removeRange(text, selected.start, end),
    schedule: {
      kind: "recurring",
      recurrence: { ...selected.recurrence, origin, ...(until ? { until } : {}) },
    },
    consumed: [{ start: selected.start, end, text: matchedText }],
  };
}

function parseScheduleRaw(
  text: string,
  context: { today: PlainDate; weekStartsOn: WeekStart },
): ParseScheduleResult {
  const recurrence = parseRecurrence(text, context);
  if (recurrence) return recurrence;
  if (/\b(?:every|ev)!?\s+\d+\s+(?:hours?|minutes?|seconds?)\b/i.test(text)) {
    return { kind: "none" };
  }

  const compound = [
    ...text.matchAll(
      /\bin\s+(\d+|one|two|three|four)\s+weeks?\s+on\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi,
    ),
  ].at(-1);
  if (compound?.index != null) {
    const weeks = parseNumber(compound[1]);
    const target = weekdayNumber[weekdayByName[compound[2].toLowerCase()]];
    const today = Temporal.PlainDate.from(context.today);
    const weekStartNumber = context.weekStartsOn === "MO" ? 1 : 7;
    const sinceStart = (today.dayOfWeek - weekStartNumber + 7) % 7;
    const weekStart = today.subtract({ days: sinceStart }).add({ weeks });
    const offset = (target - weekStartNumber + 7) % 7;
    const date = weekStart.add({ days: offset }).toString();
    return {
      kind: "scheduled",
      remainingText: removeRange(
        text,
        compound.index,
        compound.index + compound[0].length,
      ),
      schedule: { kind: "once", date },
      consumed: [
        {
          start: compound.index,
          end: compound.index + compound[0].length,
          text: compound[0],
        },
      ],
    };
  }

  const reference = new Date(`${context.today}T12:00:00.000Z`);
  const result = dateOnlyChrono
    .parse(text, reference, { forwardDate: true })
    .at(-1);
  if (!result) return { kind: "none" };
  const date = result.start.date().toISOString().slice(0, 10);
  return {
    kind: "scheduled",
    remainingText: removeRange(
      text,
      result.index,
      result.index + result.text.length,
    ),
    schedule: { kind: "once", date },
    consumed: [
      {
        start: result.index,
        end: result.index + result.text.length,
        text: result.text,
      },
    ],
  };
}

export function parseSchedule(
  text: string,
  context: ParseScheduleContext,
): ParseScheduleResult {
  const parsed = parseScheduleRaw(
    context.ignored?.length ? maskRanges(text, context.ignored) : text,
    context,
  );
  return restoreText(text, parsed);
}

const weekdayLabel: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

function intervalText(interval: number, singular: string): string {
  return interval === 1 ? `every ${singular}` : `every ${interval} ${singular}s`;
}

export function toText(recurrence: Recurrence): string {
  const { pattern } = recurrence;
  let text: string;
  if (pattern.unit === "day") text = intervalText(pattern.interval, "day");
  else if (pattern.unit === "workday") text = intervalText(pattern.interval, "workday");
  else if (pattern.unit === "week") {
    const days = pattern.weekdays.map((day) => weekdayLabel[day]).join(", ");
    text = `${intervalText(pattern.interval, "week")} on ${days}`;
  } else if (pattern.unit === "month") {
    const selectors = pattern.on
      .map((selector) => {
        if (selector.kind === "day") return selector.day === "last" ? "the last day" : `day ${selector.day}`;
        if (selector.kind === "workday") return `${selector.ordinal} workday`;
        return `${selector.ordinal} ${weekdayLabel[selector.weekday]}`;
      })
      .join(", ");
    text = `${intervalText(pattern.interval, "month")} on ${selectors}`;
  } else {
    const selectors = pattern.on
      .map((selector) => {
        const prefix = `month ${selector.month}`;
        if (selector.kind === "date") return `${prefix} day ${selector.day}`;
        if (selector.kind === "workday") return `${selector.ordinal} workday of ${prefix}`;
        return `${selector.ordinal} ${weekdayLabel[selector.weekday]} of ${prefix}`;
      })
      .join(", ");
    text = `${intervalText(pattern.interval, "year")} on ${selectors}`;
  }
  if (recurrence.anchor === "completed") text = text.replace(/^every/, "every!");
  if (recurrence.until) text += ` until ${recurrence.until}`;
  return text;
}

function validDate(value: unknown): value is PlainDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}

export function validateRecurrence(value: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1) errors.push({ path: "version", message: "must be 1" });
  if (!validDate(row.origin)) errors.push({ path: "origin", message: "must be YYYY-MM-DD" });
  if (row.anchor !== "scheduled" && row.anchor !== "completed") {
    errors.push({ path: "anchor", message: "must be scheduled or completed" });
  }
  if (row.weekStartsOn !== "MO" && row.weekStartsOn !== "SU") {
    errors.push({ path: "weekStartsOn", message: "must be MO or SU" });
  }
  if (row.until !== undefined && !validDate(row.until)) {
    errors.push({ path: "until", message: "must be YYYY-MM-DD" });
  }
  if (validDate(row.origin) && validDate(row.until) && row.origin > row.until) {
    errors.push({ path: "until", message: "must not precede origin" });
  }
  const pattern = row.pattern;
  if (pattern == null || typeof pattern !== "object" || Array.isArray(pattern)) {
    errors.push({ path: "pattern", message: "must be an object" });
  } else {
    const p = pattern as Record<string, unknown>;
    if (!["day", "workday", "week", "month", "year"].includes(String(p.unit))) {
      errors.push({ path: "pattern.unit", message: "is unsupported" });
    }
    if (!Number.isSafeInteger(p.interval) || Number(p.interval) < 1) {
      errors.push({ path: "pattern.interval", message: "must be a positive integer" });
    }
    if (p.unit === "week") {
      if (!Array.isArray(p.weekdays) || p.weekdays.length === 0) {
        errors.push({ path: "pattern.weekdays", message: "must not be empty" });
      } else if (p.weekdays.some((day) => !(day in weekdayNumber))) {
        errors.push({ path: "pattern.weekdays", message: "contains an invalid weekday" });
      }
    }
    if (p.unit === "month" || p.unit === "year") {
      if (!Array.isArray(p.on) || p.on.length === 0) {
        errors.push({ path: "pattern.on", message: "must not be empty" });
      } else {
        p.on.forEach((selector, index) => {
          const path = `pattern.on.${index}`;
          if (selector == null || typeof selector !== "object" || Array.isArray(selector)) {
            errors.push({ path, message: "must be an object" });
            return;
          }
          const item = selector as Record<string, unknown>;
          if (p.unit === "month" && !["day", "weekday", "workday"].includes(String(item.kind))) {
            errors.push({ path: `${path}.kind`, message: "is invalid" });
          }
          if (p.unit === "year" && !["date", "weekday", "workday"].includes(String(item.kind))) {
            errors.push({ path: `${path}.kind`, message: "is invalid" });
          }
          if (p.unit === "year" && (!Number.isInteger(item.month) || Number(item.month) < 1 || Number(item.month) > 12)) {
            errors.push({ path: `${path}.month`, message: "must be 1 through 12" });
          }
          if ((item.kind === "day" || item.kind === "date") && item.day !== "last" && (!Number.isInteger(item.day) || Number(item.day) < 1 || Number(item.day) > 31)) {
            errors.push({ path: `${path}.day`, message: "must be 1 through 31 or last" });
          }
          if ((item.kind === "weekday" || item.kind === "workday") && item.ordinal !== "last" && (!Number.isInteger(item.ordinal) || Number(item.ordinal) < 1 || Number(item.ordinal) > 31)) {
            errors.push({ path: `${path}.ordinal`, message: "must be positive or last" });
          }
          if (item.kind === "weekday" && !(String(item.weekday) in weekdayNumber)) {
            errors.push({ path: `${path}.weekday`, message: "is invalid" });
          }
        });
      }
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as Recurrence };
}
