import type { Task } from "../tasks/types";
import type {
  ManualWaitingCondition,
  ProjectAttention,
} from "../waits/types";
import {
  isManualWaitingCondition,
  unresolvedProjectAfters,
} from "./afters";
import type { Project, ProjectDisplayStatus } from "./types";

function isShownUpDatedOpen(task: Task, today: string): boolean {
  return (
    task.completedAt == null &&
    task.showUpDate != null &&
    task.showUpDate <= today
  );
}

function projectBaseStatus(
  project: Project,
  tasks: readonly Task[],
  today: string,
): ProjectDisplayStatus {
  if (project.state === "backlog" || project.state === "done") {
    return project.state;
  }
  return tasks.some(
    (task) =>
      task.projectId === project.id && isShownUpDatedOpen(task, today),
  )
    ? "active"
    : "next";
}

export function waitingUntil(
  project: Project,
  tasks: readonly Task[],
  today: string,
): string | null {
  let soonest: string | null = null;
  for (const task of tasks) {
    if (
      task.projectId === project.id &&
      task.completedAt == null &&
      task.showUpDate != null &&
      task.showUpDate > today &&
      (soonest == null || task.showUpDate < soonest)
    ) {
      soonest = task.showUpDate;
    }
  }
  return soonest;
}

export function unresolvedConditions(
  project: Project,
  conditions: readonly ProjectAttention[],
): ManualWaitingCondition[] {
  return conditions.filter(
    (condition): condition is ManualWaitingCondition =>
      isManualWaitingCondition(condition) &&
      condition.projectId === project.id &&
      condition.resolvedAt == null,
  );
}

export function waitingSince(
  project: Project,
  conditions: readonly ProjectAttention[] = [],
): string | null {
  const open = unresolvedConditions(project, conditions);
  if (open.length === 0) return null;
  let oldest = open[0].createdAt;
  for (const condition of open) {
    if (condition.createdAt < oldest) oldest = condition.createdAt;
  }
  return oldest;
}

export function projectDisplayStatus(
  project: Project,
  tasks: readonly Task[],
  today: string,
  conditions: readonly ProjectAttention[] = [],
  projects: readonly Project[] = [],
): ProjectDisplayStatus {
  const base = projectBaseStatus(project, tasks, today);
  if (base === "backlog" || base === "done") return base;

  // Deliberately scheduled work always brings an In-play Project forward. After
  // is an attention fallback, not a hard gate.
  if (base === "active") return "active";

  // Manual review and future-dated work both need attention before an automatic
  // After relationship does.
  if (
    unresolvedConditions(project, conditions).length > 0 ||
    waitingUntil(project, tasks, today) != null
  ) {
    return "waiting";
  }

  if (unresolvedProjectAfters(project.id, conditions, projects).length > 0) {
    return "after";
  }

  return "next";
}
