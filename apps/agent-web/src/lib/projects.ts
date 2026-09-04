// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

import type {
  Project,
  ProjectEditFields,
  ProjectStatus,
} from "@zero/agent-core";

export type { Project, ProjectEditFields, ProjectStatus };

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

export async function setProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/projects/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}

export async function editProject(
  id: string,
  fields: ProjectEditFields,
): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/projects/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}

// Permanently delete a project. The server answers 204 whether or not the row
// existed (idempotent), so a replayed offline delete resolves cleanly.
export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /api/projects/${id} failed: ${res.status}`);
  }
}
