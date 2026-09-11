import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";
import type { Project, ProjectStatus } from "./types";

// The display status of a project is derived on the client, not read straight
// from the stored column. The stored `status` is only the deliberate parking
// value: `backlog` and `done` are set by hand. The three in-play states are
// computed from the project's tasks and its waiting conditions (see
// docs/plans/todo-availability-model.md, slices 5-6, and
// docs/plans/todo-single-list-3-date-availability.md for the date-aware rule):
//
//   - backlog / done: the stored value (manual parking).
//   - active: in play, with a taken-on open task that has *shown up*
//     (showUpDate null or <= today). This wins even over an unresolved waiting
//     condition: taking a task on pulls the project back into active work.
//     Completing that task drops it back to next, at which point an open
//     condition surfaces as waiting.
//   - waiting: in play, nothing shown-up-and-taken-on, and either an unresolved
//     condition OR a future-dated taken-on task (a derived "waiting until <day>",
//     see waitingUntil).
//   - next: in play, nothing taken on, no open condition, no future-dated
//     taken-on task ("come groom / take on more").
//
// The derivation is date-aware: a taken-on task postponed to a future day no
// longer keeps its project active, and its `showUpDate` is what the project
// waits until. `today` is the user's local day (YYYY-MM-DD); it is always passed
// in, never computed here, so this module stays timezone-free and its tests stay
// deterministic (the client owns the day; the server stores the string verbatim).
//
// conditionSatisfied / unresolvedConditions and projectDisplayStatus live in one
// module on purpose: a `project-status` condition asks for another project's
// status, so they are mutually recursive. To keep that finite, the condition
// check compares against the project's *base* status (active/next/backlog/done,
// ignoring waiting), so evaluating one project's waiting never re-enters
// another's. The base status doubling as the active check is also what lets a
// taken-on task override waiting below. All pure and in-process; tested directly
// through this interface.

// Whether an open, taken-on task has shown up: no date (loose) or a date at or
// before today. A future date parks the task, so it does not count for `active`.
function isShownUpTakenOnOpen(t: Task, today: string): boolean {
  return (
    t.completedAt == null &&
    t.takenOnAt != null &&
    (t.showUpDate == null || t.showUpDate <= today)
  );
}

// active/next/backlog/done ignoring waiting conditions. The base used both by
// conditionSatisfied (to avoid recursion) and by projectDisplayStatus. Date-aware:
// only a shown-up taken-on open task makes a project active.
function projectBaseStatus(
  project: Project,
  tasks: Task[],
  today: string,
): ProjectStatus {
  if (project.status === "backlog" || project.status === "done") {
    return project.status;
  }
  const hasShownUpTakenOnOpenTask = tasks.some(
    (t) => t.projectId === project.id && isShownUpTakenOnOpen(t, today),
  );
  return hasShownUpTakenOnOpenTask ? "active" : "next";
}

// The soonest future day a project is waiting on, derived purely from its tasks:
// the earliest `showUpDate` among its open, taken-on, future-dated (> today)
// tasks, or null when it has none. No stored `waiting_conditions` row — the
// project status already computes from tasks, so a postponed taken-on task's day
// falls out of the tasks themselves. Completing or re-postponing that task
// changes the result for free; the day arriving makes the task shown-up, which
// makes the project active again, with no write on either transition. See
// docs/plans/todo-single-list-3-date-availability.md.
export function waitingUntil(
  project: Project,
  tasks: Task[],
  today: string,
): string | null {
  let soonest: string | null = null;
  for (const t of tasks) {
    if (
      t.projectId === project.id &&
      t.completedAt == null &&
      t.takenOnAt != null &&
      t.showUpDate != null &&
      t.showUpDate > today
    ) {
      if (soonest == null || t.showUpDate < soonest) soonest = t.showUpDate;
    }
  }
  return soonest;
}

// Whether a condition is currently met. Code settles the structured kinds; a
// human/AI settles free-text (resolvedAt).
export function conditionSatisfied(
  cond: WaitingCondition,
  tasks: Task[],
  projects: Project[],
  today: string,
): boolean {
  switch (cond.kind) {
    case "free-text":
      return cond.resolvedAt != null;
    case "task-done": {
      const t = tasks.find((x) => x.id === cond.refId);
      return t != null && t.completedAt != null;
    }
    case "project-status": {
      const p = projects.find((x) => x.id === cond.refId);
      if (!p) return false;
      return projectBaseStatus(p, tasks, today) === cond.targetStatus;
    }
    default:
      return false;
  }
}

// A project's open, currently-unmet conditions.
export function unresolvedConditions(
  project: Project,
  conditions: WaitingCondition[],
  tasks: Task[],
  projects: Project[],
  today: string,
): WaitingCondition[] {
  return conditions.filter(
    (c) =>
      c.projectId === project.id &&
      !conditionSatisfied(c, tasks, projects, today),
  );
}

// The instant a project started waiting on a *condition*: the createdAt of its
// oldest unresolved condition, or null when it has none. Reuses
// unresolvedConditions, so it counts exactly the conditions that make
// projectDisplayStatus return 'waiting' via a condition — the label and the
// status never disagree. ISO timestamps compare correctly as strings, so the
// minimum is the earliest. A date-only wait (waitingUntil) has no condition row
// and so returns null here; waitingBadge folds both kinds together for the
// Projects list. See docs/plans/todo-single-list-3-date-availability.md.
export function waitingSince(
  project: Project,
  tasks: Task[],
  today: string,
  conditions: WaitingCondition[] = [],
  projects: Project[] = [],
): string | null {
  const open = unresolvedConditions(project, conditions, tasks, projects, today);
  if (open.length === 0) return null;
  let oldest = open[0].createdAt;
  for (const c of open) {
    if (c.createdAt < oldest) oldest = c.createdAt;
  }
  return oldest;
}

export function projectDisplayStatus(
  project: Project,
  tasks: Task[],
  today: string,
  conditions: WaitingCondition[] = [],
  projects: Project[] = [],
): ProjectStatus {
  const base = projectBaseStatus(project, tasks, today);
  // backlog/done are terminal; an active project (a shown-up taken-on open task)
  // stays active even with an open condition — taking a task on overrides waiting.
  if (base !== "next") {
    return base;
  }
  // In play with nothing shown-up-and-taken-on: an open condition or a
  // future-dated taken-on task (waiting until its day) both read as waiting.
  if (
    unresolvedConditions(project, conditions, tasks, projects, today).length > 0
  ) {
    return "waiting";
  }
  if (waitingUntil(project, tasks, today) != null) {
    return "waiting";
  }
  return "next";
}
