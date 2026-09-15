import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";
import { unresolvedProjectDependencies } from "./dependencies";
import type { Project, ProjectDisplayStatus } from "./types";

// Display status is derived on the client. Persisted `state` records only
// in-play/backlog/done; Active, Next, Waiting, and Blocked are computed from
// tasks and waiting conditions (see
// docs/plans/todo-availability-model.md, slices 5-6, and
// docs/plans/todo-single-list-3-date-availability.md for the date-aware rule):
//
//   - backlog / done: the stored value (manual parking).
//   - blocked: in play, with an unresolved project-completion dependency. This
//     hard gate wins over every task and ordinary wait.
//   - active: in play, with an open task that has a date that has *arrived*
//     (showUpDate != null AND <= today). The date is the commitment gate (the
//     take-on star is retired; see docs/plans/todo-retire-take-on.md). This wins
//     even over an unresolved waiting condition: dating a task pulls the project
//     back into active work. Completing that task drops it back to next, at which
//     point an open condition surfaces as waiting.
//   - waiting: in play, nothing shown-up-and-dated, and either an unresolved
//     condition OR a future-dated task (a derived "waiting until <day>", see
//     waitingUntil).
//   - next: in play, nothing dated (only groomed/undated tasks), no open
//     condition, no future-dated task ("come groom / schedule one").
//
// The derivation is date-aware: an undated task is groomed and never makes a
// project active; a future-dated task is a commitment and its `showUpDate` is
// what the project waits until. `today` is the user's local day (YYYY-MM-DD); it
// is always passed in, never computed here, so this module stays timezone-free
// and its tests stay deterministic (the client owns the day; the server stores
// the string verbatim).
//
// conditionSatisfied / unresolvedConditions and projectDisplayStatus live in one
// module on purpose: a `project-status` condition asks for another project's
// status, so they are mutually recursive. To keep that finite, the condition
// check compares against the project's *base* status (active/next/backlog/done,
// ignoring waiting), so evaluating one project's waiting never re-enters
// another's. The base status doubling as the active check is also what lets a
// dated task override waiting below. All pure and in-process; tested directly
// through this interface.

// Whether an open project task has a date that has ARRIVED: a non-null date at
// or before today. A null date is groomed (not a commitment) and a future date
// parks the task, so neither counts for `active`. The date is the sole
// commitment gate (take-on is retired).
function isShownUpDatedOpen(t: Task, today: string): boolean {
  return (
    t.completedAt == null && t.showUpDate != null && t.showUpDate <= today
  );
}

// active/next/backlog/done ignoring waiting conditions. The base used both by
// conditionSatisfied (to avoid recursion) and by projectDisplayStatus. Date-aware:
// only a shown-up dated open task makes a project active.
function projectBaseStatus(
  project: Project,
  tasks: Task[],
  today: string,
): ProjectDisplayStatus {
  if (project.state === "backlog" || project.state === "done") {
    return project.state;
  }
  const hasShownUpDatedOpenTask = tasks.some(
    (t) => t.projectId === project.id && isShownUpDatedOpen(t, today),
  );
  return hasShownUpDatedOpenTask ? "active" : "next";
}

// The soonest future day a project is waiting on, derived purely from its tasks:
// the earliest `showUpDate` among its open, future-dated (> today) tasks, or
// null when it has none. No stored `waiting_conditions` row — the project status
// already computes from tasks, so a scheduled task's day falls out of the tasks
// themselves. A future-dated task is a commitment (the date is the gate), so any
// such task counts. Completing or re-scheduling that task changes the result for
// free; the day arriving makes the task shown-up, which makes the project active
// again, with no write on either transition. See docs/plans/todo-retire-take-on.md.
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
  if (cond.resolvedAt != null) return true;
  switch (cond.kind) {
    case "free-text":
      return false;
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
): ProjectDisplayStatus {
  const base = projectBaseStatus(project, tasks, today);
  if (base === "backlog" || base === "done") return base;
  // A completion dependency is a hard project gate: arrived work cannot make
  // the project Active until every prerequisite has been completed or removed.
  if (
    unresolvedProjectDependencies(project.id, conditions, projects).length > 0
  ) {
    return "blocked";
  }
  // An active project (a shown-up dated open task) stays active over every
  // ordinary waiting condition — dating a task overrides a soft wait.
  if (base === "active") return base;
  // In play with nothing shown-up-and-dated: an open condition or a future-dated
  // task (waiting until its day) both read as waiting.
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
