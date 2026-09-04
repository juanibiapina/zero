// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

import type { Project } from "@zero/agent-core";

export type { Project };

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) {
    throw new Error(`GET /api/projects failed: ${res.status}`);
  }
  const body = (await res.json()) as { projects: Project[] };
  return body.projects;
}

export async function addProject(project: {
  id: string;
  title: string;
}): Promise<Project> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  if (!res.ok) {
    throw new Error(`POST /api/projects failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}
