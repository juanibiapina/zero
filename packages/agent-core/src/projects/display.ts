// Project display data shared by web and mobile. Persisted lifecycle uses
// ProjectState; these values describe calculated presentation only.

import type { Project, ProjectDisplayStatus } from "./types";
import type { Task } from "../taskdo/types";
import { unreachableParent } from "../tasks/parent";

export const PROJECT_DISPLAY_STATUS_LABELS: Record<
  ProjectDisplayStatus,
  string
> = {
  active: "Active",
  next: "Next",
  waiting: "Waiting",
  after: "After",
  backlog: "Backlog",
  done: "Done",
};

export const ALL_PROJECT_DISPLAY_STATUSES: ProjectDisplayStatus[] = [
  "active",
  "next",
  "waiting",
  "after",
  "backlog",
  "done",
];

export const DEFAULT_ICON = "📁";

export const MEDICINE_TASK_ICON = "💊";

// The icon glyph shown for a task in a list: null for a loose task, 💊 for a
// Medicine Task, otherwise the task's project icon with a neutral fallback for
// a missing row.
export function taskIcon(task: Task, projects: readonly Project[]): string | null {
  const parent = task.parent;
  if (parent == null) return null;
  switch (parent.kind) {
    case "project": return projects.find((p) => p.id === parent.projectId)?.icon ?? DEFAULT_ICON;
    case "medicine": return MEDICINE_TASK_ICON;
    default: return unreachableParent(parent);
  }
}
