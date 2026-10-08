import type { Task, TaskParent } from "../taskdo/types";

export function projectParent(projectId: string | null | undefined): TaskParent | null {
  return projectId ? { kind: "project", projectId } : null;
}

export function taskProjectId(task: Pick<Task, "parent">): string | null {
  const parent = task.parent;
  if (parent == null) return null;
  switch (parent.kind) {
    case "project": return parent.projectId;
  }
}

export type TaskRecord = Omit<Task, "parent"> & { projectId: string | null };

export function taskRecord(task: Task): TaskRecord {
  const { parent: _parent, ...fields } = task;
  return { ...fields, projectId: taskProjectId(task) };
}
