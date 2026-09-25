import { useAuth } from '@clerk/expo';
import { createCollection, safeRandomUUID } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useQueryClient } from '@tanstack/react-query';
import type { Task, TasksApi } from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { openTaskDOReplica, type LooseTask } from './taskdo-replica';

type Replica = Awaited<ReturnType<typeof openTaskDOReplica>>;

const asTask = (row: LooseTask): Task => ({
  ...row,
  completedAt: null,
  recurrence: null,
  recurrenceDate: null,
  projectId: null,
  sourceCaptureId: null,
  sortKey: null,
});

const unsupported = (): never => {
  throw new Error('Only loose Task create and text edit work in this fixture');
};

export function useTaskDOFixtureTasks(): {
  api: TasksApi | null;
  error: string | null;
  connected: boolean;
} {
  const { userId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const tokenRef = useRef(getToken);
  useEffect(() => { tokenRef.current = getToken; }, [getToken]);
  const currentToken = useCallback(() => tokenRef.current(), []);
  const replicaRef = useRef<Replica | null>(null);
  const snapshotRef = useRef<Task[]>([]);
  const [readyUserId, setReadyUserId] = useState<string | null>(null);
  const [projection, setProjection] = useState<{ userId: string | null; api: TasksApi } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryKey = useMemo(() => ['taskdo-fixture-tasks', userId], [userId]);

  useEffect(() => {
    const collection = createCollection(queryCollectionOptions({
      queryClient,
      queryKey,
      queryFn: async () => snapshotRef.current,
      getKey: (task: Task) => task.id,
      onInsert: async ({ transaction }) => {
        const replica = replicaRef.current;
        if (!replica) throw new Error('Local Tasks are not ready');
        for (const mutation of transaction.mutations) {
          const task = mutation.modified;
          if (task.projectId !== null || task.recurrence !== null || task.sourceCaptureId !== null) unsupported();
          await replica.add(task.id, task.text, task.createdAt, task.showUpDate);
        }
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        const replica = replicaRef.current;
        if (!replica) throw new Error('Local Tasks are not ready');
        for (const mutation of transaction.mutations) {
          if (Object.keys(mutation.changes).some((key) => key !== 'text')) unsupported();
          await replica.edit(mutation.modified.id, mutation.modified.text);
        }
        return { refetch: false };
      },
    }));
    const created: TasksApi = {
      collection,
      add: (text, showUpDate = null, projectId = null, sourceCaptureId = null, recurrence = null) => {
        if (projectId !== null || sourceCaptureId !== null || recurrence !== null) unsupported();
        return collection.insert({
          id: safeRandomUUID(), text, createdAt: new Date().toISOString(),
          showUpDate, projectId: null, sourceCaptureId: null, recurrence: null,
          recurrenceDate: null, completedAt: null, sortKey: null,
        });
      },
      edit: (id, text) => collection.update(id, (draft) => { draft.text = text; }),
      complete: unsupported,
      completeForever: unsupported,
      undoOccurrence: unsupported,
      setRecurrence: unsupported,
      reopen: unsupported,
      reschedule: unsupported,
      reorder: unsupported,
      moveToProject: unsupported,
      offline: true,
      refetch: async () => {},
      getLoadError: () => null,
      subscribeLoadError: () => () => {},
    };
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setProjection({ userId: userId ?? null, api: created }); });
    return () => {
      cancelled = true;
      void collection.cleanup();
    };
  }, [queryClient, queryKey, userId]);

  useEffect(() => {
    let cancelled = false;
    let opened: Replica | undefined;
    if (!userId) return;
    void openTaskDOReplica(userId, currentToken, (rows) => {
      if (cancelled) return;
      snapshotRef.current = rows.map(asTask);
      queryClient.setQueryData(queryKey, snapshotRef.current);
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
  }, [userId, currentToken, queryClient, queryKey]);

  return {
    api: userId && readyUserId === userId && projection?.userId === userId ? projection.api : null,
    error,
    connected,
  };
}
