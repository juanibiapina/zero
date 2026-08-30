import type { Task } from "./types";

// The user's local calendar day as YYYY-MM-DD. Both clients mint a new task's
// showUpDate with this and filter the Today list with it, so "today" is the
// device's local day (the server stores the string verbatim and has no
// timezone). Pass a fixed `now` in tests.
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// The Today list: open tasks (not completed) due on or before `today`, so an
// undone task from a past day rolls forward into today, and a future-dated task
// stays hidden until its day. Ordered by day, then creation order within a day.
// Pure and string-compared (YYYY-MM-DD sorts lexically), so it is unit-tested
// without the collection.
export function dueToday(tasks: readonly Task[], today: string): Task[] {
  return tasks
    .filter((t) => t.completedAt === null && t.showUpDate <= today)
    .sort(
      (a, b) =>
        a.showUpDate.localeCompare(b.showUpDate) ||
        a.createdAt.localeCompare(b.createdAt),
    );
}
