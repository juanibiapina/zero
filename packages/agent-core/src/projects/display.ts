// Project display data shared by the web and mobile Projects screens, so the two
// surfaces cannot drift (the icon set, the status labels, and the list-tuning
// constants live in one place). Pure data, no UI. Sibling of ./sections.ts,
// which owns the grouping logic.

import type { Project, ProjectStatus } from "./types";
import type { Task } from "../tasks/types";

// The five states in fixed order, with their labels. Active/Next/Waiting/Backlog
// are the working sections; Done is terminal (chosen from the detail sheet,
// never a section).
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  next: "Next",
  waiting: "Waiting",
  backlog: "Backlog",
  done: "Done",
};

export const ALL_STATUSES: ProjectStatus[] = [
  "active",
  "next",
  "waiting",
  "backlog",
  "done",
];

// The neutral default icon a project gets when none is chosen. The picker now
// offers every standard emoji (searchable), so an icon is a native glyph the
// platform renders — Apple and Google draw the same code point differently, an
// accepted tradeoff. This is the single default shared by the surfaces; the
// per-store creation defaults mirror it.
export const DEFAULT_ICON = "📁";

// A Backlog with more than this many projects collapses by default (it is the
// "someday" pile and must stay out of the way). Active/Next/Waiting start open.
export const BACKLOG_COLLAPSE_THRESHOLD = 5;

// The icon glyph shown for a task in a list: null for a loose task (no project,
// no badge), otherwise the task's project icon, falling back to DEFAULT_ICON
// when the project row is absent (deleted, or not yet loaded). The single rule
// the Home and Upcoming task rows share, so the two surfaces cannot drift. Pure
// and in-process.
export function taskIcon(task: Task, projects: Project[]): string | null {
  if (task.projectId == null) return null;
  return projects.find((p) => p.id === task.projectId)?.icon ?? DEFAULT_ICON;
}
