import type { MergeableStore } from "tinybase";
import { createWsSynchronizer } from "tinybase/synchronizers/synchronizer-ws-client";

export type TaskdoSynchronizer = {
  startSync(): Promise<unknown>;
  load(): Promise<unknown>;
  save(): Promise<unknown>;
  destroy(): Promise<unknown>;
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
  createSynchronizer?: (
    store: MergeableStore,
    socket: WebSocket,
  ) => TaskdoSynchronizer | Promise<TaskdoSynchronizer>;
};

type Session = {
  socket: WebSocket;
  synchronizer?: TaskdoSynchronizer;
};

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const SOCKET_OPEN = 1;

export function createTaskdoSyncLifecycle({
  store,
  openSocket,
  canConnect = () => true,
  onConnection,
  createSynchronizer = createWsSynchronizer,
}: CreateTaskdoSyncLifecycleOptions): TaskdoSyncLifecycle {
  let stopped = false;
  let connectionAttempt: Promise<void> | undefined;
  let session: Session | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = INITIAL_RETRY_MS;

  const destroySynchronizer = async (active: Session) => {
    const synchronizer = active.synchronizer;
    active.synchronizer = undefined;
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
    } catch {
      if (active && session === active) session = undefined;
      if (active) {
        await destroySynchronizer(active);
        active.socket.close();
      }
      if (!stopped) {
        onConnection(false);
        scheduleReconnect();
      }
    }
  };

  const connect = async () => {
    if (stopped || (session?.socket.readyState === SOCKET_OPEN && session.synchronizer) || !canConnect()) return;
    if (connectionAttempt) return connectionAttempt;
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
    if (!stopped && !session?.synchronizer && canConnect()) await connect();
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
