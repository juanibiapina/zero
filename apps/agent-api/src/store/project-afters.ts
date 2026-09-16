import type {
  DbProjectStore,
  Project,
  ProjectState,
} from "./projects";
import {
  type DbWaitingConditionStore,
  isProjectAfter,
  type ProjectAfter,
} from "./waiting-conditions";

export type ProjectAfterConflict =
  | "id-conflict"
  | "missing-source"
  | "missing-target"
  | "target-done"
  | "self"
  | "duplicate"
  | "cycle";

export type AddProjectAfterResult =
  | { relationship: ProjectAfter }
  | { conflict: ProjectAfterConflict };

function wouldCreateCycle(
  sourceProjectId: string,
  afterProjectId: string,
  relationships: ProjectAfter[],
): boolean {
  const targetsBySource = new Map<string, string[]>();
  for (const relationship of relationships) {
    const targets = targetsBySource.get(relationship.projectId);
    if (targets) targets.push(relationship.refId);
    else targetsBySource.set(relationship.projectId, [relationship.refId]);
  }
  const pending = [afterProjectId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceProjectId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
}

export type SetProjectStateResult = {
  project: Project | null;
  resolvedAfters: number;
  restoredAfters: number;
};

export function setProjectState(
  projects: DbProjectStore,
  conditions: DbWaitingConditionStore,
  id: string,
  state: ProjectState,
): SetProjectStateResult {
  const before = projects.get(id);
  const project = projects.setState(id, state);
  if (!project || !before) {
    return { project, resolvedAfters: 0, restoredAfters: 0 };
  }
  const resolvedAfters =
    before.state !== "done" && state === "done"
      ? conditions.resolveAftersForCompletedProject(id)
      : 0;
  const restoredAfters =
    before.state === "done" && state !== "done"
      ? conditions.restoreAftersForReopenedProject(id)
      : 0;
  return { project, resolvedAfters, restoredAfters };
}

export function addProjectAfter(
  projects: DbProjectStore,
  conditions: DbWaitingConditionStore,
  id: string,
  sourceProjectId: string,
  afterProjectId: string,
): AddProjectAfterResult {
  const existing = conditions.get(id);
  if (existing) {
    if (
      isProjectAfter(existing) &&
      existing.projectId === sourceProjectId &&
      existing.refId === afterProjectId
    ) {
      return { relationship: existing };
    }
    return { conflict: "id-conflict" };
  }

  const source = projects.get(sourceProjectId);
  if (!source) return { conflict: "missing-source" };
  const target = projects.get(afterProjectId);
  if (!target) return { conflict: "missing-target" };
  if (target.state === "done") return { conflict: "target-done" };
  if (sourceProjectId === afterProjectId) return { conflict: "self" };

  const relationships = conditions.listOpenAfters();
  if (
    relationships.some(
      (relationship) =>
        relationship.projectId === sourceProjectId &&
        relationship.refId === afterProjectId,
    )
  ) {
    return { conflict: "duplicate" };
  }
  if (wouldCreateCycle(sourceProjectId, afterProjectId, relationships)) {
    return { conflict: "cycle" };
  }

  return {
    relationship: conditions.addAfter(id, sourceProjectId, afterProjectId),
  };
}
