import { createTasksApi, type TasksApi, type TasksRest } from '@zero/agent-core';

import {
  addTask,
  completeTask,
  completeTaskOccurrence,
  editTask,
  fetchTasks,
  reopenTask,
  reorderTask,
  rescheduleTask,
  setTaskProject,
  setTaskRecurrence,
  undoTaskOccurrence,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';
import { RUNTIME_PROFILE } from './runtime-profile';
import { useTaskDOFixtureContext } from './taskdo-fixture-context';

// The mobile Task data layer: the shared factory bound to the Clerk token, as
// one app-lifetime singleton read by Home and Upcoming. After the single-list
// merge Task is the app's sole entity. The mechanics (singleton, token ref,
// offline SQLite + outbox, jest fallback) are in ./entity-api.
function makeRest(getToken: TokenGetter): TasksRest {
  return {
    fetchTasks: () => fetchTasks(getToken),
    addTask: (task) => addTask(getToken, task),
    completeTask: (id) => completeTask(getToken, id),
    completeTaskOccurrence: (id, event) =>
      completeTaskOccurrence(getToken, id, event),
    undoTaskOccurrence: (id, event) =>
      undoTaskOccurrence(getToken, id, event),
    setTaskRecurrence: (id, recurrence) =>
      setTaskRecurrence(getToken, id, recurrence),
    reopenTask: (id) => reopenTask(getToken, id),
    editTask: (id, text) => editTask(getToken, id, text),
    rescheduleTask: (id, showUpDate) => rescheduleTask(getToken, id, showUpDate),
    reorderTask: (id, sortKey) => reorderTask(getToken, id, sortKey),
    setTaskProject: (id, projectId) => setTaskProject(getToken, id, projectId),
  };
}

const tasks = defineMobileEntityApi<TasksApi, TasksRest>({
  create: createTasksApi,
  makeRest,
});

export const getMobileTasksApi = tasks.get;
export const setTasksTokenGetter = tasks.setTokenGetter;
export const resetTasksApiForTest = tasks.resetForTest;
export const useTasksApi: () => TasksApi | null =
  RUNTIME_PROFILE.hermetic && process.env.EXPO_PUBLIC_TASKDO_PROOF === '1'
    ? () => useTaskDOFixtureContext()?.api ?? null
    : tasks.useApi;
