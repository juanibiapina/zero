import type {
  TaskdoReplica,
  TaskdoReplicaClientState,
  TaskdoSyncState,
  TodoSnapshot,
} from '@zero/agent-core';

import type {
  TodoWorkspaceDescriptor,
  TodoWorkspaceRegistry,
} from './todo-workspace';
import { TodoWorkspaceAccessError } from './todo-workspace';

export type TodoWorkspaceOwnerStatus =
  | 'opening'
  | 'guest'
  | 'account'
  | 'locked'
  | 'mismatch'
  | 'signing-out'
  | 'closed';

export type TodoWorkspaceOwnerState = TaskdoReplicaClientState & {
  accountId: string | null;
  status: TodoWorkspaceOwnerStatus;
};

const EMPTY_CLIENT_STATE: TaskdoReplicaClientState = {
  replica: null,
  ready: false,
  connected: false,
  sync: { phase: 'offline', lastSyncedAt: null },
  durable: true,
  error: null,
  durabilityError: null,
  recoveries: [],
};

const errorMessage = (cause: unknown) => (
  cause instanceof Error ? cause.message : String(cause)
);

type TodoWorkspaceReplicaEvents = {
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onSyncState: (sync: TaskdoSyncState) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

type CreateTodoWorkspaceOwnerOptions = {
  registry: TodoWorkspaceRegistry;
  open: (
    descriptor: TodoWorkspaceDescriptor,
    events: TodoWorkspaceReplicaEvents,
  ) => Promise<TaskdoReplica>;
  deleteDatabase?: (databaseName: string) => Promise<void>;
  clearAccountCaches?: (accountId: string) => Promise<void>;
  signOut?: () => Promise<void>;
};

type CheckpointableReplica = TaskdoReplica & {
  checkpoint?: () => Promise<void>;
};

function emptyState(
  accountId: string | null,
  status: TodoWorkspaceOwnerStatus,
): TodoWorkspaceOwnerState {
  return {
    accountId,
    status,
    ...EMPTY_CLIENT_STATE,
  };
}

export function selectTodoWorkspaceOwnerState(
  state: TodoWorkspaceOwnerState,
  expectedAccountId: string | null,
): TaskdoReplicaClientState {
  if (state.accountId !== expectedAccountId) return EMPTY_CLIENT_STATE;
  const { accountId: _accountId, status: _status, ...clientState } = state;
  return clientState;
}

export function createTodoWorkspaceOwner({
  registry,
  open,
  deleteDatabase,
  clearAccountCaches,
  signOut: signOutAccount,
}: CreateTodoWorkspaceOwnerOptions) {
  let state = emptyState(null, 'opening');
  let active: { descriptor: TodoWorkspaceDescriptor; replica: CheckpointableReplica } | null = null;
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;
  let stopped = false;
  let closing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const closeAttempted = new Set<TaskdoReplica>();

  const publish = (next: TodoWorkspaceOwnerState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const isCurrent = (accountId: string | null, ownerGeneration: number) => (
    !stopped
    && generation === ownerGeneration
    && state.accountId === accountId
  );

  const closeReplica = async (replica: TaskdoReplica) => {
    if (closeAttempted.has(replica)) return;
    closeAttempted.add(replica);
    await replica.close();
  };

  const openDescriptor = async (
    accountId: string | null,
    descriptor: TodoWorkspaceDescriptor,
    ownerGeneration: number,
  ) => {
    const events: TodoWorkspaceReplicaEvents = {
      onSnapshot(snapshot) {
        if (!isCurrent(accountId, ownerGeneration)) return;
        publish({ ...state, recoveries: snapshot.recoveries });
      },
      onConnection(connected) {
        if (!isCurrent(accountId, ownerGeneration)) return;
        publish({ ...state, connected });
      },
      onSyncState(sync) {
        if (!isCurrent(accountId, ownerGeneration)) return;
        publish({ ...state, sync });
      },
      onDurability(durable, error) {
        if (!isCurrent(accountId, ownerGeneration)) return;
        publish({ ...state, durable, durabilityError: error });
      },
    };
    const opened = await open(descriptor, events);
    if (!isCurrent(accountId, ownerGeneration)) {
      try {
        await closeReplica(opened);
      } catch {
        // A teardown failure cannot make a stale replica current.
      }
      return;
    }
    active = { descriptor, replica: opened };
    publish({
      ...state,
      status: accountId === null ? 'guest' : 'account',
      replica: opened,
      ready: true,
      recoveries: opened.snapshot().recoveries,
    });
  };

  let pendingLogout: {
    accountId: string;
    descriptor: TodoWorkspaceDescriptor;
    replica: CheckpointableReplica;
    checkpointed: boolean;
    teardownStarted: boolean;
    closed: boolean;
    databaseDeleted: boolean;
    cachesCleared: boolean;
    descriptorForgotten: boolean;
  } | null = null;
  let pendingMismatchDeletion: {
    currentAccountId: string;
    descriptor: TodoWorkspaceDescriptor;
    databaseDeleted: boolean;
    cachesCleared: boolean;
    descriptorForgotten: boolean;
  } | null = null;

  const setAccount = (accountId: string | null): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (
      state.accountId === accountId
      && state.ready
      && state.status === (accountId === null ? 'guest' : 'account')
    ) {
      return Promise.resolve();
    }
    generation += 1;
    const ownerGeneration = generation;
    publish(emptyState(accountId, 'opening'));
    const operation = tail.then(async () => {
      if (!isCurrent(accountId, ownerGeneration)) return;
      if (pendingLogout && !pendingLogout.teardownStarted) pendingLogout = null;
      if (active) {
        const previous = active.replica;
        active = null;
        try {
          await closeReplica(previous);
        } catch (cause) {
          if (isCurrent(accountId, ownerGeneration)) {
            publish({ ...state, error: String(cause) });
          }
          return;
        }
      }
      try {
        const descriptor = accountId === null
          ? await registry.forGuest()
          : await registry.forSignedInAccount(accountId);
        if (!isCurrent(accountId, ownerGeneration)) return;
        await openDescriptor(accountId, descriptor, ownerGeneration);
      } catch (cause) {
        if (!isCurrent(accountId, ownerGeneration)) return;
        const status = cause instanceof TodoWorkspaceAccessError
          ? cause.code === 'locked' ? 'locked' : 'mismatch'
          : state.status;
        publish({ ...state, status, error: String(cause) });
      }
    });
    tail = operation.catch(() => {});
    return operation;
  };

  const signOut = ({ discardLocalCopy = false }: { discardLocalCopy?: boolean } = {}) => {
    if (!deleteDatabase || !clearAccountCaches || !signOutAccount) {
      return Promise.reject(new Error('Sign out is unavailable'));
    }
    const operation = tail.then(async () => {
      if (!pendingLogout) {
        if (
          state.status !== 'account'
          || !state.accountId
          || !active
          || active.descriptor.binding.kind !== 'bound'
          || active.descriptor.binding.accountId !== state.accountId
        ) {
          throw new Error('No signed-in todo workspace is active');
        }
        pendingLogout = {
          accountId: state.accountId,
          descriptor: active.descriptor,
          replica: active.replica,
          checkpointed: false,
          teardownStarted: false,
          closed: false,
          databaseDeleted: false,
          cachesCleared: false,
          descriptorForgotten: false,
        };
      }
      const pending = pendingLogout;
      let accountSignedOut = false;
      try {
        if (!pending.checkpointed) {
          if (!discardLocalCopy) {
            if (!pending.replica.checkpoint) throw new Error('Sync checkpoint is unavailable');
            await pending.replica.checkpoint();
          }
          pending.checkpointed = true;
        }
        if (!pending.teardownStarted) {
          pending.teardownStarted = true;
          generation += 1;
          active = null;
          publish(emptyState(pending.accountId, 'signing-out'));
        }
        if (!pending.closed) {
          await pending.replica.close();
          closeAttempted.add(pending.replica);
          pending.closed = true;
        }
        if (!pending.databaseDeleted) {
          await deleteDatabase(pending.descriptor.databaseName);
          pending.databaseDeleted = true;
        }
        if (!pending.cachesCleared) {
          await clearAccountCaches(pending.accountId);
          pending.cachesCleared = true;
        }
        if (!pending.descriptorForgotten) {
          await registry.forget(pending.descriptor);
          pending.descriptorForgotten = true;
        }
        await signOutAccount();
        pendingLogout = null;
        accountSignedOut = true;

        const accountId = null;
        generation += 1;
        const ownerGeneration = generation;
        publish(emptyState(accountId, 'opening'));
        const descriptor = await registry.forGuest();
        if (!isCurrent(accountId, ownerGeneration)) return;
        await openDescriptor(accountId, descriptor, ownerGeneration);
      } catch (cause) {
        if (accountSignedOut) {
          publish({
            ...emptyState(null, 'opening'),
            error: `Could not open a new device workspace: ${errorMessage(cause)}`,
          });
        } else if (pending.teardownStarted) {
          publish({
            ...emptyState(pending.accountId, 'signing-out'),
            error: `Sign out could not finish: ${errorMessage(cause)}`,
          });
        }
        throw cause;
      }
    });
    tail = operation.catch(() => {});
    return operation;
  };

  const signOutMismatchedAccount = () => {
    if (!signOutAccount) return Promise.reject(new Error('Sign out is unavailable'));
    const operation = tail.then(async () => {
      if (state.status !== 'mismatch' || !state.accountId || state.replica) {
        throw new Error('No mismatched account is active');
      }
      if (
        pendingMismatchDeletion
        && (
          pendingMismatchDeletion.databaseDeleted
          || pendingMismatchDeletion.cachesCleared
          || pendingMismatchDeletion.descriptorForgotten
        )
      ) {
        throw new Error('Finish replacing the local workspace before signing out');
      }
      const accountId = state.accountId;
      await registry.forMismatchedAccount(accountId);
      try {
        await signOutAccount();
        pendingMismatchDeletion = null;
        generation += 1;
        publish(emptyState(null, 'locked'));
      } catch (cause) {
        publish({ ...state, error: `Could not sign out: ${errorMessage(cause)}` });
        throw cause;
      }
    });
    tail = operation.catch(() => {});
    return operation;
  };

  const deleteMismatchedWorkspace = () => {
    if (!deleteDatabase || !clearAccountCaches) {
      return Promise.reject(new Error('Workspace deletion is unavailable'));
    }
    const operation = tail.then(async () => {
      if (state.status !== 'mismatch' || !state.accountId || state.replica) {
        throw new Error('No mismatched account is active');
      }
      const currentAccountId = state.accountId;
      try {
        if (!pendingMismatchDeletion) {
          pendingMismatchDeletion = {
            currentAccountId,
            descriptor: await registry.forMismatchedAccount(currentAccountId),
            databaseDeleted: false,
            cachesCleared: false,
            descriptorForgotten: false,
          };
        }
        const pending = pendingMismatchDeletion;
        if (pending.currentAccountId !== currentAccountId) {
          throw new Error('Authenticated account changed during workspace recovery');
        }
        if (!pending.databaseDeleted) {
          const fresh = await registry.forMismatchedAccount(currentAccountId);
          if (JSON.stringify(fresh) !== JSON.stringify(pending.descriptor)) {
            throw new Error('Saved todo workspace changed during recovery');
          }
          await deleteDatabase(fresh.databaseName);
          pending.databaseDeleted = true;
        }
        if (!pending.cachesCleared) {
          if (pending.descriptor.binding.kind !== 'bound') {
            throw new Error('Saved todo workspace is not bound');
          }
          await clearAccountCaches(pending.descriptor.binding.accountId);
          pending.cachesCleared = true;
        }
        if (!pending.descriptorForgotten) {
          await registry.forget(pending.descriptor);
          pending.descriptorForgotten = true;
        }

        generation += 1;
        const ownerGeneration = generation;
        publish(emptyState(currentAccountId, 'opening'));
        const descriptor = await registry.forSignedInAccount(currentAccountId);
        if (!isCurrent(currentAccountId, ownerGeneration)) return;
        await openDescriptor(currentAccountId, descriptor, ownerGeneration);
        pendingMismatchDeletion = null;
      } catch (cause) {
        if (state.accountId === currentAccountId && !state.ready) {
          publish({
            ...emptyState(currentAccountId, 'mismatch'),
            error: `Could not replace this device copy: ${errorMessage(cause)}`,
          });
        }
        throw cause;
      }
    });
    tail = operation.catch(() => {});
    return operation;
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount,
    signOut,
    signOutMismatchedAccount,
    deleteMismatchedWorkspace,
    close(): Promise<void> {
      if (closing) return closing;
      stopped = true;
      generation += 1;
      publish(emptyState(null, 'closed'));
      closing = tail.then(async () => {
        if (active) {
          const previous = active.replica;
          active = null;
          try {
            await closeReplica(previous);
          } catch {
            // The owner stays closed after a platform teardown failure.
          }
        }
        listeners.clear();
      });
      return closing;
    },
  };
}
