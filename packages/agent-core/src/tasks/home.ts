import type { Project } from "../projects/types";
import { compareByOrder } from "./order";
import type { Task } from "../taskdo/types";

// Home is open work whose day has arrived. A Project Task needs an arrived date
// and an In-play owner; manual Waiting and After do not suppress work the user
// deliberately scheduled. Loose undated Tasks remain immediately available.
export function homeTasks(
  tasks: readonly Task[],
  projects: readonly Project[],
  today: string,
): Task[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return tasks
    .filter((task) => task.completedAt == null)
    .filter((task) => {
      if (task.projectId == null) {
        return task.showUpDate == null || task.showUpDate <= today;
      }
      if (task.showUpDate == null || task.showUpDate > today) return false;
      return projectsById.get(task.projectId)?.state === "in-play";
    })
    .sort(compareByOrder);
}
