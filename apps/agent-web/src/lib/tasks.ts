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
