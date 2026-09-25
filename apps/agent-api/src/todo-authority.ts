import type { Project } from "./store/projects";
import type { Task } from "./store/tasks";
import type { WaitingCondition } from "./store/waiting-conditions";

export type TodoAuthority = "legacy" | "frozen" | "switched";

export type TodoSnapshot = {
  generation: string;
  tasks: Task[];
  projects: Project[];
  conditions: WaitingCondition[];
};

export type TodoSnapshotCounts = {
  tasks: number;
  projects: number;
  conditions: number;
};

export const todoSnapshotCounts = (snapshot: TodoSnapshot): TodoSnapshotCounts => ({
  tasks: snapshot.tasks.length,
  projects: snapshot.projects.length,
  conditions: snapshot.conditions.length,
});

const byId = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
};

// Array order is a presentation concern; every persisted field is not. This
// canonical form makes a migration prove exact row preservation instead of
// treating matching counts as sufficient.
export const canonicalTodoSnapshot = (snapshot: TodoSnapshot): string =>
  JSON.stringify(canonicalValue({
    generation: snapshot.generation,
    tasks: byId(snapshot.tasks),
    projects: byId(snapshot.projects),
    conditions: byId(snapshot.conditions),
  }));
