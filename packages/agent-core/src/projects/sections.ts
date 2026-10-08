// One Project-list policy for pages and selectors. Derived status uses the full
// snapshot even when an After selector offers only eligible targets.
import type { Task } from "../taskdo/types";
import type { ProjectAttention } from "../taskdo/types";
import { candidateAfterProjects } from "./afters";
import { projectDisplayStatus } from "./derive";
import { projectStatusContext } from "./status-context";
import type { Project, ProjectDisplayStatus } from "./types";

const PROJECT_SECTION_ORDER: readonly ProjectDisplayStatus[] = [
  "active", "next", "waiting", "after", "backlog",
];

export type ProjectSection = {
  status: ProjectDisplayStatus;
  count: number;
  collapsed: boolean;
  projects: Project[];
};

export function projectStatusSections({
  projects,
  tasks,
  conditions,
  today,
  filter = "",
  collapseOverride = {},
  afterSourceProjectId,
}: {
  projects: readonly Project[];
  tasks: readonly Task[];
  conditions: readonly ProjectAttention[];
  today: string;
  filter?: string;
  collapseOverride?: Partial<Record<ProjectDisplayStatus, boolean>>;
  afterSourceProjectId?: string | null;
}): ProjectSection[] {
  const eligible = afterSourceProjectId === undefined
    ? projects
    : afterSourceProjectId === null
      ? []
      : candidateAfterProjects(afterSourceProjectId, projects, conditions);
  const grouped = new Map<ProjectDisplayStatus, Project[]>();
  for (const project of eligible) {
    const status = projectDisplayStatus(project, tasks, today, conditions, projects);
    if (status === "done") continue;
    const section = grouped.get(status);
    if (section) section.push(project);
    else grouped.set(status, [project]);
  }

  const needle = filter.trim().toLowerCase();
  const sections: ProjectSection[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    const all = grouped.get(status);
    if (!all?.length) continue;
    const matches = needle
      ? all.filter((project) => project.title.toLowerCase().includes(needle))
      : [...all];
    if (matches.length === 0) continue;
    matches.sort((a, b) => {
      const key = (project: Project) =>
        projectStatusContext(project, tasks, conditions, projects, today)?.sortKey ?? project.createdAt;
      return key(a).localeCompare(key(b));
    });
    sections.push({
      status,
      count: matches.length,
      collapsed: !needle && (collapseOverride[status] ?? (status === "after" || status === "backlog")),
      projects: matches,
    });
  }
  return sections;
}
