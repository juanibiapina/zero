import { QueryClient } from "@tanstack/react-query";
import {
  createTaskdoReplica,
  createTaskdoSyncLifecycle,
  type TaskdoReplica,
  type TodoSnapshot,
} from "@zero/agent-core";
import { createMergeableStore } from "tinybase";
import { openBrowserTaskdoPersistence } from "./browser-taskdo-persistence";

export { TASKDO_BROWSER_DB_PREFIX } from "./browser-taskdo-persistence";

export type BrowserTaskdoReplica = TaskdoReplica & {
  durable: boolean;
  durabilityError: string | null;
};

type OpenBrowserTaskdoReplicaOptions = {
  queryClient?: QueryClient;
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

function taskSyncUrl(): string {
  const url = new URL("/api/task-sync", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function openBrowserTaskdoReplica(
  accountId: string,
  { queryClient, onSnapshot, onConnection, onDurability }: OpenBrowserTaskdoReplicaOptions,
): Promise<BrowserTaskdoReplica> {
  const replicaQueryClient = queryClient ?? new QueryClient();
  const store = createMergeableStore();
  let stopped = false;
  const persistence = await openBrowserTaskdoPersistence({ accountId, store, onDurability });

  let refreshReplica = async () => {};
  const replica = createTaskdoReplica({
    store,
    queryClient: replicaQueryClient,
    queryKeyScope: [accountId],
    save: persistence.save,
    refresh: () => refreshReplica(),
  });
  const unsubscribe = replica.subscribe(onSnapshot);
  const sync = createTaskdoSyncLifecycle({
    store,
    canConnect: () => navigator.onLine,
    onConnection,
    openSocket: () => new WebSocket(taskSyncUrl()),
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void sync.reconnect();
    }
    persistence.setVisible(document.visibilityState === "visible");
  };
  refreshReplica = async () => {
    await persistence.refresh();
    await sync.refresh();
  };
  const onOnline = () => { void sync.reconnect(); };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  sync.start();

  return {
    ...replica,
    durable: persistence.durable,
    durabilityError: persistence.durabilityError,
    async close() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      await sync.stop();
      unsubscribe();
      await replica.close();
      await persistence.close();
    },
  };
}
