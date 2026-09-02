// The Upcoming view: open captures scheduled for a future day, grouped by day.
// The complement of the Captures list — `visibleCaptures` keeps what has shown
// up (undated or showUpDate <= today), this keeps what is still ahead
// (showUpDate > today). A capture belongs to exactly one of the two views, so
// there is no overdue or today case here. Pure, so both the web and mobile
// screens share one tested grouping and it is unit-tested without a UI.

import { compareByOrder } from "./order";
import type { Capture } from "./types";

// One day's worth of upcoming captures. `date` is the local YYYY-MM-DD; the UI
// formats it to a label ("Tomorrow", a weekday + date) in the device locale.
export type UpcomingSection = { date: string; captures: Capture[] };

// Group open, future-dated captures into one section per day, days ascending,
// captures within a day ordered by the shared manual-order comparator. Days with
// no items produce no section (the list only ever shows days that have items).
export function upcomingSections(
  list: readonly Capture[],
  today: string,
): UpcomingSection[] {
  const byDay = new Map<string, Capture[]>();
  for (const c of list) {
    if (c.processedAt != null) continue;
    if (c.showUpDate == null || c.showUpDate <= today) continue;
    const bucket = byDay.get(c.showUpDate);
    if (bucket) {
      bucket.push(c);
    } else {
      byDay.set(c.showUpDate, [c]);
    }
  }
  return [...byDay.keys()]
    .sort()
    .map((date) => ({
      date,
      captures: byDay.get(date)!.sort(compareByOrder),
    }));
}
