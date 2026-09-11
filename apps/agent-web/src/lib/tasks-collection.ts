import { createTasksApi, type TasksApi } from "@zero/agent-core";

import { defineWebEntityApi } from "./entity-api";
import {
  addTask,
  completeTask,
  editTask,
  fetchTasks,
  reopenTask,
  reorderTask,
  rescheduleTask,
  setTaskProject,
  setTaskTakenOn,
} from "./tasks";

export type { TasksApi };

// The web Task data layer, a per-tab singleton (see ./entity-api).
export const getTasksApi = defineWebEntityApi((deps) =>
  createTasksApi({
    ...deps,
    rest: {
      fetchTasks,
      addTask,
      completeTask,
      reopenTask,
      setTaskTakenOn,
      editTask,
      rescheduleTask,
      reorderTask,
      setTaskProject,
    },
  }),
);
