import { useAuth } from '@clerk/expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskdoReplicaClientState } from '@zero/agent-core';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { TokenGetter } from './api';
import { RUNTIME_PROFILE } from './runtime-profile';
import { openTaskDOReplica } from './taskdo-replica';
import { createTodoWorkspaceRegistry } from './todo-workspace';
import {
  createTodoWorkspaceOwner,
  selectTodoWorkspaceOwnerState,
} from './todo-workspace-owner';

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
  const [owner] = useState(() => createTodoWorkspaceOwner({
    registry: workspace,
    open: async (descriptor, events) => openTaskDOReplica({
      descriptor,
      getToken: tokenSource.getToken,
      queryClient,
      onSnapshot: events.onSnapshot,
      onConnection: events.onConnection,
      onDurability: events.onDurability,
    }),
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  useEffect(() => {
    void owner.setAccount(userId ?? null);
  }, [owner, userId]);
  useEffect(() => () => { void owner.close(); }, [owner]);

  return selectTodoWorkspaceOwnerState(state, userId ?? null);
}
