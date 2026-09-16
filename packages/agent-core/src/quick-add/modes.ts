// Home quick-add creates either a Task or an independent Project. Project-scoped
// Waiting and After use their own focused workspace flows.
export type AddMode = "task" | "project";

export const ALL_ADD_MODES: AddMode[] = ["task", "project"];

export const ADD_MODE_LABEL: Record<AddMode, string> = {
  task: "Task",
  project: "Project",
};

export const ADD_MODE_PLACEHOLDER: Record<AddMode, string> = {
  task: "Add a task",
  project: "Name an outcome",
};

export function addModeA11yLabel(mode: AddMode): string {
  return `Add a ${ADD_MODE_LABEL[mode].toLowerCase()}`;
}
