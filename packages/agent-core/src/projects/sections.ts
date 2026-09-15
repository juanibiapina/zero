// The Projects list grouped into calculated status sections. Done is terminal
// and absent from the working list. Empty sections are omitted.

import type { Project, ProjectDisplayStatus } from "./types";

export const PROJECT_SECTION_ORDER: readonly ProjectDisplayStatus[] = [
  "active",
  "next",
  "waiting",
  "blocked",
  "backlog",
];

export type ProjectSection = {
  status: ProjectDisplayStatus;
  projects: Project[];
};

export function projectsByStatus(
  list: readonly Project[],
  statusOf: (p: Project) => ProjectDisplayStatus,
  sortKeyOf: (p: Project) => string = (p) => p.createdAt,
): ProjectSection[] {
  const byStatus = new Map<ProjectDisplayStatus, Project[]>();
  for (const p of list) {
    const status = statusOf(p);
    if (status === "done") continue;
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(p);
    else byStatus.set(status, [p]);
  }

  const sections: ProjectSection[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    const projects = byStatus.get(status);
    if (!projects?.length) continue;
    projects.sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)));
    sections.push({ status, projects });
  }
  return sections;
}
