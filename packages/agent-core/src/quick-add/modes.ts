// Home quick-add creates either a Task or an independent Project. Project
// workspaces extend the same registry with Project-scoped Waiting and After.
export type AddMode = "task" | "waiting" | "after" | "project" | "step" | "shopping";

// The global default stays narrow. Project-context surfaces opt into the two
// additional modes explicitly and choose their own order.
export const ALL_ADD_MODES: AddMode[] = ["task", "project"];

export const ADD_MODE_LABEL: Record<AddMode, string> = {
  task: "Task",
  waiting: "Waiting",
  after: "After",
  project: "Project",
  step: "Step",
  shopping: "Shopping",
};

export const ADD_MODE_PLACEHOLDER: Record<AddMode, string> = {
  task: "Add a task",
  waiting: "What needs to happen?",
  after: "Choose a project",
  project: "Name an outcome",
  step: "Add a step",
  shopping: "Add to shopping list",
};

const ADD_MODE_A11Y_LABEL: Record<AddMode, string> = {
  task: "Add a task",
  waiting: "Add a waiting condition",
  after: "Add an After project",
  project: "Add a project",
  step: "Add a night routine step",
  shopping: "Add a shopping list item",
};

export function addModeA11yLabel(mode: AddMode): string {
  return ADD_MODE_A11Y_LABEL[mode];
}
