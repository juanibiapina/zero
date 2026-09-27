import type { TaskdoReplica, TodoSnapshot } from "./replica";

export type TodoReplicaDurability = {
  durable: boolean;
  error: string | null;
};

export type AccountTaskdoReplicaState = {
  accountId: string | null;
  replica: TaskdoReplica | null;
  ready: boolean;
  connected: boolean;
  durable: boolean;
  error: string | null;
  durabilityError: string | null;
  recoveries: TodoSnapshot["recoveries"];
};

export type AccountTaskdoReplicaEvents = {
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

export type OpenedAccountTaskdoReplica = {
  replica: TaskdoReplica;
  durability: TodoReplicaDurability;
};

export type OpenAccountTaskdoReplica = (
  accountId: string,
  events: AccountTaskdoReplicaEvents,
) => Promise<OpenedAccountTaskdoReplica>;

export type AccountTaskdoReplicaOwner = {
  getSnapshot: () => AccountTaskdoReplicaState;
  subscribe: (listener: () => void) => () => void;
  setAccount: (accountId: string | null) => Promise<void>;
  close: () => Promise<void>;
};

export type CreateAccountTaskdoReplicaOwnerOptions = {
  open: OpenAccountTaskdoReplica;
  initialDurability?: TodoReplicaDurability;
};

const DEFAULT_DURABILITY: TodoReplicaDurability = { durable: true, error: null };

function emptyState(
  accountId: string | null,
  durability: TodoReplicaDurability,
): AccountTaskdoReplicaState {
  return {
    accountId,
    replica: null,
    ready: false,
    connected: false,
    durable: durability.durable,
    error: null,
    durabilityError: durability.error,
    recoveries: [],
  };
}

export function createAccountTaskdoReplicaOwner({
  open,
  initialDurability = DEFAULT_DURABILITY,
}: CreateAccountTaskdoReplicaOwnerOptions): AccountTaskdoReplicaOwner {
  let state = emptyState(null, initialDurability);
  let desiredAccountId: string | null = null;
  let generation = 0;
  let stopped = false;
  let active: TaskdoReplica | null = null;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const closeAttempted = new Set<TaskdoReplica>();

  const publish = (next: AccountTaskdoReplicaState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const isCurrent = (accountId: string, ownerGeneration: number) => (
    !stopped
    && generation === ownerGeneration
    && desiredAccountId === accountId
  );

  const closeReplica = async (replica: TaskdoReplica) => {
    if (closeAttempted.has(replica)) return;
    closeAttempted.add(replica);
    await replica.close();
  };

  const setAccount = (accountId: string | null): Promise<void> => {
    if (stopped) return Promise.resolve();
    desiredAccountId = accountId;
    generation += 1;
    const ownerGeneration = generation;
    publish(emptyState(accountId, initialDurability));

    const operation = tail.then(async () => {
      if (active) {
        const previous = active;
        active = null;
        try {
          await closeReplica(previous);
        } catch (cause) {
          if (accountId && isCurrent(accountId, ownerGeneration)) {
            publish({ ...state, error: String(cause) });
          }
          return;
        }
      }
      if (!accountId || !isCurrent(accountId, ownerGeneration)) return;

      let sawSnapshot = false;
      let sawDurability = false;
      const events: AccountTaskdoReplicaEvents = {
        onSnapshot(snapshot) {
          if (!isCurrent(accountId, ownerGeneration)) return;
          sawSnapshot = true;
          publish({ ...state, error: null, recoveries: snapshot.recoveries });
        },
        onConnection(connected) {
          if (!isCurrent(accountId, ownerGeneration)) return;
          publish({ ...state, connected });
        },
        onDurability(durable, error) {
          if (!isCurrent(accountId, ownerGeneration)) return;
          sawDurability = true;
          publish({ ...state, durable, durabilityError: error });
        },
      };

      let opened: OpenedAccountTaskdoReplica;
      try {
        opened = await open(accountId, events);
      } catch (cause) {
        if (isCurrent(accountId, ownerGeneration)) {
          publish({ ...state, error: String(cause) });
        }
        return;
      }

      if (!isCurrent(accountId, ownerGeneration)) {
        try {
          await closeReplica(opened.replica);
        } catch {
          // A teardown failure cannot make a stale replica current.
        }
        return;
      }

      active = opened.replica;
      publish({
        ...state,
        replica: opened.replica,
        ready: true,
        durable: sawDurability ? state.durable : opened.durability.durable,
        durabilityError: sawDurability ? state.durabilityError : opened.durability.error,
        error: null,
        recoveries: sawSnapshot ? state.recoveries : opened.replica.snapshot().recoveries,
      });
    });
    tail = operation.catch(() => {});
    return operation;
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    desiredAccountId = null;
    generation += 1;
    publish(emptyState(null, initialDurability));
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
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAccount,
    close,
  };
}
