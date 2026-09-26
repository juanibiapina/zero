import type { Tables } from "tinybase";

import type { TodoSnapshot } from "../todo-authority";

// Imports are deliberately lossless. Referentially invalid rows are retained
// in the raw TinyBase tables and surfaced by TaskDO's recovery projections;
// validation still applies to every ordinary create and edit operation.
export function todoSnapshotTables(snapshot: TodoSnapshot): Tables {
  const cells = (values: Record<string, string | null>) =>
    Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) as Record<string, string>;
  const projectState = new Map(snapshot.projects.map((project) => [project.id, project.state]));

  return {
    tasks: Object.fromEntries(snapshot.tasks.map((task) => [task.id, cells({
      text: task.text,
      showUpDate: task.showUpDate,
      recurrence: task.recurrence ? JSON.stringify(task.recurrence) : null,
      recurrenceDate: task.recurrenceDate,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      projectId: task.projectId,
      sourceCaptureId: task.sourceCaptureId,
      sortKey: task.sortKey,
    })])),
    projects: Object.fromEntries(snapshot.projects.map((project) => [project.id, cells({
      title: project.title,
      icon: project.icon,
      description: project.description,
      state: project.state,
      createdAt: project.createdAt,
      sourceCaptureId: project.sourceCaptureId,
    })])),
    conditions: Object.fromEntries(snapshot.conditions.map((condition) => [condition.id, {
      ...cells({
        projectId: condition.projectId,
        kind: condition.kind,
        text: condition.text,
        refId: condition.refId,
        targetStatus: condition.targetStatus,
        resolvedAt: condition.resolvedAt,
        createdAt: condition.createdAt,
      }),
      ...(condition.kind === "project-status" && condition.resolvedAt &&
        projectState.get(condition.refId) === "done" ? { settledByTarget: true } : {}),
    }])),
  };
}
