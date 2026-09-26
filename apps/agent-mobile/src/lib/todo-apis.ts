import { safeRandomUUID } from '@tanstack/db';
import { advance, type Recurrence } from '@zeroapps/recurrence';
import {
  localToday,
  orderKeyBetween,
  type Project,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';

type TodoCollections = {
  tasks: TasksApi['collection'];
  projects: ProjectsApi['collection'];
  waits: WaitsApi['collection'];
};

const noError = () => null;
const noErrorSubscription = () => () => {};
const noRefetch = async () => {};

export type TodoApis = {
  api: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
};

export function createTodoApis({ tasks, projects, waits }: TodoCollections): TodoApis {
  return {
    api: {
      collection: tasks,
      add: (text, showUpDate = null, projectId = null, sourceCaptureId = null, recurrence = null) =>
        tasks.insert({
          id: safeRandomUUID(),
          text,
          createdAt: new Date().toISOString(),
          showUpDate: recurrence?.origin ?? showUpDate,
          projectId,
          sourceCaptureId,
          recurrence,
          recurrenceDate: recurrence?.origin ?? null,
          completedAt: null,
          sortKey: null,
        }),
      edit: (id, text) => tasks.update(id, (draft) => { draft.text = text; }),
      complete: (id, completedOn = localToday()) => tasks.update(id, (draft) => {
        if (draft.recurrence && draft.recurrenceDate) {
          const next = advance(draft.recurrence, {
            scheduledOn: draft.recurrenceDate,
            completedOn,
          });
          if (next.kind === 'next') {
            draft.recurrenceDate = next.scheduledOn;
            draft.showUpDate = next.scheduledOn;
            return;
          }
        }
        draft.completedAt = new Date().toISOString();
      }),
      completeForever: (id) => tasks.update(id, (draft) => {
        draft.completedAt = new Date().toISOString();
      }),
      undoOccurrence: (before) => tasks.get(before.id)
        ? tasks.update(before.id, (draft) => { Object.assign(draft, before, { completedAt: null }); })
        : tasks.insert({ ...before, completedAt: null }),
      setRecurrence: (id, recurrence: Recurrence | null) => tasks.update(id, (draft) => {
        draft.recurrence = recurrence;
        draft.recurrenceDate = recurrence?.origin ?? null;
        if (recurrence) draft.showUpDate = recurrence.origin;
      }),
      reopen: (task) => tasks.get(task.id)
        ? tasks.update(task.id, (draft) => { draft.completedAt = null; })
        : tasks.insert({ ...task, completedAt: null }),
      reschedule: (id, date) => tasks.update(id, (draft) => { draft.showUpDate = date; }),
      reorder: (id, sortKey) => tasks.update(id, (draft) => { draft.sortKey = sortKey; }),
      moveToProject: (id, projectId) => tasks.update(id, (draft) => { draft.projectId = projectId; }),
      offline: true,
      refetch: noRefetch,
      getLoadError: noError,
      subscribeLoadError: noErrorSubscription,
    },
    projectsApi: {
      collection: projects,
      add: (title, sourceCaptureId = null) => projects.insert({
        id: safeRandomUUID(),
        title,
        icon: '📁',
        description: null,
        state: 'in-play',
        createdAt: new Date().toISOString(),
        sourceCaptureId,
      }),
      edit: (id, fields) => projects.update(id, (draft) => { Object.assign(draft, fields); }),
      setState: (id, state) => projects.update(id, (draft) => { draft.state = state; }),
      reopen: (project: Project) => projects.get(project.id)
        ? projects.update(project.id, (draft) => { draft.state = project.state; })
        : projects.insert({ ...project }),
      remove: (id) => projects.delete(id),
      offline: true,
      refetch: noRefetch,
      getLoadError: noError,
      subscribeLoadError: noErrorSubscription,
    },
    waitsApi: {
      collection: waits,
      addWaiting: (projectId, text) => waits.insert({
        id: safeRandomUUID(),
        projectId,
        kind: 'free-text',
        text,
        refId: null,
        targetStatus: null,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      }),
      addAfter: (projectId, refId) => waits.insert({
        id: safeRandomUUID(),
        projectId,
        kind: 'project-status',
        text: null,
        refId,
        targetStatus: 'done',
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      }),
      resolveWaiting: (id) => waits.update(id, (draft) => {
        draft.resolvedAt = new Date().toISOString();
      }),
      remove: (id) => waits.delete(id),
      offline: true,
      refetch: noRefetch,
      getLoadError: noError,
      subscribeLoadError: noErrorSubscription,
    },
  };
}
