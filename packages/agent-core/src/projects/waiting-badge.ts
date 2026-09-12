import { dayLabel } from "../tasks/dates";
import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";
import { projectDisplayStatus, waitingSince, waitingUntil } from "./derive";
import type { Project } from "./types";
import { waitingLabel } from "./waiting-label";

// The Projects list's Waiting section needs one label and one sort key per
// waiting project, and there are two reasons a project waits: an unresolved
// *condition* (label the elapsed time, "3 days"; order longest-waited first) or
// a future-dated taken-on *task* (label the target day, "until Tomorrow"; order
// soonest-arriving first). Before this seam existed each surface (web + mobile)
// re-branched that inline, and a date-only wait — which has no condition row —
// broke the condition-only `waitingSince(p) ?? createdAt` idiom. waitingBadge is
// the single pure place that resolves both: given a project it returns the badge
// text and the section sort key, or null when the project is not waiting. Both
// surfaces render `badge.label` and sort by `badge.sortKey`.
//
// A project waits for exactly one reason at a time: a condition wins if any is
// open, else a date. `now` is injected (default new Date()) so the elapsed label
// is deterministic in tests. `today` is the user's local day, threaded through
// the derivation. See docs/plans/todo-single-list-3-date-availability.md.
export type WaitingBadge = { label: string; sortKey: string };

export function waitingBadge(
  project: Project,
  tasks: Task[],
  conditions: WaitingCondition[],
  projects: Project[],
  today: string,
  now: Date = new Date(),
): WaitingBadge | null {
  if (
    projectDisplayStatus(project, tasks, today, conditions, projects) !==
    "waiting"
  ) {
    return null;
  }
  // A waiting project has an open condition or a future-dated taken-on task.
  // Prefer the condition (its "since" is a real recorded instant); fall back to
  // the derived date. The "a:"/"b:" prefixes keep condition waits (longest-first)
  // above date waits (soonest-first) within the one Waiting section, both
  // ascending by localeCompare.
  const since = waitingSince(project, tasks, today, conditions, projects);
  if (since != null) {
    // "for 5 days" mirrors the date wait's "until <day>": both are a preposition
    // + a time phrase, one looking back, one looking forward. The sub-minute
    // floor "just now" stays unprefixed — "for just now" reads wrong.
    const elapsed = waitingLabel(since, now);
    const label = elapsed === "just now" ? elapsed : `for ${elapsed}`;
    return { label, sortKey: `a:${since}` };
  }
  const until = waitingUntil(project, tasks, today);
  if (until != null) {
    return { label: `until ${dayLabel(until, today)}`, sortKey: `b:${until}` };
  }
  return null;
}
