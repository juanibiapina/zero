// Pure date helpers for the task list. The client mints a task's showUpDate in
// the user's local day and does the shown-up / upcoming split against it (the
// server stores the string verbatim and has no timezone). Ported from the
// former captures/dates.ts in the single-list merge; `localToday` and the
// Today-list `dueToday` still live in ./today.ts.

// The next calendar day after a YYYY-MM-DD string. Parsed at UTC noon so adding
// 24h never lands on the same date across a DST boundary, then reformatted in
// UTC. Used to compute the postpone-to-tomorrow target.
export function tomorrow(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + 1);
  const yy = noon.getUTCFullYear();
  const mm = String(noon.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(noon.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// A YYYY-MM-DD day parsed from its local parts (not `new Date(iso)`, which reads
// the string as UTC midnight and can slip a day). Backs the Upcoming day labels.
export function parseLocalDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Format a local Date back to YYYY-MM-DD (the inverse of parseLocalDay). Kept
// private-ish here because callers deal in the string form.
function formatLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// The label the task detail's schedule row shows for a `showUpDate`:
//   null/undefined -> "Schedule" (the empty call to action, never "No date"),
//   today          -> "Today",
//   today + 1      -> "Tomorrow",
//   else           -> weekday + day + month in the device locale (e.g. "Fri, 12 Sep").
// Loose `== null` so an unscheduled (loose) task reads as unscheduled.
export function scheduleLabel(
  showUpDate: string | null | undefined,
  today: string,
): string {
  if (showUpDate == null) return "Schedule";
  if (showUpDate <= today) return "Today";
  if (showUpDate === tomorrow(today)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(parseLocalDay(showUpDate));
}

// A short weekday for a YYYY-MM-DD day (e.g. "Fri"), used as the right-hand hint
// on the scheduler's quick-option rows ("Tomorrow · Fri"), mirroring Todoist.
export function weekdayShort(date: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
    parseLocalDay(date),
  );
}

// A calendar month laid out as six Monday-first weeks of YYYY-MM-DD days, so the
// scheduler can render a fixed 6x7 grid (the leading/trailing days spill into the
// adjacent months, like every month view). `month0` is 0-based (0 = January).
// Pure, so the grid is unit-tested without a renderer.
export function monthMatrix(year: number, month0: number): string[][] {
  const first = new Date(year, month0, 1);
  // JS getDay(): 0 = Sunday. Shift to Monday-first (Mon = 0 … Sun = 6).
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month0, 1 - lead);
  const weeks: string[][] = [];
  const cursor = start;
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(formatLocalDay(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// The Upcoming section header for a YYYY-MM-DD day: "Tomorrow" for the next day,
// else weekday + date in the device/browser locale (e.g. "Friday, 4 Sep").
// Shared so the web and mobile Upcoming lists label days identically.
export function dayLabel(date: string, today: string): string {
  if (date === tomorrow(today)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(parseLocalDay(date));
}
