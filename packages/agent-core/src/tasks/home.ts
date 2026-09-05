import type { Project } from "../projects/types";
import type { Task } from "./types";

// homeTasks is the availability seam: given the task collection and the projects,
// it returns the ordered list of tasks that show up in the Home top region. This
// is the single place the "what shows up" rule lives, so it deepens one gate at
// a time:
//
//   slice 1: every open task, oldest first.
//   slice 3 (now): open AND (loose OR the task's project is active).
//   slice 4:       further gated to tasks the user has taken on.
//
// A task with a projectId shows only while that project is `active`; a task
// whose project is `next`/`waiting`/`backlog`/`done` (or missing) stays hidden.
// Loose tasks (projectId null) always pass the project gate. Pure and in-process
// (plain arrays in, list out), tested directly through this interface with no
// adapter. `showUpDate` is deliberately ignored: availability, not the date,
// decides what shows up (see docs/plans/todo-availability-model.md).
export function homeTasks(tasks: Task[], projects: Project[]): Task[] {
  const activeProjectIds = new Set(
    projects.filter((p) => p.status === "active").map((p) => p.id),
  );
  return tasks
    .filter((t) => t.completedAt == null)
    .filter((t) => t.projectId == null || activeProjectIds.has(t.projectId))
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
}
