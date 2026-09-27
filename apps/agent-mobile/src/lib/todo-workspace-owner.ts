import type {
  TaskdoReplica,
  TaskdoReplicaClientState,
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
  | 'closed';

export type TodoWorkspaceOwnerState = TaskdoReplicaClientState & {
  accountId: string | null;
  status: TodoWorkspaceOwnerStatus;
};

const EMPTY_CLIENT_STATE: TaskdoReplicaClientState = {
  replica: null,
  ready: false,
  connected: false,
  durable: true,
  error: null,
  durabilityError: null,
  recoveries: [],
};

type TodoWorkspaceReplicaEvents = {
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

type CreateTodoWorkspaceOwnerOptions = {
  registry: TodoWorkspaceRegistry;
  open: (
    descriptor: TodoWorkspaceDescriptor,
    events: TodoWorkspaceReplicaEvents,
  ) => Promise<TaskdoReplica>;
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
}: CreateTodoWorkspaceOwnerOptions) {
  let state = emptyState(null, 'opening');
  let active: TaskdoReplica | null = null;
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

  const setAccount = (accountId: string | null): Promise<void> => {
    if (stopped) return Promise.resolve();
    generation += 1;
    const ownerGeneration = generation;
    publish(emptyState(accountId, 'opening'));
    const operation = tail.then(async () => {
      if (!isCurrent(accountId, ownerGeneration)) return;
      if (active) {
        const previous = active;
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
        const events: TodoWorkspaceReplicaEvents = {
          onSnapshot(snapshot) {
            if (!isCurrent(accountId, ownerGeneration)) return;
            publish({ ...state, recoveries: snapshot.recoveries });
          },
          onConnection(connected) {
            if (!isCurrent(accountId, ownerGeneration)) return;
            publish({ ...state, connected });
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
        active = opened;
        publish({
          ...state,
          status: accountId === null ? 'guest' : 'account',
          replica: opened,
          ready: true,
          recoveries: opened.snapshot().recoveries,
        });
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

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount,
    close(): Promise<void> {
      if (closing) return closing;
      stopped = true;
      generation += 1;
      publish(emptyState(null, 'closed'));
      closing = tail.then(async () => {
        if (active) {
          const previous = active;
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
