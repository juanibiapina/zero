import type {
  DbProjectStore,
  Project,
  ProjectState,
} from "./projects";
import {
  type DbWaitingConditionStore,
  isProjectCompletionDependency,
  type WaitingCondition,
} from "./waiting-conditions";

export type ProjectDependencyConflict =
  | "id-conflict"
  | "missing-dependent"
  | "missing-prerequisite"
  | "prerequisite-done"
  | "self"
  | "duplicate"
  | "cycle";

export type AddProjectDependencyResult =
  | { condition: WaitingCondition }
  | { conflict: ProjectDependencyConflict };

function wouldCreateCycle(
  dependentProjectId: string,
  prerequisiteProjectId: string,
  edges: WaitingCondition[],
): boolean {
  const prerequisitesByDependent = new Map<string, string[]>();
  for (const edge of edges) {
    const prerequisites = prerequisitesByDependent.get(edge.projectId);
    if (prerequisites) prerequisites.push(edge.refId!);
    else prerequisitesByDependent.set(edge.projectId, [edge.refId!]);
  }
  const pending = [prerequisiteProjectId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependentProjectId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(prerequisitesByDependent.get(current) ?? []));
  }
  return false;
}

export function setProjectState(
  projects: DbProjectStore,
  conditions: DbWaitingConditionStore,
  id: string,
  state: ProjectState,
): { project: Project | null; resolvedDependencies: number } {
  const project = projects.setState(id, state);
  const resolvedDependencies =
    project && state === "done"
      ? conditions.resolveForCompletedProject(id)
      : 0;
  return { project, resolvedDependencies };
}

export function addProjectDependency(
  projects: DbProjectStore,
  conditions: DbWaitingConditionStore,
  id: string,
  dependentProjectId: string,
  prerequisiteProjectId: string,
): AddProjectDependencyResult {
  const existing = conditions.get(id);
  if (existing) {
    if (
      isProjectCompletionDependency(existing) &&
      existing.projectId === dependentProjectId &&
      existing.refId === prerequisiteProjectId
    ) {
      return { condition: existing };
    }
    return { conflict: "id-conflict" };
  }

  const dependent = projects.get(dependentProjectId);
  if (!dependent) return { conflict: "missing-dependent" };
  const prerequisite = projects.get(prerequisiteProjectId);
  if (!prerequisite) return { conflict: "missing-prerequisite" };
  if (prerequisite.state === "done") {
    return { conflict: "prerequisite-done" };
  }
  if (dependentProjectId === prerequisiteProjectId) {
    return { conflict: "self" };
  }
  const edges = conditions.listOpenProjectDependencies();
  if (
    edges.some(
      (edge) =>
        edge.projectId === dependentProjectId &&
        edge.refId === prerequisiteProjectId,
    )
  ) {
    return { conflict: "duplicate" };
  }
  if (wouldCreateCycle(dependentProjectId, prerequisiteProjectId, edges)) {
    return { conflict: "cycle" };
  }

  return {
    condition: conditions.addProjectDependency(
      id,
      dependentProjectId,
      prerequisiteProjectId,
    ),
  };
}
