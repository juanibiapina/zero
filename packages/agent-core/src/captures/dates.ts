// Pure date helpers for the Captures list. The server is the authority on
// visibility (it filters by the user's timezone); these back only the client's
// optimistic hide, so a just-postponed row leaves the list at once and offline,
// before the server's filtered GET reconciles it.

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

// The optimistic client-side hide, mirroring the server filter: keep open
// captures with no show-up date or a date that has arrived, so a plain capture
// always shows and an overdue one rolls in silently (no red — Things-3 gentle
// overdue). Ordered oldest first. Pure and string-compared (YYYY-MM-DD sorts
// lexically), so it is unit-tested without the collection.
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
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
