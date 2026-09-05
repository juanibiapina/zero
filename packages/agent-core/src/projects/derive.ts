import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";
import type { Project, ProjectStatus } from "./types";

// The display status of a project is derived on the client, not read straight
// from the stored column. The stored `status` is only the deliberate parking
// value: `backlog` and `done` are set by hand. The three in-play states are
// computed from the project's tasks and its waiting conditions (see
// docs/plans/todo-availability-model.md, slices 5-6):
//
//   - backlog / done: the stored value (manual parking).
//   - waiting: has at least one unresolved waiting condition.
//   - active: in play, unblocked, with a taken-on open task.
//   - next: in play, unblocked, nothing taken on ("come groom / take on more").
//
// conditionSatisfied / unresolvedConditions and projectDisplayStatus live in one
// module on purpose: a `project-status` condition asks for another project's
// status, so they are mutually recursive. To keep that finite, the condition
// check compares against the project's *base* status (active/next/backlog/done,
// ignoring waiting), so evaluating one project's waiting never re-enters
// another's. All pure and in-process; tested directly through this interface.

// active/next/backlog/done ignoring waiting conditions. The base used both by
// conditionSatisfied (to avoid recursion) and by projectDisplayStatus.
function projectBaseStatus(project: Project, tasks: Task[]): ProjectStatus {
  if (project.status === "backlog" || project.status === "done") {
    return project.status;
  }
  const hasTakenOnOpenTask = tasks.some(
    (t) =>
      t.projectId === project.id &&
      t.completedAt == null &&
      t.takenOnAt != null,
  );
  return hasTakenOnOpenTask ? "active" : "next";
}

// Whether a condition is currently met. Code settles the structured kinds; a
// human/AI settles free-text (resolvedAt).
export function conditionSatisfied(
  cond: WaitingCondition,
  tasks: Task[],
  projects: Project[],
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
      return projectBaseStatus(p, tasks) === cond.targetStatus;
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
): WaitingCondition[] {
  return conditions.filter(
    (c) =>
      c.projectId === project.id && !conditionSatisfied(c, tasks, projects),
  );
}

export function projectDisplayStatus(
  project: Project,
  tasks: Task[],
  conditions: WaitingCondition[] = [],
  projects: Project[] = [],
): ProjectStatus {
  if (project.status === "backlog" || project.status === "done") {
    return project.status;
  }
  if (unresolvedConditions(project, conditions, tasks, projects).length > 0) {
    return "waiting";
  }
  return projectBaseStatus(project, tasks);
}
