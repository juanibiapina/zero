import type { Task } from "../tasks/types";
import type { ProjectAttention } from "../waits/types";
import { projectAfterContext } from "./afters";
import { projectDisplayStatus } from "./derive";
import type { Project } from "./types";
import { waitingBadge } from "./waiting-badge";

export type ProjectStatusContext = {
  label: string;
  rowLabel: string;
  sortKey: string;
};

export function projectStatusContext(
  project: Project,
  tasks: readonly Task[],
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
  today: string,
  now: Date = new Date(),
): ProjectStatusContext | null {
  const status = projectDisplayStatus(
    project,
    tasks,
    today,
    conditions,
    projects,
  );
  if (status === "after") {
    const context = projectAfterContext(project.id, conditions, projects);
    return context
      ? {
          label: context.detailLabel,
          rowLabel: context.rowLabel,
          sortKey: context.sortKey,
        }
      : null;
  }
  if (status === "waiting") {
    const context = waitingBadge(
      project,
      tasks,
      conditions,
      projects,
      today,
      now,
    );
    return context ? { ...context, rowLabel: context.label } : null;
  }
  return null;
}
