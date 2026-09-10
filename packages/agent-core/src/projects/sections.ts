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

// `statusOf` maps a project to the status it should be grouped under. It
// defaults to the stored `status`, but callers pass the derived display status
// (projectDisplayStatus) so the list groups by active/next as taken-on tasks
// change, not by the stored column.
//
// `sortKeyOf` is the ascending sort key within each section; it defaults to
// createdAt (oldest-first, the historical behavior). The Projects list passes
// `waitingSince(p) ?? p.createdAt`: since waitingSince is non-null only for
// waiting projects and each section is homogeneous by status, this orders the
// Waiting section by how long each project has waited (longest on top) while
// every other section keeps its createdAt order.
export function projectsByStatus(
  list: readonly Project[],
  statusOf: (p: Project) => ProjectStatus = (p) => p.status,
  sortKeyOf: (p: Project) => string = (p) => p.createdAt,
): ProjectSection[] {
  const byStatus = new Map<ProjectStatus, Project[]>();
  for (const p of list) {
    const status = statusOf(p);
    // Defensive: a stray 'done' row (the server should not return one) is never
    // grouped into a section.
    if (status === "done") continue;
    const bucket = byStatus.get(status);
    if (bucket) {
      bucket.push(p);
    } else {
      byStatus.set(status, [p]);
    }
  }
  const sections: ProjectSection[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    const projects = byStatus.get(status);
    if (!projects || projects.length === 0) continue;
    projects.sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)));
    sections.push({ status, projects });
  }
  return sections;
}
