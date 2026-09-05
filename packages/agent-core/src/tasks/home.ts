import type { Project } from "../projects/types";
import type { Task } from "./types";

// homeTasks is the availability seam: given the task collection and the projects,
// it returns the ordered list of tasks that show up in the Home top region. This
// is the single place the "what shows up" rule lives, so it deepened one gate at
// a time (see docs/plans/todo-availability-model.md):
//
//   slice 1: every open task.
//   slice 3: open AND (loose OR the task's project is active).
//   slice 4 (now): a project task also has to be taken on; loose tasks always show.
//
// The rule:
//   - a loose task (projectId null) always shows — it is an immediate to-do, not
//     curated; and it has no project screen to live on when hidden, so it must
//     not be gated by takenOnAt.
//   - a project task shows only while its project is `active` AND the user has
//     taken it on (takenOnAt set). Parked project tasks and tasks of non-active
//     projects stay hidden (reachable from the project's detail sheet).
//
// Pure and in-process (plain arrays in, list out), tested directly through this
// interface with no adapter. `showUpDate` is deliberately ignored: availability,
// not the date, decides what shows up.
export function homeTasks(tasks: Task[], projects: Project[]): Task[] {
  const activeProjectIds = new Set(
    projects.filter((p) => p.status === "active").map((p) => p.id),
  );
  return tasks
    .filter((t) => t.completedAt == null)
    .filter(
      (t) =>
        t.projectId == null ||
        (activeProjectIds.has(t.projectId) && t.takenOnAt != null),
    )
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
}
