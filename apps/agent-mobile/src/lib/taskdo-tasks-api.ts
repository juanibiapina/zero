import { useAuth } from '@clerk/expo';
import { createCollection, safeRandomUUID } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useQueryClient } from '@tanstack/react-query';
import { advance, type Recurrence } from '@zeroapps/recurrence';
import { localToday, orderKeyBetween, type Project, type ProjectAttention, type ProjectsApi,
  type Task, type TasksApi, type WaitsApi } from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MergeableStore } from 'tinybase';

import { openTaskDOReplica } from './taskdo-replica';
import { projectFixture, type FixtureSnapshot, type Recovery } from './taskdo-projection';

type Replica = Awaited<ReturnType<typeof openTaskDOReplica>>;
type FixtureApis = { api: TasksApi; projectsApi: ProjectsApi; waitsApi: WaitsApi };
const noError = () => null;
const noErrorSubscription = () => () => {};
const noRefetch = async () => {};
const empty: FixtureSnapshot = { tasks: [], projects: [], conditions: [], recoveries: [] };

function put(store: MergeableStore, table: string, id: string, key: string, value: string | boolean | null | undefined) {
  if (value == null) store.delCell(table, id, key);
  else store.setCell(table, id, key, value);
}
function requireProject(store: MergeableStore, id: string | null): void {
  if (id && (!store.hasRow('projects', id) || store.getCell('projects', id, 'deletedAt'))) {
    throw new Error('Project was deleted or is not on this device');
  }
}
function transitionProject(store: MergeableStore, id: string, state: Project['state']) {
  const previous = store.getCell('projects', id, 'state');
  if (previous === state) return;
  put(store, 'projects', id, 'state', state);
  if (previous !== 'done' && state !== 'done') return;
  for (const [conditionId, row] of Object.entries(store.getTable('conditions'))) {
    if (row.kind !== 'project-status' || row.refId !== id) continue;
    if (state === 'done' && !row.resolvedAt) {
      put(store, 'conditions', conditionId, 'resolvedAt', new Date().toISOString());
      put(store, 'conditions', conditionId, 'settledByTarget', true);
    } else if (previous === 'done' && state !== 'done' && row.settledByTarget === true) {
      put(store, 'conditions', conditionId, 'resolvedAt', null);
      put(store, 'conditions', conditionId, 'settledByTarget', null);
    }
  }
}

export function useTaskDOFixtureTasks(): {
  api: TasksApi | null; projectsApi: ProjectsApi | null; waitsApi: WaitsApi | null;
  error: string | null; connected: boolean; recoveries: FixtureSnapshot['recoveries'];
  repair: (recovery: Recovery) => Promise<void>; ready: boolean;
} {
  const { userId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const tokenRef = useRef(getToken);
  useEffect(() => { tokenRef.current = getToken; }, [getToken]);
  const currentToken = useCallback(() => tokenRef.current(), []);
  const replicaRef = useRef<Replica | null>(null);
  const snapshotRef = useRef<FixtureSnapshot>(empty);
  const [readyUserId, setReadyUserId] = useState<string | null>(null);
  const [projection, setProjection] = useState<{ userId: string | null; apis: FixtureApis } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<FixtureSnapshot['recoveries']>([]);
  const keys = useMemo(() => ({
    tasks: ['taskdo-fixture-tasks', userId],
    projects: ['taskdo-fixture-projects', userId],
    conditions: ['taskdo-fixture-waits', userId],
  }), [userId]);

  useEffect(() => {
    const replica = () => {
      if (!replicaRef.current) throw new Error('Local todo data is not ready');
      return replicaRef.current;
    };
    const tasks = createCollection(queryCollectionOptions({
      queryClient, queryKey: keys.tasks,
      queryFn: async () => snapshotRef.current.tasks,
      getKey: (task: Task) => task.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          const task = mutation.modified;
          await replica().write((store) => {
            requireProject(store, task.projectId);
            if (store.hasRow('tasks', task.id)) {
              if (!store.getCell('tasks', task.id, 'completedAt')) throw new Error('Task id already exists');
              store.delCell('tasks', task.id, 'completedAt');
              if (task.recurrenceDate) put(store, 'tasks', task.id, 'recurrenceDate', task.recurrenceDate);
              put(store, 'tasks', task.id, 'showUpDate', task.showUpDate);
              return;
            }
            const existingKeys = Object.values(store.getTable('tasks'))
              .flatMap((row) => typeof row.sortKey === 'string' ? [row.sortKey] : []).sort().reverse();
            let sortKey = orderKeyBetween(null, null);
            for (const key of existingKeys) {
              try { sortKey = orderKeyBetween(key, null); break; } catch { /* Keep invalid raw keys intact. */ }
            }
            store.setRow('tasks', task.id, {
              text: task.text, createdAt: task.createdAt,
              sortKey: task.sortKey ?? sortKey,
              ...(task.showUpDate ? { showUpDate: task.showUpDate } : {}),
              ...(task.projectId ? { projectId: task.projectId } : {}),
              ...(task.sourceCaptureId ? { sourceCaptureId: task.sourceCaptureId } : {}),
              ...(task.recurrence ? { recurrence: JSON.stringify(task.recurrence) } : {}),
              ...(task.recurrenceDate ? { recurrenceDate: task.recurrenceDate } : {}),
            });
          });
        }
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await replica().write((store) => {
            const id = mutation.modified.id;
            if (!store.hasRow('tasks', id)) throw new Error('Task not found');
            if (('completedAt' in mutation.changes || 'recurrenceDate' in mutation.changes) &&
              projectFixture(store).recoveries.some((issue) => issue.table === 'tasks' && issue.id === id &&
                issue.reason === 'Invalid recurrence')) throw new Error('Recover the invalid recurrence before completing this Task');
            if ('projectId' in mutation.changes) requireProject(store, mutation.modified.projectId);
            for (const key of Object.keys(mutation.changes) as (keyof Task)[]) {
              if (key === 'id' || key === 'createdAt') continue;
              const value = mutation.modified[key];
              if (key === 'recurrence') put(store, 'tasks', id, key, value ? JSON.stringify(value) : null);
              else put(store, 'tasks', id, key, value as string | null | undefined);
            }
          });
        }
        return { refetch: false };
      },
    }));
    const projects = createCollection(queryCollectionOptions({
      queryClient, queryKey: keys.projects,
      queryFn: async () => snapshotRef.current.projects,
      getKey: (project: Project) => project.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          const project = mutation.modified;
          if (store.hasRow('projects', project.id)) {
            requireProject(store, project.id);
            if (store.getCell('projects', project.id, 'state') !== 'done') throw new Error('Project id already exists');
            transitionProject(store, project.id, project.state);
            return;
          }
          store.setRow('projects', project.id, {
            title: project.title, icon: project.icon, state: project.state, createdAt: project.createdAt,
            ...(project.description ? { description: project.description } : {}),
            ...(project.sourceCaptureId ? { sourceCaptureId: project.sourceCaptureId } : {}),
          });
        });
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          const id = mutation.modified.id;
          requireProject(store, id);
          for (const key of Object.keys(mutation.changes) as (keyof Project)[]) {
            if (key === 'id' || key === 'createdAt' || key === 'state') continue;
            put(store, 'projects', id, key, mutation.modified[key] as string | null | undefined);
          }
          if ('state' in mutation.changes) transitionProject(store, id, mutation.modified.state);
        });
        return { refetch: false };
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          const id = mutation.original.id;
          requireProject(store, id);
          put(store, 'projects', id, 'deletedAt', new Date().toISOString());
          for (const [taskId, row] of Object.entries(store.getTable('tasks'))) {
            if (row.projectId === id) store.delRow('tasks', taskId);
          }
          for (const [conditionId, row] of Object.entries(store.getTable('conditions'))) {
            if (row.projectId === id || row.refId === id) store.delRow('conditions', conditionId);
          }
        });
        return { refetch: false };
      },
    }));
    const waits = createCollection(queryCollectionOptions({
      queryClient, queryKey: keys.conditions,
      queryFn: async () => snapshotRef.current.conditions,
      getKey: (condition: ProjectAttention) => condition.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          const condition = mutation.modified;
          requireProject(store, condition.projectId);
          if (store.hasRow('conditions', condition.id)) throw new Error('Condition id already exists');
          if (condition.kind === 'project-status') {
            requireProject(store, condition.refId);
            if (condition.projectId === condition.refId) throw new Error('A Project cannot be after itself');
            if (store.getCell('projects', condition.refId, 'state') === 'done') throw new Error('Target Project is Done');
            const openAfters = projectFixture(store).conditions.filter((row) => row.kind === 'project-status');
            if (openAfters.some((edge) => edge.projectId === condition.projectId && edge.refId === condition.refId)) {
              throw new Error('After relationship already exists');
            }
            const pending = [condition.refId];
            const seen = new Set<string>();
            while (pending.length) {
              const id = pending.pop()!;
              if (id === condition.projectId) throw new Error('After relationship would create a cycle');
              if (seen.has(id)) continue;
              seen.add(id);
              pending.push(...openAfters.filter((edge) => edge.projectId === id).map((edge) => edge.refId));
            }
          }
          store.setRow('conditions', condition.id, {
            projectId: condition.projectId, kind: condition.kind, createdAt: condition.createdAt,
            ...(condition.kind === 'free-text'
              ? { text: condition.text }
              : { refId: condition.refId, targetStatus: 'done' }),
          });
        });
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          if (!store.hasRow('conditions', mutation.modified.id)) throw new Error('Condition not found');
          put(store, 'conditions', mutation.modified.id, 'resolvedAt', mutation.modified.resolvedAt);
        });
        return { refetch: false };
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) await replica().write((store) => {
          store.delRow('conditions', mutation.original.id);
        });
        return { refetch: false };
      },
    }));
    const apis: FixtureApis = {
      api: {
        collection: tasks,
        add: (text, showUpDate = null, projectId = null, sourceCaptureId = null, recurrence = null) =>
          tasks.insert({ id: safeRandomUUID(), text, createdAt: new Date().toISOString(),
            showUpDate: recurrence?.origin ?? showUpDate, projectId, sourceCaptureId, recurrence,
            recurrenceDate: recurrence?.origin ?? null, completedAt: null, sortKey: null }),
        edit: (id, text) => tasks.update(id, (draft) => { draft.text = text; }),
        complete: (id, completedOn = localToday()) => tasks.update(id, (draft) => {
          if (draft.recurrence && draft.recurrenceDate) {
            const next = advance(draft.recurrence, { scheduledOn: draft.recurrenceDate, completedOn });
            if (next.kind === 'next') {
              draft.recurrenceDate = next.scheduledOn;
              draft.showUpDate = next.scheduledOn;
              return;
            }
          }
          draft.completedAt = new Date().toISOString();
        }),
        completeForever: (id) => tasks.update(id, (draft) => { draft.completedAt = new Date().toISOString(); }),
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
        offline: true, refetch: noRefetch, getLoadError: noError, subscribeLoadError: noErrorSubscription,
      },
      projectsApi: {
        collection: projects,
        add: (title, sourceCaptureId = null) => projects.insert({ id: safeRandomUUID(), title, icon: '📁',
          description: null, state: 'in-play', createdAt: new Date().toISOString(), sourceCaptureId }),
        edit: (id, fields) => projects.update(id, (draft) => { Object.assign(draft, fields); }),
        setState: (id, state) => projects.update(id, (draft) => { draft.state = state; }),
        reopen: (project) => projects.get(project.id)
          ? projects.update(project.id, (draft) => { draft.state = project.state; })
          : projects.insert({ ...project }),
        remove: (id) => projects.delete(id),
        offline: true, refetch: noRefetch, getLoadError: noError, subscribeLoadError: noErrorSubscription,
      },
      waitsApi: {
        collection: waits,
        addWaiting: (projectId, text) => waits.insert({ id: safeRandomUUID(), projectId,
          kind: 'free-text', text, refId: null, targetStatus: null,
          resolvedAt: null, createdAt: new Date().toISOString() }),
        addAfter: (projectId, refId) => waits.insert({ id: safeRandomUUID(), projectId,
          kind: 'project-status', text: null, refId, targetStatus: 'done',
          resolvedAt: null, createdAt: new Date().toISOString() }),
        resolveWaiting: (id) => waits.update(id, (draft) => { draft.resolvedAt = new Date().toISOString(); }),
        remove: (id) => waits.delete(id),
        offline: true, refetch: noRefetch, getLoadError: noError, subscribeLoadError: noErrorSubscription,
      },
    };
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setProjection({ userId: userId ?? null, apis }); });
    return () => {
      cancelled = true;
      void Promise.all([tasks.cleanup(), projects.cleanup(), waits.cleanup()]);
    };
  }, [queryClient, keys, userId]);

  useEffect(() => {
    let cancelled = false;
    let opened: Replica | undefined;
    if (!userId) return;
    void openTaskDOReplica(userId, currentToken, (snapshot) => {
      if (cancelled) return;
      snapshotRef.current = snapshot;
      setRecoveries(snapshot.recoveries);
      queryClient.setQueryData(keys.tasks, snapshot.tasks);
      queryClient.setQueryData(keys.projects, snapshot.projects);
      queryClient.setQueryData(keys.conditions, snapshot.conditions);
    }, (live) => {
      if (!cancelled) setConnected(live);
    }).then((handle) => {
      opened = handle;
      if (cancelled) void handle.close();
      else { replicaRef.current = handle; setReadyUserId(userId); }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(String(cause));
    });
    return () => {
      cancelled = true;
      replicaRef.current = null;
      if (opened) void opened.close();
    };
  }, [userId, currentToken, queryClient, keys]);

  const apis = projection && projection.userId === userId && readyUserId === userId ? projection.apis : null;
  const repair = useCallback(async (recovery: Recovery) => {
    const replica = replicaRef.current;
    if (!replica) throw new Error('Local todo data is not ready');
    await replica.repair(recovery);
  }, []);
  return { api: apis?.api ?? null, projectsApi: apis?.projectsApi ?? null,
    waitsApi: apis?.waitsApi ?? null, ready: !!apis, error, connected, recoveries, repair };
}
