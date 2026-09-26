import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  type TaskdoReplica,
  type TodoSnapshot,
} from '@zero/agent-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openTaskDOReplica } from './taskdo-replica';

type Replica = Awaited<ReturnType<typeof openTaskDOReplica>>;

export type TodoData = {
  replica: TaskdoReplica | null;
  error: string | null;
  connected: boolean;
  durable: boolean;
  recoveries: TodoSnapshot['recoveries'];
  ready: boolean;
};

export function useTodoData(): TodoData {
  const { userId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const tokenRef = useRef(getToken);
  useEffect(() => { tokenRef.current = getToken; }, [getToken]);
  const currentToken = useCallback(() => tokenRef.current(), []);
  const [replica, setReplica] = useState<{ userId: string; value: TaskdoReplica } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<TodoSnapshot['recoveries']>([]);

  useEffect(() => {
    let cancelled = false;
    let opened: Replica | undefined;
    if (!userId) return;

    void openTaskDOReplica(
      userId,
      currentToken,
      queryClient,
      (snapshot) => {
        if (!cancelled) setRecoveries(snapshot.recoveries);
      },
      (live) => {
        if (!cancelled) setConnected(live);
      },
    ).then((handle) => {
      opened = handle;
      if (cancelled) void handle.close();
      else {
        setReplica({ userId, value: handle });
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(String(cause));
    });

    return () => {
      cancelled = true;
      if (opened) void opened.close();
    };
  }, [userId, currentToken, queryClient]);

  const active = replica && replica.userId === userId ? replica.value : null;
  return {
    replica: active,
    ready: !!active,
    error,
    connected,
    durable: true,
    recoveries,
  };
}
