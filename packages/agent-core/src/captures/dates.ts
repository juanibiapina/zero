// Pure date helpers for the Captures list. The server is the authority on
// visibility (it filters by the user's timezone); these back only the client's
// optimistic hide, so a just-postponed row leaves the list at once and offline,
// before the server's filtered GET reconciles it.

import { compareByOrder } from "./order";
import type { Capture } from "./types";

// The device's local calendar day as YYYY-MM-DD. Duplicated from tasks/today.ts
// (not imported) so Captures does not depend on the parked Task module and Task
// can later be deleted cleanly. Pass a fixed `now` in tests.
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

// The optimistic client-side hide, mirroring the server filter: keep open
// captures with no show-up date or a date that has arrived, so a plain capture
// always shows and an overdue one rolls in silently (no red — Things-3 gentle
// overdue). Ordered by the manual sort key (nulls last), createdAt as the
// tiebreak — the same comparator the server uses, so client and server order
// identically. Pure, so it is unit-tested without the collection.
export function visibleCaptures(
  list: readonly Capture[],
  today: string,
): Capture[] {
  return list
    .filter(
      (c) =>
        c.processedAt == null &&
        // Loose `== null` so a missing/undefined date (e.g. a row from a server
        // that predates showUpDate) is treated as "always visible", not hidden.
        (c.showUpDate == null || c.showUpDate <= today),
    )
    .sort(compareByOrder);
}
