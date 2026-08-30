import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";
import { startOfflineExecutor } from "@tanstack/offline-transactions";
import { createTasksApi, type TasksApi } from "@zero/agent-core";

import { queryClient } from "./captures-collection";
import { addTask, completeTask, fetchTasks } from "./tasks";

export type { TasksApi };

// Its own OPFS database file, separate from the Inbox's, so the two entities
// never share a table.
const DATABASE_NAME = "zero-today.sqlite";

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
      persistence: async () => {
        const database = await openBrowserWASQLiteOPFSDatabase({
          databaseName: DATABASE_NAME,
        });
        return createBrowserWASQLitePersistence({ database });
      },
      startOfflineExecutor,
      onWarn: (message, error) => console.warn(message, error),
    });
  }
  return apiPromise;
}
