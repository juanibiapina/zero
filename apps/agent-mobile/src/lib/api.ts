import type {
  Capture,
  Project,
  ProjectEditFields,
  ProjectStatus,
  Task,
} from '@zero/agent-core';

import { API_BASE_URL } from './env';

// The Capture, Task and Project entity types are shared across web + mobile.
export type { Capture, Project, ProjectEditFields, ProjectStatus, Task };

// Returns the current Clerk session JWT (or null when signed out). Matches the
// shape of `getToken` from `@clerk/expo`'s `useAuth()`.
export type TokenGetter = () => Promise<string | null>;

// Cross-origin: attaches the Clerk session token as a Bearer header.
export async function apiFetch(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
  baseUrl: string = API_BASE_URL,
): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

export type UserSettings = {
  onboardingSeen: boolean;
  googleOnboardingStatus: string | null;
  createdAt: string | null;
  timezone: string | null;
};

export async function fetchUserSettings(
  getToken: TokenGetter,
): Promise<UserSettings> {
  const res = await apiFetch(getToken, '/api/user-settings');
  if (!res.ok) {
    throw new Error(`GET /api/user-settings failed: ${res.status}`);
  }
  return (await res.json()) as UserSettings;
}

// Writes this device's timezone to the server, for the silent timezone sync.
export async function patchTimezone(
  getToken: TokenGetter,
  zone: string,
): Promise<void> {
  const res = await apiFetch(getToken, '/api/user-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone: zone }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/user-settings failed: ${res.status}`);
  }
}

export async function fetchCaptures(
  getToken: TokenGetter,
  baseUrl: string = API_BASE_URL,
): Promise<Capture[]> {
  const res = await apiFetch(getToken, '/api/captures', {}, baseUrl);
  if (!res.ok) {
    throw new Error(`GET /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { captures: Capture[] };
  return body.captures;
}

export async function addCapture(
  getToken: TokenGetter,
  capture: { id: string; text: string },
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    '/api/captures',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(capture),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function processCapture(
  getToken: TokenGetter,
  id: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    `/api/captures/${id}/process`,
    { method: 'POST' },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/captures/${id}/process failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function editCapture(
  getToken: TokenGetter,
  id: string,
  text: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    `/api/captures/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function rescheduleCapture(
  getToken: TokenGetter,
  id: string,
  showUpDate: string | null,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    `/api/captures/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showUpDate }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function reorderCapture(
  getToken: TokenGetter,
  id: string,
  sortKey: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    `/api/captures/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sortKey }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/captures/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

// Task REST helpers: siblings of the Capture ones above, hitting /api/tasks.
// The server returns all open tasks (completedAt IS NULL); the client applies
// the local-today date filter.
export async function fetchTasks(
  getToken: TokenGetter,
  baseUrl: string = API_BASE_URL,
): Promise<Task[]> {
  const res = await apiFetch(getToken, '/api/tasks', {}, baseUrl);
  if (!res.ok) {
    throw new Error(`GET /api/tasks failed: ${res.status}`);
  }
  const body = (await res.json()) as { tasks: Task[] };
  return body.tasks;
}

export async function addTask(
  getToken: TokenGetter,
  task: { id: string; text: string; showUpDate: string },
  baseUrl: string = API_BASE_URL,
): Promise<Task> {
  const res = await apiFetch(
    getToken,
    '/api/tasks',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/tasks failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function completeTask(
  getToken: TokenGetter,
  id: string,
  baseUrl: string = API_BASE_URL,
): Promise<Task> {
  const res = await apiFetch(
    getToken,
    `/api/tasks/${id}/complete`,
    { method: 'POST' },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/complete failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

// Project REST helpers: siblings of the Task ones above, hitting /api/projects.
// The client sends only id + title; the server fills the defaults (icon 📁,
// description null, status next).
export async function fetchProjects(
  getToken: TokenGetter,
  baseUrl: string = API_BASE_URL,
): Promise<Project[]> {
  const res = await apiFetch(getToken, '/api/projects', {}, baseUrl);
  if (!res.ok) {
    throw new Error(`GET /api/projects failed: ${res.status}`);
  }
  const body = (await res.json()) as { projects: Project[] };
  return body.projects;
}

export async function addProject(
  getToken: TokenGetter,
  project: { id: string; title: string },
  baseUrl: string = API_BASE_URL,
): Promise<Project> {
  const res = await apiFetch(
    getToken,
    '/api/projects',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/projects failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}

export async function setProjectStatus(
  getToken: TokenGetter,
  id: string,
  status: ProjectStatus,
  baseUrl: string = API_BASE_URL,
): Promise<Project> {
  const res = await apiFetch(
    getToken,
    `/api/projects/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/projects/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}

export async function editProject(
  getToken: TokenGetter,
  id: string,
  fields: ProjectEditFields,
  baseUrl: string = API_BASE_URL,
): Promise<Project> {
  const res = await apiFetch(
    getToken,
    `/api/projects/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`PATCH /api/projects/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { project: Project };
  return body.project;
}

// Permanently delete a project. The server answers 204 whether or not the row
// existed (idempotent), so a replayed offline delete resolves cleanly.
export async function deleteProject(
  getToken: TokenGetter,
  id: string,
  baseUrl: string = API_BASE_URL,
): Promise<void> {
  const res = await apiFetch(
    getToken,
    `/api/projects/${id}`,
    { method: 'DELETE' },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`DELETE /api/projects/${id} failed: ${res.status}`);
  }
}
