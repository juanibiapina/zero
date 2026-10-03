import { useAuth } from '@clerk/expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskdoReplicaClientState } from '@zero/agent-core';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import type { TokenGetter } from './api';
import { RUNTIME_PROFILE } from './runtime-profile';
import {
  clearMobileAccountCaches,
  deleteTodoWorkspaceDatabase,
} from './mobile-account-cleanup';
import { openTaskDOReplica } from './taskdo-replica';
import { attachMedicineReminders } from './medicine-reminders';
import { createTodoWorkspaceRegistry } from './todo-workspace';
import {
  createTodoWorkspaceOwner,
  selectTodoWorkspaceOwnerState,
} from './todo-workspace-owner';

export type TodoData = TaskdoReplicaClientState & {
  workspaceStatus: 'opening' | 'guest' | 'account' | 'locked' | 'mismatch' | 'signing-out';
  signedIn: boolean;
  signOut: () => Promise<void>;
  discardLocalCopyAndSignOut: () => Promise<void>;
  signOutWrongAccount: () => Promise<void>;
  deleteLocalCopyAndContinue: () => Promise<void>;
};

class CurrentTokenSource {
  constructor(private current: TokenGetter) {}

  readonly getToken: TokenGetter = () => this.current();

  update(getToken: TokenGetter) {
    this.current = getToken;
  }
}

class CurrentSignOutSource {
  constructor(private current: () => Promise<void>) {}

  readonly signOut = () => this.current();

  update(signOut: () => Promise<void>) {
    this.current = signOut;
  }
}

export function useTodoData(): TodoData {
  const { userId, getToken, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [tokenSource] = useState(() => new CurrentTokenSource(getToken));
  useEffect(() => { tokenSource.update(getToken); }, [getToken, tokenSource]);
  const [signOutSource] = useState(() => new CurrentSignOutSource(signOut));
  useEffect(() => { signOutSource.update(signOut); }, [signOut, signOutSource]);
  const [workspace] = useState(() => createTodoWorkspaceRegistry({
    storage: AsyncStorage,
    storageKey: RUNTIME_PROFILE.storageKeys.todoWorkspaceKey,
    createWorkspaceId: RUNTIME_PROFILE.todoWorkspaceId
      ? () => RUNTIME_PROFILE.todoWorkspaceId!
      : undefined,
  }));
  const [owner] = useState(() => createTodoWorkspaceOwner({
    registry: workspace,
    open: async (descriptor, events) => attachMedicineReminders(await openTaskDOReplica({
      descriptor,
      getToken: tokenSource.getToken,
      queryClient,
      onSnapshot: events.onSnapshot,
      onConnection: events.onConnection,
      onSyncState: events.onSyncState,
      onDurability: events.onDurability,
    }), descriptor.databaseName),
    deleteDatabase: deleteTodoWorkspaceDatabase,
    clearAccountCaches: (accountId) => clearMobileAccountCaches(accountId, queryClient),
    signOut: signOutSource.signOut,
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  useEffect(() => {
    void owner.setAccount(userId ?? null);
  }, [owner, userId]);
  useEffect(() => () => { void owner.close(); }, [owner]);

  const signOutSafely = useCallback(() => owner.signOut(), [owner]);
  const discardLocalCopyAndSignOut = useCallback(
    () => owner.signOut({ discardLocalCopy: true }),
    [owner],
  );
  const signOutWrongAccount = useCallback(
    () => owner.signOutMismatchedAccount(),
    [owner],
  );
  const deleteLocalCopyAndContinue = useCallback(
    () => owner.deleteMismatchedWorkspace(),
    [owner],
  );
  const expectedAccountId = userId ?? null;
  const clientState = selectTodoWorkspaceOwnerState(state, expectedAccountId);
  const workspaceStatus = state.accountId === expectedAccountId && state.status !== 'closed'
    ? state.status
    : 'opening';
  return {
    ...clientState,
    workspaceStatus,
    signedIn: userId !== null && userId !== undefined,
    signOut: signOutSafely,
    discardLocalCopyAndSignOut,
    signOutWrongAccount,
    deleteLocalCopyAndContinue,
  };
}
