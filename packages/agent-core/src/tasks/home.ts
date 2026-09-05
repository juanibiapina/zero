import { projectDisplayStatus } from "../projects/derive";
import type { Project } from "../projects/types";
import type { WaitingCondition } from "../waits/types";
import type { Task } from "./types";

// homeTasks is the availability seam: given the tasks, the projects, and the
// waiting conditions, it returns the ordered list of tasks that show up in the
// Home top region. This is the single place the "what shows up" rule lives, and
// it deepened one gate at a time (see docs/plans/todo-availability-model.md):
//
//   slice 1: every open task.
//   slice 3: open AND (loose OR the task's project is active).
//   slice 4: a project task also has to be taken on; loose tasks always show.
//   slice 6 (now): "active" is the derived display status, so a project task
//                  hides when its project is waiting on an open condition.
//
// The rule:
//   - a loose task (projectId null) always shows — an immediate to-do, not
//     curated, with no project screen to live on when hidden.
//   - a project task shows only when it is taken on AND its project's *display*
//     status is `active` (in play, no unresolved waiting condition, and it has a
//     taken-on open task — which this task satisfies). A parked task, a task of a
//     backlog/done project, and any task of a waiting project stay hidden
//     (reachable from the project's detail sheet).
//
// Pure and in-process; tested directly. `showUpDate` is ignored: availability,
// not the date, decides what shows up.
export function homeTasks(
  tasks: Task[],
  projects: Project[],
  conditions: WaitingCondition[] = [],
): Task[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return tasks
    .filter((t) => t.completedAt == null)
    .filter((t) => {
      if (t.projectId == null) return true;
      const project = byId.get(t.projectId);
      if (!project || t.takenOnAt == null) return false;
      return (
        projectDisplayStatus(project, tasks, conditions, projects) === "active"
      );
    })
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
}
