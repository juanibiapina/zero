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
  showUpDate: string;
  projectId: string | null;
  takenOnAt: string | null;
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

export async function setTaskTakenOn(
  id: string,
  takenOnAt: string | null,
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ takenOnAt }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status}`);
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
