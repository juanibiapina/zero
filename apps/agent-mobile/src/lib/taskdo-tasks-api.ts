import { useAuth } from '@clerk/expo';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useQueryClient } from '@tanstack/react-query';
import { orderKeyBetween, type Project, type ProjectAttention,
  type Task, type TasksApi, type ProjectsApi, type WaitsApi } from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MergeableStore } from 'tinybase';

import { openTaskDOReplica } from './taskdo-replica';
import { projectTodoData, type TodoSnapshot, type Recovery } from './taskdo-projection';
import { createTodoApis, type TodoApis } from './todo-apis';

type Replica = Awaited<ReturnType<typeof openTaskDOReplica>>;
const empty: TodoSnapshot = { tasks: [], projects: [], conditions: [], recoveries: [] };

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

export function useTodoData(): {
  api: TasksApi | null; projectsApi: ProjectsApi | null; waitsApi: WaitsApi | null;
  error: string | null; connected: boolean; recoveries: TodoSnapshot['recoveries'];
  repair: (recovery: Recovery) => Promise<void>; ready: boolean;
} {
  const { userId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const tokenRef = useRef(getToken);
  useEffect(() => { tokenRef.current = getToken; }, [getToken]);
  const currentToken = useCallback(() => tokenRef.current(), []);
  const replicaRef = useRef<Replica | null>(null);
  const snapshotRef = useRef<TodoSnapshot>(empty);
  const [readyUserId, setReadyUserId] = useState<string | null>(null);
  const [projection, setProjection] = useState<{ userId: string | null; apis: TodoApis } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<TodoSnapshot['recoveries']>([]);
  const keys = useMemo(() => ({
    tasks: ['todo-tasks', userId],
    projects: ['todo-projects', userId],
    conditions: ['todo-waits', userId],
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
              projectTodoData(store).recoveries.some((issue) => issue.table === 'tasks' && issue.id === id &&
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
            const openAfters = projectTodoData(store).conditions.filter((row) => row.kind === 'project-status');
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
    const apis = createTodoApis({ tasks, projects, waits });
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
