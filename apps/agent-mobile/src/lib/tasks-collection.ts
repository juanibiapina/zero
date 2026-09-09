import { createTasksApi, type TasksApi, type TasksRest } from '@zero/agent-core';

import {
  addTask,
  completeTask,
  fetchTasks,
  reopenTask,
  setTaskTakenOn,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';

// The mobile Task data layer: the shared factory bound to the Clerk token. No
// screen reads it today (the Today tab is parked, see docs/todo-app.md); it is
// wired like the others so un-parking it is a screen, not plumbing. The
// mechanics (singleton, token ref, offline SQLite + outbox, jest fallback) are
// in ./entity-api.
function makeRest(getToken: TokenGetter): TasksRest {
  return {
    fetchTasks: () => fetchTasks(getToken),
    addTask: (task) => addTask(getToken, task),
    completeTask: (id) => completeTask(getToken, id),
    reopenTask: (id) => reopenTask(getToken, id),
    setTaskTakenOn: (id, takenOnAt) => setTaskTakenOn(getToken, id, takenOnAt),
  };
}

const tasks = defineMobileEntityApi<TasksApi, TasksRest>({
  create: createTasksApi,
  makeRest,
});

export const getMobileTasksApi = tasks.get;
export const setTasksTokenGetter = tasks.setTokenGetter;
export const resetTasksApiForTest = tasks.resetForTest;
export const useTasksApi = tasks.useApi;
