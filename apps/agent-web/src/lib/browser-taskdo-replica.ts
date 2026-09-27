import { QueryClient } from "@tanstack/react-query";
import {
  createSyncedTaskdoReplicaSession,
  type TaskdoReplica,
  type TaskdoSyncState,
  type TodoSnapshot,
} from "@zero/agent-core";
import { createMergeableStore } from "tinybase";
import { openBrowserTaskdoPersistence } from "./browser-taskdo-persistence";
import { loadLastSync, saveLastSync } from "./sync-metadata";

export { TASKDO_BROWSER_DB_PREFIX } from "./browser-taskdo-persistence";

export type BrowserTaskdoReplica = TaskdoReplica & {
  durable: boolean;
  durabilityError: string | null;
};

type OpenBrowserTaskdoReplicaOptions = {
  queryClient?: QueryClient;
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onSyncState?: (state: TaskdoSyncState) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

function taskSyncUrl(): string {
  const url = new URL("/api/task-sync", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function openBrowserTaskdoReplica(
  accountId: string,
  { queryClient, onSnapshot, onConnection, onSyncState = () => {}, onDurability }: OpenBrowserTaskdoReplicaOptions,
): Promise<BrowserTaskdoReplica> {
  const replicaQueryClient = queryClient ?? new QueryClient();
  const store = createMergeableStore();
  const persistence = await openBrowserTaskdoPersistence({ accountId, store, onDurability });

  const session = createSyncedTaskdoReplicaSession({
    store,
    queryClient: replicaQueryClient,
    queryKeyScope: [accountId],
    save: persistence.save,
    onSnapshot,
    refreshLocal: persistence.refresh,
    sync: {
      canConnect: () => navigator.onLine,
      onConnection,
      initialLastSyncedAt: loadLastSync(accountId),
      onSyncState: (state) => {
        onSyncState(state);
        if (state.lastSyncedAt) saveLastSync(accountId, state.lastSyncedAt);
      },
      openSocket: () => new WebSocket(taskSyncUrl()),
    },
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void session.reconnect();
    }
    persistence.setVisible(document.visibilityState === "visible");
  };
  const onOnline = () => { void session.reconnect(); };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  let closePromise: Promise<void> | undefined;
  return {
    ...session,
    durable: persistence.durable,
    durabilityError: persistence.durabilityError,
    close() {
      closePromise ??= (async () => {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
        await session.close();
        await persistence.close();
      })();
      return closePromise;
    },
  };
}
