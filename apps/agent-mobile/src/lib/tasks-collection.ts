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

// REST-backed test adapter for screen tests. Production screens use the
// TinyBase APIs exposed by todo-data-context.
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

export const resetTasksApiForTest = tasks.resetForTest;
export const useRestTasksApiForTest = tasks.useApi;
