// Same-origin requests: the browser carries the Clerk session cookie, so no
// Bearer token is needed here (unlike the cross-origin mobile client).

import type { Task } from "@zero/agent-core";
import type { PlainDate, Recurrence } from "@zeroapps/recurrence";

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
  recurrence?: Recurrence | null;
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

export async function completeTaskOccurrence(
  id: string,
  event: { scheduledOn: PlainDate; completedOn: PlainDate },
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/complete-occurrence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`complete occurrence failed: ${res.status}`);
  return ((await res.json()) as { task: Task }).task;
}

export async function undoTaskOccurrence(
  id: string,
  event: {
    expectedRecurrenceDate: PlainDate;
    recurrenceDateBefore: PlainDate;
    showUpDateBefore: PlainDate | null;
  },
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/undo-occurrence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`undo occurrence failed: ${res.status}`);
  return ((await res.json()) as { task: Task }).task;
}

export async function setTaskRecurrence(
  id: string,
  recurrence: Recurrence | null,
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/recurrence`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recurrence }),
  });
  if (!res.ok) throw new Error(`set recurrence failed: ${res.status}`);
  return ((await res.json()) as { task: Task }).task;
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
