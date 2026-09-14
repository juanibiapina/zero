// Project display data shared by web and mobile. Persisted lifecycle uses
// ProjectState; these values describe calculated presentation only.

import type { Project, ProjectDisplayStatus } from "./types";
import type { Task } from "../tasks/types";

export const PROJECT_DISPLAY_STATUS_LABELS: Record<
  ProjectDisplayStatus,
  string
> = {
  active: "Active",
  next: "Next",
  waiting: "Waiting",
  backlog: "Backlog",
  done: "Done",
};

export const ALL_PROJECT_DISPLAY_STATUSES: ProjectDisplayStatus[] = [
  "active",
  "next",
  "waiting",
  "backlog",
  "done",
];

export const DEFAULT_ICON = "📁";

export const BACKLOG_COLLAPSE_THRESHOLD = 5;

// The icon glyph shown for a task in a list: null for a loose task, otherwise
// the task's project icon with a neutral fallback for a missing row.
export function taskIcon(task: Task, projects: Project[]): string | null {
  if (task.projectId == null) return null;
  return projects.find((p) => p.id === task.projectId)?.icon ?? DEFAULT_ICON;
}
