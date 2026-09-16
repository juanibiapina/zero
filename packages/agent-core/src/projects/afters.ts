import type { ProjectAfter, ProjectAttention } from "../waits/types";
import type { Project } from "./types";

export function isManualWaitingCondition(
  condition: ProjectAttention,
): condition is Extract<ProjectAttention, { kind: "free-text" }> {
  return condition.kind === "free-text";
}

export function isProjectAfter(
  condition: ProjectAttention,
): condition is ProjectAfter {
  return condition.kind === "project-status";
}

export function wouldCreateAfterCycle(
  sourceProjectId: string,
  afterProjectId: string,
  conditions: readonly ProjectAttention[],
): boolean {
  if (sourceProjectId === afterProjectId) return true;

  const targetsBySource = new Map<string, string[]>();
  for (const condition of conditions) {
    if (!isProjectAfter(condition) || condition.resolvedAt != null) continue;
    const targets = targetsBySource.get(condition.projectId);
    if (targets) targets.push(condition.refId);
    else targetsBySource.set(condition.projectId, [condition.refId]);
  }

  const seen = new Set<string>();
  const pending = [afterProjectId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceProjectId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
}

export function candidateAfterProjects(
  sourceProjectId: string,
  projects: readonly Project[],
  conditions: readonly ProjectAttention[],
): Project[] {
  const directTargetIds = new Set(
    conditions
      .filter(
        (condition): condition is ProjectAfter =>
          isProjectAfter(condition) &&
          condition.projectId === sourceProjectId &&
          condition.resolvedAt == null,
      )
      .map((condition) => condition.refId),
  );

  return projects.filter(
    (project) =>
      project.id !== sourceProjectId &&
      project.state !== "done" &&
      !directTargetIds.has(project.id) &&
      !wouldCreateAfterCycle(sourceProjectId, project.id, conditions),
  );
}

export function projectsAfterTarget(
  targetProjectId: string,
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
): Project[] {
  const sourceIds = new Set(
    conditions
      .filter(
        (condition): condition is ProjectAfter =>
          isProjectAfter(condition) &&
          condition.resolvedAt == null &&
          condition.refId === targetProjectId,
      )
      .map((condition) => condition.projectId),
  );
  return projects.filter((project) => sourceIds.has(project.id));
}

export type ProjectAfterRemovalImpact = {
  affectedProjects: Project[];
};

export function projectAfterRemovalImpact(
  targetProjectId: string,
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
): ProjectAfterRemovalImpact {
  return {
    affectedProjects: projectsAfterTarget(targetProjectId, conditions, projects),
  };
}

export function projectAfterRemovalWarning(
  impact: ProjectAfterRemovalImpact,
): string | null {
  const affected = impact.affectedProjects.length;
  if (affected === 0) return null;
  if (affected === 1) {
    return `“${impact.affectedProjects[0].title}” is after it and may move to another section.`;
  }
  return `${affected} projects are after it and may move to another section.`;
}

export type ProjectAfterRelationship = {
  relationship: ProjectAfter;
  target: Project | null;
};

export function projectAfters(
  sourceProjectId: string,
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
): ProjectAfterRelationship[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return unresolvedProjectAfters(sourceProjectId, conditions, projects).map(
    (relationship) => ({
      relationship,
      target: projectsById.get(relationship.refId) ?? null,
    }),
  );
}

export type ProjectAfterContext = {
  detailLabel: string;
  rowLabel: string;
  sortKey: string;
};

export function projectAfterContext(
  sourceProjectId: string,
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
): ProjectAfterContext | null {
  const relationships = projectAfters(sourceProjectId, conditions, projects);
  if (relationships.length === 0) return null;

  let oldest = relationships[0].relationship.createdAt;
  for (const item of relationships) {
    if (item.relationship.createdAt < oldest) {
      oldest = item.relationship.createdAt;
    }
  }

  if (relationships.length > 1) {
    return {
      detailLabel: `${relationships.length} projects`,
      rowLabel: `after ${relationships.length} projects`,
      sortKey: oldest,
    };
  }
  const target = relationships[0].target;
  const identity = target ? `${target.icon} ${target.title}` : "another project";
  return {
    detailLabel: identity,
    rowLabel: `after ${identity}`,
    sortKey: oldest,
  };
}

export function unresolvedProjectAfters(
  sourceProjectId: string,
  conditions: readonly ProjectAttention[],
  projects: readonly Project[],
): ProjectAfter[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return conditions.filter(
    (condition): condition is ProjectAfter =>
      isProjectAfter(condition) &&
      condition.projectId === sourceProjectId &&
      condition.resolvedAt == null &&
      projectsById.get(condition.refId)?.state !== "done",
  );
}
