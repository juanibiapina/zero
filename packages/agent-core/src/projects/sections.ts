// The Projects list view: the working set grouped into one section per status,
// in a fixed order (Active, Next, Waiting, Backlog), each ordered oldest-first.
// 'done' is terminal and never a section — a done project has left the working
// list. Empty sections are omitted (the list only shows statuses that have
// projects). Pure, so the web and mobile screens share one tested grouping and
// it is unit-tested without a UI. Sibling of captures/upcoming.ts.

import type { Project, ProjectStatus } from "./types";

// The four working statuses in the order the list shows them. 'done' is absent
// on purpose: it is terminal and drops out of the working list.
export const PROJECT_SECTION_ORDER: readonly ProjectStatus[] = [
  "active",
  "next",
  "waiting",
  "backlog",
];

// One status group. `status` is one of the four working states; `projects` is
// oldest-first and never empty (empty groups are omitted from the result).
export type ProjectSection = { status: ProjectStatus; projects: Project[] };

export function projectsByStatus(list: readonly Project[]): ProjectSection[] {
  const byStatus = new Map<ProjectStatus, Project[]>();
  for (const p of list) {
    // Defensive: a stray 'done' row (the server should not return one) is never
    // grouped into a section.
    if (p.status === "done") continue;
    const bucket = byStatus.get(p.status);
    if (bucket) {
      bucket.push(p);
    } else {
      byStatus.set(p.status, [p]);
    }
  }
  const sections: ProjectSection[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    const projects = byStatus.get(status);
    if (!projects || projects.length === 0) continue;
    projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    sections.push({ status, projects });
  }
  return sections;
}
