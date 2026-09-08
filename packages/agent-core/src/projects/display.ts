// Project display data shared by the web and mobile Projects screens, so the two
// surfaces cannot drift (the icon set, the status labels, and the list-tuning
// constants live in one place). Pure data, no UI. Sibling of ./sections.ts,
// which owns the grouping logic.

import type { ProjectStatus } from "./types";

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

// How long a project sits struck-through with an Undo affordance after the user
// sets it Done or deletes it, before the write commits and the row leaves the
// list. Long enough to reverse a mistake; short enough not to linger.
export const DONE_UNDO_MS = 5000;
