// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

import type { Task } from "@zero/agent-core";

export type { Task };

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch("/api/tasks");
  if (!res.ok) {
    throw new Error(`GET /api/tasks failed: ${res.status}`);
  }
  const body = (await res.json()) as { tasks: Task[] };
  return body.tasks;
}

export async function addTask(task: {
  id: string;
  text: string;
  showUpDate: string | null;
  projectId: string | null;
  sourceCaptureId: string | null;
}): Promise<Task> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    throw new Error(`POST /api/tasks failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function completeTask(id: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/complete`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/complete failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function reopenTask(id: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/reopen`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST /api/tasks/${id}/reopen failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function editTask(id: string, text: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function rescheduleTask(
  id: string,
  showUpDate: string | null,
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showUpDate }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function reorderTask(id: string, sortKey: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sortKey }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}

export async function setTaskProject(
  id: string,
  projectId: string | null,
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status}`);
  }
  const body = (await res.json()) as { task: Task };
  return body.task;
}
