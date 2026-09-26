import { QueryClient } from "@tanstack/react-query";
import {
  createTaskdoReplica,
  type Project,
  type ProjectAttention,
  type Task,
  type TaskdoReplica,
} from "@zero/agent-core";
import { createMergeableStore } from "tinybase";

import type { TodoData } from "@/lib/todo-data";

export type InMemoryTodoSeed = {
  tasks?: Task[];
  projects?: Project[];
  waits?: ProjectAttention[];
};

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): {
  data: TodoData;
  replica: TaskdoReplica;
} {
  const store = createMergeableStore();
  for (const project of seed.projects ?? []) store.setRow("projects", project.id, {
    title: project.title,
    icon: project.icon,
    state: project.state,
    createdAt: project.createdAt,
    ...(project.description ? { description: project.description } : {}),
    ...(project.sourceCaptureId ? { sourceCaptureId: project.sourceCaptureId } : {}),
  });
  for (const task of seed.tasks ?? []) store.setRow("tasks", task.id, {
    text: task.text,
    createdAt: task.createdAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.showUpDate ? { showUpDate: task.showUpDate } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.sourceCaptureId ? { sourceCaptureId: task.sourceCaptureId } : {}),
    ...(task.recurrence ? { recurrence: JSON.stringify(task.recurrence) } : {}),
    ...(task.recurrenceDate ? { recurrenceDate: task.recurrenceDate } : {}),
    ...(task.sortKey ? { sortKey: task.sortKey } : {}),
  });
  for (const condition of seed.waits ?? []) store.setRow("conditions", condition.id, {
    projectId: condition.projectId,
    kind: condition.kind,
    createdAt: condition.createdAt,
    ...(condition.kind === "free-text"
      ? { text: condition.text }
      : { refId: condition.refId, targetStatus: "done" }),
    ...(condition.resolvedAt ? { resolvedAt: condition.resolvedAt } : {}),
  });
  const replica = createTaskdoReplica({
    store,
    queryClient: new QueryClient(),
    queryKeyScope: ["test"],
  });
  const data: TodoData = {
    api: replica.api,
    projectsApi: replica.projectsApi,
    waitsApi: replica.waitsApi,
    ready: true,
    connected: true,
    durable: true,
    error: null,
    durabilityError: null,
    recoveries: replica.snapshot().recoveries,
    repair: async (recovery) => { await replica.repair(recovery); },
  };
  return { data, replica };
}
