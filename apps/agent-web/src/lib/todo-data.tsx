import { useAuth } from "@clerk/react";
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
import { BROWSER_WORKSPACE_KEY, GUEST_OWNER_ID, openBrowserTodoWorkspace } from "./browser-todo-workspace";
import type { BrowserTaskdoReplica } from "./browser-taskdo-replica";

export type TodoData = TaskdoReplicaClientState & { authenticatedFeatures?: boolean; saveLocal?: () => Promise<void> };

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
      const replica = await openBrowserTodoWorkspace(accountId === GUEST_OWNER_ID ? null : accountId, events);
      return {
        replica,
        durability: { durable: replica.durable, error: replica.durabilityError },
      };
    },
  }));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);

  const ownerId = userId ?? GUEST_OWNER_ID;
  useEffect(() => {
    void owner.setAccount(ownerId);
    const changed = (event: StorageEvent) => {
      if (event.key === BROWSER_WORKSPACE_KEY && !userId) void owner.setAccount(ownerId);
    };
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener("storage", changed); void owner.setAccount(null); };
  }, [owner, ownerId, userId]);

  const value = selectAccountTaskdoReplicaState(state, ownerId, { durable: false, error: null });

  if (!value.ready) return value.error
    ? <div className="flex flex-col gap-3 p-6"><p role="alert" className="text-sm text-destructive">{value.error}</p><Button variant="outline" onClick={() => void owner.setAccount(ownerId)}>Try again</Button></div>
    : <Loading />;

  return (
    <TodoDataContextProvider value={{ ...value, authenticatedFeatures: Boolean(userId), saveLocal: (value.replica as BrowserTaskdoReplica).saveLocal }}>
      <TodoDataNotices />
      {children}
    </TodoDataContextProvider>
  );
}

function TodoDataNotices() {
  const data = useTodoData();
  const [repairError, setRepairError] = useState<string | null>(null);
  const recoveries = data.recoveries.filter((entry) => entry.table !== 'medicines' && entry.table !== 'doses');
  if (!data.durabilityError && !repairError && recoveries.length === 0) return null;
  return (
    <aside className="mx-auto w-full max-w-2xl space-y-2 px-4 pt-4 text-sm sm:px-6 md:ml-56 lg:px-8">
      {data.durabilityError ? <p className="text-destructive">{data.durabilityError}</p> : null}
      {repairError ? <p className="text-destructive">{repairError}</p> : null}
      {recoveries.map((recovery) => (
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
