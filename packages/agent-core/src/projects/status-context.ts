import type { Task } from "../tasks/types";
import type { WaitingCondition } from "../waits/types";
import { projectDependencyContext } from "./dependencies";
import { projectDisplayStatus } from "./derive";
import type { Project } from "./types";
import { waitingBadge, type WaitingBadge } from "./waiting-badge";

export type ProjectStatusContext = WaitingBadge;

export function projectStatusContext(
  project: Project,
  tasks: Task[],
  conditions: WaitingCondition[],
  projects: Project[],
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
  if (status === "blocked") {
    return projectDependencyContext(project.id, conditions, projects);
  }
  if (status === "waiting") {
    return waitingBadge(project, tasks, conditions, projects, today, now);
  }
  return null;
}
