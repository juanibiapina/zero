import { startOfflineExecutor } from "@tanstack/offline-transactions";
import { createTasksApi, type TasksApi } from "@zero/agent-core";

import { queryClient } from "./captures-collection";
import { getAppPersistence } from "./db";
import { addTask, completeTask, fetchTasks } from "./tasks";

export type { TasksApi };

let apiPromise: Promise<TasksApi> | null = null;

// Singleton: the OPFS database and outbox are opened once per tab. Falls back to
// the in-memory Query Collection if durable persistence cannot start (private
// browsing, older browsers). Web auth is the same-origin cookie, so the REST
// closures carry no token.
export function getTasksApi(): Promise<TasksApi> {
  if (!apiPromise) {
    apiPromise = createTasksApi({
      queryClient,
      rest: { fetchTasks, addTask, completeTask },
      persistence: () => getAppPersistence(),
      startOfflineExecutor,
      onWarn: (message, error) => console.warn(message, error),
    });
  }
  return apiPromise;
}
