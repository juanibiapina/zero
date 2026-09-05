import type { Task } from "../tasks/types";
import type { Project, ProjectStatus } from "./types";

// The display status of a project is derived from its tasks (and, from slice 6,
// its waiting conditions), not read straight from the stored column. The stored
// `status` is only the deliberate parking value: `backlog` and `done` are set by
// hand and never auto-changed. The three in-play states are computed:
//
//   - backlog / done: use the stored value (manual parking).
//   - otherwise (in play): `active` if the project has at least one taken-on,
//     open task; else `next` (nothing taken on → "come groom / take on more").
//
// `waiting` (an open waiting condition) will take precedence over active/next in
// slice 6. Pure and in-process, tested directly. See
// docs/plans/todo-availability-model.md (slice 5).
export function projectDisplayStatus(
  project: Project,
  tasks: Task[],
): ProjectStatus {
  if (project.status === "backlog" || project.status === "done") {
    return project.status;
  }
  const hasTakenOnOpenTask = tasks.some(
    (t) =>
      t.projectId === project.id &&
      t.completedAt == null &&
      t.takenOnAt != null,
  );
  return hasTakenOnOpenTask ? "active" : "next";
}
