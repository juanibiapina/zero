import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import {
  createAccountTaskdoReplicaOwner,
  type AccountTaskdoReplicaState,
} from '@zero/agent-core';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { TokenGetter } from './api';
import { openTaskDOReplica } from './taskdo-replica';

export type TodoData = Omit<AccountTaskdoReplicaState, 'accountId' | 'durabilityError'>;

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
  const [owner] = useState(() => createAccountTaskdoReplicaOwner({
    open: async (accountId, events) => ({
      replica: await openTaskDOReplica(
        accountId,
        tokenSource.getToken,
        queryClient,
        events.onSnapshot,
        events.onConnection,
      ),
      durability: { durable: true, error: null },
    }),
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  useEffect(() => {
    void owner.setAccount(userId ?? null);
    return () => { void owner.setAccount(null); };
  }, [owner, userId]);

  const active = state.accountId === (userId ?? null) ? state : null;
  return {
    replica: active?.replica ?? null,
    ready: active?.ready ?? false,
    error: active?.error ?? null,
    connected: active?.connected ?? false,
    durable: active?.durable ?? true,
    recoveries: active?.recoveries ?? [],
  };
}
