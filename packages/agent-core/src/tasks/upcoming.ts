// The Upcoming view: open tasks scheduled for a future day, grouped by day. The
// complement of Home — homeTasks keeps what has shown up (undated or showUpDate
// <= today) and is available; this keeps what is still ahead (showUpDate >
// today), with NO other gate: every postponed task is here, loose or project,
// taken-on or not. A task belongs to at most one of the two views for a given
// day, so there is no overdue or today case here. Pure, so both the web and
// mobile screens share one tested grouping and it is unit-tested without a UI.
//
// Ported from the former captures/upcoming.ts in the single-list merge.

import { compareByOrder } from "./order";
import type { Task } from "../taskdo/types";

// One day's worth of upcoming tasks. `date` is the local YYYY-MM-DD; the UI
// formats it to a label ("Tomorrow", a weekday + date) in the device locale.
export type UpcomingSection = { date: string; tasks: Task[] };

// Group open, future-dated tasks into one section per day, days ascending, tasks
// within a day ordered by the shared manual-order comparator. Days with no items
// produce no section (the list only ever shows days that have items).
export function upcomingSections(
  list: readonly Task[],
  today: string,
): UpcomingSection[] {
  const byDay = new Map<string, Task[]>();
  for (const t of list) {
    if (t.completedAt != null) continue;
    if (t.showUpDate == null || t.showUpDate <= today) continue;
    const bucket = byDay.get(t.showUpDate);
    if (bucket) {
      bucket.push(t);
    } else {
      byDay.set(t.showUpDate, [t]);
    }
  }
  return [...byDay.keys()].sort().map((date) => ({
    date,
    tasks: byDay.get(date)!.sort(compareByOrder),
  }));
}
