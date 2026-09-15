import type { WaitingCondition } from "../waits/types";
import type { Project } from "./types";

export function isProjectCompletionDependency(
  condition: WaitingCondition,
): boolean {
  return (
    condition.kind === "project-status" &&
    condition.targetStatus === "done" &&
    condition.refId != null
  );
}

export function wouldCreateProjectDependencyCycle(
  dependentProjectId: string,
  prerequisiteProjectId: string,
  conditions: readonly WaitingCondition[],
): boolean {
  if (dependentProjectId === prerequisiteProjectId) return true;

  const prerequisitesByDependent = new Map<string, string[]>();
  for (const condition of conditions) {
    if (!isProjectCompletionDependency(condition)) continue;
    if (condition.resolvedAt != null) continue;
    const prerequisites = prerequisitesByDependent.get(condition.projectId);
    if (prerequisites) prerequisites.push(condition.refId!);
    else prerequisitesByDependent.set(condition.projectId, [condition.refId!]);
  }

  const seen = new Set<string>();
  const pending = [prerequisiteProjectId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === dependentProjectId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(prerequisitesByDependent.get(current) ?? []));
  }
  return false;
}

export function candidatePrerequisiteProjects(
  dependentProjectId: string,
  projects: readonly Project[],
  conditions: readonly WaitingCondition[],
): Project[] {
  const directPrerequisiteIds = new Set(
    conditions
      .filter(
        (condition) =>
          condition.projectId === dependentProjectId &&
          condition.resolvedAt == null &&
          isProjectCompletionDependency(condition),
      )
      .map((condition) => condition.refId!),
  );

  return projects.filter(
    (project) =>
      project.id !== dependentProjectId &&
      project.state !== "done" &&
      !directPrerequisiteIds.has(project.id) &&
      !wouldCreateProjectDependencyCycle(
        dependentProjectId,
        project.id,
        conditions,
      ),
  );
}

export function dependentProjectsForPrerequisite(
  prerequisiteProjectId: string,
  conditions: readonly WaitingCondition[],
  projects: readonly Project[],
): Project[] {
  const dependentIds = new Set(
    conditions
      .filter(
        (condition) =>
          condition.resolvedAt == null &&
          condition.refId === prerequisiteProjectId &&
          isProjectCompletionDependency(condition),
      )
      .map((condition) => condition.projectId),
  );
  return projects.filter((project) => dependentIds.has(project.id));
}

export type ProjectDependencyRemovalImpact = {
  affectedProjects: Project[];
  unblockedProjects: Project[];
};

export function projectDependencyRemovalWarning(
  impact: ProjectDependencyRemovalImpact,
): string | null {
  const affected = impact.affectedProjects.length;
  const unblocked = impact.unblockedProjects.length;
  if (affected === 0) return null;
  if (affected === 1) {
    const title = impact.affectedProjects[0].title;
    return unblocked === 1
      ? `“${title}” depends on it and will be unblocked.`
      : `This removes one dependency from “${title}”; it will remain blocked.`;
  }
  if (unblocked === affected) {
    return `${affected} projects depend on it and will be unblocked.`;
  }
  if (unblocked === 0) {
    return `This removes dependencies from ${affected} projects; all will remain blocked.`;
  }
  return `This removes dependencies from ${affected} projects; ${unblocked} will be unblocked.`;
}

export function projectDependencyRemovalImpact(
  prerequisiteProjectId: string,
  conditions: readonly WaitingCondition[],
  projects: readonly Project[],
): ProjectDependencyRemovalImpact {
  const affectedProjects = dependentProjectsForPrerequisite(
    prerequisiteProjectId,
    conditions,
    projects,
  );
  const unblockedProjects = affectedProjects.filter(
    (project) =>
      unresolvedProjectDependencies(project.id, conditions, projects).length ===
      1,
  );
  return { affectedProjects, unblockedProjects };
}

export type ProjectDependency = {
  condition: WaitingCondition;
  prerequisite: Project | null;
};

export function projectDependencies(
  dependentProjectId: string,
  conditions: readonly WaitingCondition[],
  projects: readonly Project[],
): ProjectDependency[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return unresolvedProjectDependencies(
    dependentProjectId,
    conditions,
    projects,
  ).map((condition) => ({
    condition,
    prerequisite: projectsById.get(condition.refId!) ?? null,
  }));
}

export type ProjectDependencyContext = { label: string; sortKey: string };

export function projectDependencyContext(
  dependentProjectId: string,
  conditions: readonly WaitingCondition[],
  projects: readonly Project[],
): ProjectDependencyContext | null {
  const dependencies = projectDependencies(
    dependentProjectId,
    conditions,
    projects,
  );
  if (dependencies.length === 0) return null;

  let oldest = dependencies[0].condition.createdAt;
  for (const dependency of dependencies) {
    if (dependency.condition.createdAt < oldest) {
      oldest = dependency.condition.createdAt;
    }
  }

  if (dependencies.length > 1) {
    return { label: `after ${dependencies.length} projects`, sortKey: oldest };
  }
  const prerequisite = dependencies[0].prerequisite;
  return {
    label: prerequisite
      ? `after ${prerequisite.icon} ${prerequisite.title}`
      : "after another project",
    sortKey: oldest,
  };
}

export function unresolvedProjectDependencies(
  dependentProjectId: string,
  conditions: readonly WaitingCondition[],
  projects: readonly Project[],
): WaitingCondition[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return conditions.filter((condition) => {
    if (!isProjectCompletionDependency(condition)) return false;
    if (condition.projectId !== dependentProjectId) return false;
    if (condition.resolvedAt != null) return false;
    return projectsById.get(condition.refId!)?.state !== "done";
  });
}
