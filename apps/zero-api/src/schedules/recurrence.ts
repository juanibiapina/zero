// When a schedule pattern fires, and whether the pattern is one we accept.
// The only module that imports croner: everything above it speaks epoch
// milliseconds, so swapping or vendoring the evaluator stays a local change.
//
// A pattern is either a five-field cron expression ("0 8 * * 1-5") or an
// ISO-8601 local datetime ("2026-08-05T18:00:00"), always read in an IANA
// timezone. croner accepts both through one constructor, so there is one code
// path; a one-shot is simply a pattern whose next run goes null once past.
//
// croner is used as a pure evaluator (`paused: true`), so it starts no timer
// and nothing here depends on the runtime's scheduler. DST follows croner's
// documented policy: an occurrence inside a spring-forward gap shifts, and a
// fall-back overlap fires once.

import { Cron } from "croner";

// Two occurrences closer together than this are refused. Every fire is a full
// agent turn, so a model that misreads "every morning" as "every minute" would
// otherwise book an LLM call per minute, forever.
export const MIN_INTERVAL_MS = 15 * 60 * 1000;

// A cron pattern with a seconds field would let a schedule fire far below the
// floor and buys nothing at this granularity.
const MAX_CRON_FIELDS = 5;

const build = (pattern: string, timezone: string): Cron =>
  new Cron(pattern, { timezone, paused: true });

// The next time this pattern fires strictly after `after`, or null when it
// never fires again (a one-shot whose moment has passed).
export const nextRun = (
  pattern: string,
  timezone: string,
  after: number,
): number | null => {
  const run = build(pattern, timezone).nextRun(new Date(after));
  return run === null ? null : run.getTime();
};

// The next `count` occurrences after `after`, shorter when the pattern runs out.
export const upcoming = (
  pattern: string,
  timezone: string,
  after: number,
  count: number,
): number[] =>
  (build(pattern, timezone).nextRuns(count, new Date(after)) ?? []).map((d) =>
    d.getTime(),
  );

export type PatternCheck = { ok: true } | { error: string };

// Whether we will accept this pattern in this zone: parseable, still due at
// least once, and no more frequent than the floor.
export const validatePattern = (
  pattern: string,
  timezone: string,
  now: number = Date.now(),
): PatternCheck => {
  const trimmed = pattern.trim();
  if (trimmed.split(/\s+/).length > MAX_CRON_FIELDS) {
    return {
      error:
        "Use a five-field cron pattern (minute hour day-of-month month day-of-week); seconds are not supported.",
    };
  }
  let runs: number[];
  try {
    runs = upcoming(trimmed, timezone, now, 2);
  } catch (err) {
    return {
      error: `"${pattern}" is not a valid schedule pattern (${err instanceof Error ? err.message : String(err)}). Use a five-field cron expression like "0 8 * * 1-5", or an ISO-8601 local datetime like "2026-08-05T18:00:00".`,
    };
  }
  if (runs.length === 0) {
    return {
      error: `"${pattern}" never comes due again. For a one-off, give a datetime in the future.`,
    };
  }
  if (runs.length > 1 && runs[1] - runs[0] < MIN_INTERVAL_MS) {
    return {
      error: `"${pattern}" would run more often than every ${MIN_INTERVAL_MS / 60000} minutes, which is not allowed. Schedule it less frequently.`,
    };
  }
  return { ok: true };
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Absolute local time of one occurrence, in the schedule's own zone. Used for
// one-shot descriptions and for the `nextRun` a tool reports, so the model does
// no date math.
export const formatLocal = (at: number, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} (${timezone})`;
};

const pad = (value: string): string => value.padStart(2, "0");

// Day-of-week field to English, for the patterns worth naming.
const describeWeekdays = (field: string): string | null => {
  if (field === "1-5") return "every weekday";
  const days = field.split(",");
  const names = days.map((d) => WEEKDAY_NAMES[Number(d) % 7]);
  if (days.some((d) => !/^\d$/.test(d)) || names.some((n) => !n)) return null;
  if (names.length === 1) return `every ${names[0]}`;
  return `every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

// One line of English for a pattern, falling back to the pattern itself. It is
// shown to the user through the model, so being wrong is worse than being
// terse: anything not confidently recognised is returned verbatim.
export const describe = (pattern: string, timezone: string): string => {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return describeOneShot(pattern.trim(), timezone);
  const [minute, hour, dom, month, dow] = fields;
  const zone = ` (${timezone})`;
  if (month === "*" && dom === "*" && /^\d+$/.test(minute)) {
    const everyNHours = /^\*\/(\d+)$/.exec(hour);
    if (everyNHours && dow === "*") {
      return `every ${everyNHours[1]} hours at minute ${pad(minute)}${zone}`;
    }
    if (/^\d+$/.test(hour)) {
      const at = `at ${pad(hour)}:${pad(minute)}`;
      if (dow === "*") return `every day ${at}${zone}`;
      const days = describeWeekdays(dow);
      if (days) return `${days} ${at}${zone}`;
    }
  }
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyNMinutes && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `every ${everyNMinutes[1]} minutes${zone}`;
  }
  if (month === "*" && dow === "*" && /^\d+$/.test(dom) && /^\d+$/.test(hour) && /^\d+$/.test(minute)) {
    return `on day ${dom} of every month at ${pad(hour)}:${pad(minute)}${zone}`;
  }
  return `${pattern}${zone}`;
};

// A one-shot pattern is already a local datetime, so it is rendered from its own
// text: reading it back through the evaluator would return nothing once the
// moment has passed, and a schedule that has fired still has to be describable.
const describeOneShot = (pattern: string, timezone: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(pattern);
  if (!match) return `${pattern} (${timezone})`;
  const [, year, month, day, hour, minute] = match;
  // The weekday of a calendar date is the same in every zone, so computing it
  // in UTC is exact.
  const weekday = WEEKDAY_NAMES[
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  ].slice(0, 3);
  return `${weekday} ${year}-${month}-${day} ${hour}:${minute} (${timezone})`;
};
