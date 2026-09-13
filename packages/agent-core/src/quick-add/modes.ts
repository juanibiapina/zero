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
// `waiting` is project-scoped: it creates a free-text waiting condition on the
// open project and so is NEVER in ALL_ADD_MODES (Home and the Projects list have
// no project context); the project screen passes it explicitly.
//
// The `capture` mode was retired in the single-list merge: Task is the single
// entity now, so a quick-add with no project simply creates a loose task. See
// docs/plans/todo-single-list-1-merge.md.
export type AddMode = "task" | "project" | "waiting";

// The full offered set, in display order. A widget defaults to this; a
// single-purpose screen passes a narrowed list (e.g. ["project"] on the Projects
// list, or ["task", "waiting", "project"] on a project's own screen). `waiting`
// is deliberately absent here — it is project-scoped (see the type note above).
// `task` is the default entry (Home's quick-add).
export const ALL_ADD_MODES: AddMode[] = ["task", "project"];

// The short word shown on a mode's pill (capitalized as rendered).
export const ADD_MODE_LABEL: Record<AddMode, string> = {
  task: "Task",
  project: "Project",
  waiting: "Waiting",
};

// The input placeholder while a mode is selected. Project mode folds the
// outcome-based-naming guidance into the placeholder itself.
export const ADD_MODE_PLACEHOLDER: Record<AddMode, string> = {
  task: "Add a task",
  project: "Name an outcome",
  waiting: "Waiting on…",
};

// The accessibility label for a mode's pill. Most derive "Add a {label}", but
// "waiting" would read "Add a waiting", so it carries an explicit phrase.
const ADD_MODE_A11Y_OVERRIDE: Partial<Record<AddMode, string>> = {
  waiting: "Add a waiting condition",
};

export function addModeA11yLabel(mode: AddMode): string {
  return (
    ADD_MODE_A11Y_OVERRIDE[mode] ?? `Add a ${ADD_MODE_LABEL[mode].toLowerCase()}`
  );
}
