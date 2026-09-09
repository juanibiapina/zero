// The add-mode registry: the single source of truth for what the quick-add box
// can create and how each mode reads. Shared by the web and mobile quick-add
// widgets so the two surfaces cannot drift (the id union, the short pill label,
// and the input placeholder all live here). Pure data, no UI — sibling in spirit
// to projects/display.ts.
//
// Before this, the concept was smeared across five places (a duplicate type in
// two components, a MODE_LABELS map, and an ADD_PLACEHOLDER map on each Home),
// so adding a mode meant editing all of them. It is now one table.

// What the quick-add box can create. Ordered as the pill row shows them.
export type AddMode = "capture" | "task" | "project";

// The full offered set, in display order. A widget defaults to this; a
// single-purpose screen passes a narrowed list (e.g. ["task"] on a project).
export const ALL_ADD_MODES: AddMode[] = ["capture", "task", "project"];

// The short word shown on a mode's pill (capitalized as rendered).
export const ADD_MODE_LABEL: Record<AddMode, string> = {
  capture: "Capture",
  task: "Task",
  project: "Project",
};

// The input placeholder while a mode is selected. Project mode folds the
// outcome-based-naming guidance into the placeholder itself.
export const ADD_MODE_PLACEHOLDER: Record<AddMode, string> = {
  capture: "Capture a thought",
  task: "Add a task",
  project: "Name an outcome",
};

// The accessibility label for a mode's pill, derived from its word so the two
// never drift ("Add a capture" / "Add a task" / "Add a project").
export function addModeA11yLabel(mode: AddMode): string {
  return `Add a ${ADD_MODE_LABEL[mode].toLowerCase()}`;
}
