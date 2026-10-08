import type { MergeableStore } from "tinybase";
import { createWsSynchronizer } from "tinybase/synchronizers/synchronizer-ws-client";

// The store format a client syncs. The server refuses any other, so an app
// that predates a storage migration works offline until it updates.
export const TASK_SYNC_SCHEMA = 2;
export const taskSyncPath = `/api/task-sync?schema=${TASK_SYNC_SCHEMA}`;

export type TaskdoSynchronizer = {
  startSync(): Promise<unknown>;
  load(): Promise<unknown>;
  save(): Promise<unknown>;
  destroy(): Promise<unknown>;
  addStatusListener?: (listener: (_synchronizer: TaskdoSynchronizer, status: number) => void) => string;
  delListener?: (listenerId: string) => unknown;
};

export type TaskdoSyncPhase = "connecting" | "syncing" | "synced" | "offline";

export type TaskdoSyncState = {
  phase: TaskdoSyncPhase;
  lastSyncedAt: string | null;
};

export type TaskdoSyncLifecycle = {
  start(): void;
  checkpoint(): Promise<void>;
  reconnect(): Promise<void>;
  refresh(): Promise<void>;
  stop(): Promise<void>;
};

export type CreateTaskdoSyncLifecycleOptions = {
  store: MergeableStore;
  openSocket: () => WebSocket | Promise<WebSocket>;
  canConnect?: () => boolean;
  onConnection: (connected: boolean) => void;
  onSyncState?: (state: TaskdoSyncState) => void;
  initialLastSyncedAt?: string | null;
  now?: () => Date;
  createSynchronizer?: (
    store: MergeableStore,
    socket: WebSocket,
  ) => TaskdoSynchronizer | Promise<TaskdoSynchronizer>;
};

type Session = {
  socket: WebSocket;
  synchronizer?: TaskdoSynchronizer;
  statusListenerId?: string;
};

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const SOCKET_OPEN = 1;

export function createTaskdoSyncLifecycle({
  store,
  openSocket,
  canConnect = () => true,
  onConnection,
  onSyncState = () => {},
  initialLastSyncedAt = null,
  now = () => new Date(),
  createSynchronizer = createWsSynchronizer,
}: CreateTaskdoSyncLifecycleOptions): TaskdoSyncLifecycle {
  let stopped = false;
  let connectionAttempt: Promise<void> | undefined;
  let session: Session | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = INITIAL_RETRY_MS;
  let syncState: TaskdoSyncState = {
    phase: "offline",
    lastSyncedAt: initialLastSyncedAt,
  };
  let hasPublishedSyncState = false;

  const publishSyncState = (phase: TaskdoSyncPhase, lastSyncedAt = syncState.lastSyncedAt) => {
    if (hasPublishedSyncState && syncState.phase === phase && syncState.lastSyncedAt === lastSyncedAt) return;
    syncState = { phase, lastSyncedAt };
    hasPublishedSyncState = true;
    onSyncState(syncState);
  };

  const markSynced = () => {
    publishSyncState("synced", now().toISOString());
  };

  const destroySynchronizer = async (active: Session) => {
    const synchronizer = active.synchronizer;
    active.synchronizer = undefined;
    const listenerId = active.statusListenerId;
    if (listenerId) synchronizer?.delListener?.(listenerId);
    await synchronizer?.destroy().catch(() => {});
  };

  const scheduleReconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  };

  const disconnect = (active: Session) => {
    if (session !== active) return;
    session = undefined;
    onConnection(false);
    publishSyncState("offline");
    void destroySynchronizer(active);
    scheduleReconnect();
  };

  const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Sync unavailable")), { once: true });
  });

  const runConnectionAttempt = async () => {
    let active: Session | undefined;
    try {
      const socket = await openSocket();
      active = { socket };
      if (stopped) {
        socket.close();
        return;
      }
      session = active;
      socket.addEventListener("close", () => disconnect(active as Session));
      if (socket.readyState !== SOCKET_OPEN) await waitForOpen(socket);
      if (stopped || session !== active) {
        socket.close();
        return;
      }
      const synchronizer = await createSynchronizer(store, socket);
      active.synchronizer = synchronizer;
      let wasBusy = false;
      const statusListenerId = synchronizer.addStatusListener?.((_source, status) => {
        if (status === 0) {
          if (wasBusy) markSynced();
          wasBusy = false;
        } else {
          wasBusy = true;
          publishSyncState("syncing");
        }
      });
      if (statusListenerId) active.statusListenerId = statusListenerId;
      if (stopped || session !== active) {
        await destroySynchronizer(active);
        socket.close();
        return;
      }
      await synchronizer.startSync();
      if (stopped || session !== active) {
        await destroySynchronizer(active);
        socket.close();
        return;
      }
      retryDelay = INITIAL_RETRY_MS;
      onConnection(true);
      markSynced();
    } catch {
      if (active && session === active) session = undefined;
      if (active) {
        await destroySynchronizer(active);
        active.socket.close();
      }
      if (!stopped) {
        onConnection(false);
        publishSyncState("offline");
        scheduleReconnect();
      }
    }
  };

  const connect = async () => {
    if (stopped || (session?.socket.readyState === SOCKET_OPEN && session.synchronizer)) return;
    if (!canConnect()) {
      publishSyncState("offline");
      return;
    }
    if (connectionAttempt) return connectionAttempt;
    publishSyncState("connecting");
    const attempt = runConnectionAttempt();
    connectionAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (connectionAttempt === attempt) connectionAttempt = undefined;
    }
  };

  const reconnect = async () => {
    if (retry) clearTimeout(retry);
    retry = undefined;
    await connect();
  };

  return {
    start() {
      void connect();
    },
    async checkpoint() {
      await reconnect();
      const active = session;
      if (!active?.synchronizer || active.socket.readyState !== SOCKET_OPEN) {
        throw new Error("Sync unavailable");
      }
      await active.synchronizer.load();
      if (session !== active || active.socket.readyState !== SOCKET_OPEN) {
        throw new Error("Sync unavailable");
      }
      await active.synchronizer.save();
    },
    reconnect,
    async refresh() {
      const active = session;
      if (active?.synchronizer && active.socket.readyState === SOCKET_OPEN) {
        await active.synchronizer.load();
        await active.synchronizer.save();
        return;
      }
      await reconnect();
      if (!session?.synchronizer || session.socket.readyState !== SOCKET_OPEN) {
        throw new Error("Sync unavailable");
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = undefined;
      const active = session;
      session = undefined;
      if (!active) return;
      active.socket.close();
      await destroySynchronizer(active);
    },
  };
}
