import { useAuth } from '@clerk/expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import {
  createAccountTaskdoReplicaOwner,
  selectAccountTaskdoReplicaState,
  type TaskdoReplicaClientState,
} from '@zero/agent-core';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { TokenGetter } from './api';
import { RUNTIME_PROFILE } from './runtime-profile';
import { openTaskDOReplica } from './taskdo-replica';
import { createTodoWorkspaceRegistry } from './todo-workspace';

export type TodoData = TaskdoReplicaClientState;

class CurrentTokenSource {
  constructor(private current: TokenGetter) {}

  readonly getToken: TokenGetter = () => this.current();

  update(getToken: TokenGetter) {
    this.current = getToken;
  }
}

export function useTodoData(): TodoData {
  const { userId, getToken } = useAuth();
  const queryClient = useQueryClient();
  const [tokenSource] = useState(() => new CurrentTokenSource(getToken));
  useEffect(() => { tokenSource.update(getToken); }, [getToken, tokenSource]);
  const [workspace] = useState(() => createTodoWorkspaceRegistry({
    storage: AsyncStorage,
    storageKey: RUNTIME_PROFILE.storageKeys.todoWorkspaceKey,
  }));
  const [owner] = useState(() => createAccountTaskdoReplicaOwner({
    open: async (accountId, events) => {
      const descriptor = await workspace.forSignedInAccount(accountId);
      return {
        replica: await openTaskDOReplica(
          descriptor.databaseName,
          accountId,
          tokenSource.getToken,
          queryClient,
          events.onSnapshot,
          events.onConnection,
        ),
        durability: { durable: true, error: null },
      };
    },
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  useEffect(() => {
    void owner.setAccount(userId ?? null);
    return () => { void owner.setAccount(null); };
  }, [owner, userId]);

  return selectAccountTaskdoReplicaState(state, userId ?? null);
}
