import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";

import type { Project } from "../projects/types";
import type { Task } from "../taskdo/types";
import type { ProjectAttention } from "../taskdo/types";
import { createTaskdoReplica, type TaskdoReplica } from "./replica";

export type InMemoryTodoSeed = {
  tasks?: Task[];
  projects?: Project[];
  waits?: ProjectAttention[];
};

export function createInMemoryTaskdoReplica(seed: InMemoryTodoSeed = {}): TaskdoReplica {
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
  return createTaskdoReplica({
    store,
    queryClient: new QueryClient(),
    queryKeyScope: ["test"],
  });
}
