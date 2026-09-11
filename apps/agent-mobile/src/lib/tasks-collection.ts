import { createTasksApi, type TasksApi, type TasksRest } from '@zero/agent-core';

import {
  addTask,
  completeTask,
  editTask,
  fetchTasks,
  reopenTask,
  reorderTask,
  rescheduleTask,
  setTaskTakenOn,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';

// The mobile Task data layer: the shared factory bound to the Clerk token, as
// one app-lifetime singleton read by Home and Upcoming. After the single-list
// merge Task is the app's sole entity. The mechanics (singleton, token ref,
// offline SQLite + outbox, jest fallback) are in ./entity-api.
function makeRest(getToken: TokenGetter): TasksRest {
  return {
    fetchTasks: () => fetchTasks(getToken),
    addTask: (task) => addTask(getToken, task),
    completeTask: (id) => completeTask(getToken, id),
    reopenTask: (id) => reopenTask(getToken, id),
    setTaskTakenOn: (id, takenOnAt) => setTaskTakenOn(getToken, id, takenOnAt),
    editTask: (id, text) => editTask(getToken, id, text),
    rescheduleTask: (id, showUpDate) => rescheduleTask(getToken, id, showUpDate),
    reorderTask: (id, sortKey) => reorderTask(getToken, id, sortKey),
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
