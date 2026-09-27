import { useAuth } from "@clerk/react";
import { QueryClient } from "@tanstack/react-query";
import {
  createAccountTaskdoReplicaOwner,
  selectAccountTaskdoReplicaState,
  type TaskdoReplicaClientState,
} from "@zero/agent-core";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { openBrowserTaskdoReplica } from "./browser-taskdo-replica";

export type TodoData = TaskdoReplicaClientState;

const TodoDataContext = createContext<TodoData | null>(null);

export function TodoDataContextProvider({ children, value }: { children: ReactNode; value: TodoData }) {
  return <TodoDataContext.Provider value={value}>{children}</TodoDataContext.Provider>;
}

export function useTodoData(): TodoData {
  const value = useContext(TodoDataContext);
  if (!value) throw new Error("Todo data owner is not mounted");
  return value;
}

export function TodoDataProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const [owner] = useState(() => createAccountTaskdoReplicaOwner({
    initialDurability: { durable: false, error: null },
    open: async (accountId, events) => {
      const replica = await openBrowserTaskdoReplica(accountId, {
        queryClient: new QueryClient(),
        onSnapshot: events.onSnapshot,
        onConnection: events.onConnection,
        onSyncState: events.onSyncState,
        onDurability: events.onDurability,
      });
      return {
        replica,
        durability: { durable: replica.durable, error: replica.durabilityError },
      };
    },
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  useEffect(() => {
    void owner.setAccount(userId ?? null);
    return () => { void owner.setAccount(null); };
  }, [owner, userId]);

  const value = selectAccountTaskdoReplicaState(
    state,
    userId ?? null,
    { durable: false, error: null },
  );

  if (!value.ready) return value.error
    ? <div className="p-6 text-sm text-destructive">{value.error}</div>
    : <Loading />;

  return (
    <TodoDataContextProvider value={value}>
      <TodoDataNotices />
      {children}
    </TodoDataContextProvider>
  );
}

function TodoDataNotices() {
  const data = useTodoData();
  const [repairError, setRepairError] = useState<string | null>(null);
  if (!data.durabilityError && !repairError && data.recoveries.length === 0) return null;
  return (
    <aside className="mx-auto w-full max-w-2xl space-y-2 px-4 pt-4 text-sm sm:px-6 md:ml-56 lg:px-8">
      {data.durabilityError ? <p className="text-destructive">{data.durabilityError}</p> : null}
      {repairError ? <p className="text-destructive">{repairError}</p> : null}
      {data.recoveries.map((recovery) => (
        <div key={`${recovery.table}-${recovery.id}-${recovery.reason}`} className="rounded-md border border-destructive/30 p-3">
          <p className="text-destructive">
            Recover {recovery.table}: {recovery.text} — {recovery.reason} ({recovery.id})
          </p>
          {recovery.repair ? (
            <Button
              className="mt-2"
              variant="outline"
              onClick={() => {
                setRepairError(null);
                void data.replica?.repair(recovery).catch((error: unknown) => setRepairError(String(error)));
              }}
            >
              {recovery.repair === "make-task-loose" ? "Keep task loose"
                : recovery.repair === "clear-task-recurrence" ? "Stop invalid recurrence"
                  : "Remove invalid After"}
            </Button>
          ) : null}
        </div>
      ))}
    </aside>
  );
}
