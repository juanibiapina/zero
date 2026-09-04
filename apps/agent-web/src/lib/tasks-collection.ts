import { createTasksApi, type TasksApi } from "@zero/agent-core";

import { defineWebEntityApi } from "./entity-api";
import { addTask, completeTask, fetchTasks } from "./tasks";

export type { TasksApi };

// The web Task data layer, a per-tab singleton (see ./entity-api). No page
// reads it today (the Today tab is parked, see docs/todo-app.md).
export const getTasksApi = defineWebEntityApi((deps) =>
  createTasksApi({ ...deps, rest: { fetchTasks, addTask, completeTask } }),
);
