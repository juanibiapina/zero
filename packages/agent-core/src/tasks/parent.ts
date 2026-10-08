import type { Task, TaskParent } from "../taskdo/types";

export function unreachableParent(parent: never): never {
  throw new Error(`Unknown Task parent: ${JSON.stringify(parent)}`);
}

export function projectParent(projectId: string | null | undefined): TaskParent | null {
  return projectId ? { kind: "project", projectId } : null;
}

export function taskProjectId(task: Pick<Task, "parent">): string | null {
  const parent = task.parent;
  if (parent == null) return null;
  switch (parent.kind) {
    case "project": return parent.projectId;
    case "medicine": return null;
    default: return unreachableParent(parent);
  }
}

export function taskMedicineId(task: Pick<Task, "parent">): string | null {
  return task.parent?.kind === "medicine" ? task.parent.medicineId : null;
}

export type TaskCompletion =
  | { kind: "complete"; projectId: string | null }
  | { kind: "restock"; medicineId: string };

// Completing a restock Task asks how many pills were bought first; every
// other Task completes, and a Project Task then offers Waiting for….
export function taskCompletion(task: Pick<Task, "parent">): TaskCompletion {
  const parent = task.parent;
  if (parent == null) return { kind: "complete", projectId: null };
  switch (parent.kind) {
    case "project": return { kind: "complete", projectId: parent.projectId };
    case "medicine":
      return parent.role === "restock"
        ? { kind: "restock", medicineId: parent.medicineId }
        : { kind: "complete", projectId: null };
    default: return unreachableParent(parent);
  }
}
