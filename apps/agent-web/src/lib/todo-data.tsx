import { useAuth } from "@clerk/react";
import { QueryClient } from "@tanstack/react-query";
import {
  type TaskdoReplica,
  type TodoSnapshot,
} from "@zero/agent-core";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { openBrowserTaskdoReplica, type BrowserTaskdoReplica } from "./browser-taskdo-replica";

export type TodoData = {
  replica: TaskdoReplica | null;
  ready: boolean;
  connected: boolean;
  durable: boolean;
  error: string | null;
  durabilityError: string | null;
  recoveries: TodoSnapshot["recoveries"];
};

const TodoDataContext = createContext<TodoData | null>(null);

export function TodoDataContextProvider({ children, value }: { children: ReactNode; value: TodoData }) {
  return <TodoDataContext.Provider value={value}>{children}</TodoDataContext.Provider>;
}

export function useTodoData(): TodoData {
  const value = useContext(TodoDataContext);
  if (!value) throw new Error("Todo data owner is not mounted");
  return value;
}

type State = {
  accountId: string;
  replica: BrowserTaskdoReplica | null;
  connected: boolean;
  durable: boolean;
  durabilityError: string | null;
  error: string | null;
  recoveries: TodoSnapshot["recoveries"];
};

export function TodoDataProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  const closeChain = useRef<Promise<unknown>>(Promise.resolve());
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let opened: BrowserTaskdoReplica | undefined;
    const opening = closeChain.current.then(() => openBrowserTaskdoReplica(userId, {
      queryClient: new QueryClient(),
      onSnapshot: (snapshot) => {
        if (!cancelled) setState((current) => ({
          accountId: userId,
          replica: current?.accountId === userId ? current.replica : null,
          connected: current?.accountId === userId ? current.connected : false,
          durable: current?.accountId === userId ? current.durable : false,
          durabilityError: current?.accountId === userId ? current.durabilityError : null,
          error: null,
          recoveries: snapshot.recoveries,
        }));
      },
      onConnection: (connected) => {
        if (!cancelled) setState((current) => current?.accountId === userId
          ? { ...current, connected }
          : { accountId: userId, replica: null, connected, durable: false, durabilityError: null, error: null, recoveries: [] });
      },
      onDurability: (durable, durabilityError) => {
        if (!cancelled) setState((current) => current?.accountId === userId
          ? { ...current, durable, durabilityError }
          : { accountId: userId, replica: null, connected: false, durable, durabilityError, error: null, recoveries: [] });
      },
    })).then((replica) => {
      opened = replica;
      if (cancelled) return replica.close().then(() => replica);
      setState((current) => ({
        accountId: userId,
        replica,
        connected: current?.accountId === userId ? current.connected : false,
        durable: replica.durable,
        durabilityError: replica.durabilityError,
        error: null,
        recoveries: replica.snapshot().recoveries,
      }));
      return replica;
    }).catch((cause: unknown) => {
      if (!cancelled) setState({
        accountId: userId,
        replica: null,
        connected: false,
        durable: false,
        durabilityError: null,
        error: String(cause),
        recoveries: [],
      });
      return undefined;
    });

    return () => {
      cancelled = true;
      closeChain.current = opening.then(async () => {
        await opened?.close();
      });
    };
  }, [userId]);

  const active = state?.accountId === userId ? state : null;
  const value: TodoData = {
    replica: active?.replica ?? null,
    ready: !!active?.replica,
    connected: active?.connected ?? false,
    durable: active?.durable ?? false,
    error: active?.error ?? null,
    durabilityError: active?.durabilityError ?? null,
    recoveries: active?.recoveries ?? [],
  };

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
  return (
    <aside className="mx-auto w-full max-w-2xl space-y-2 px-4 pt-4 text-sm sm:px-6 md:ml-56 lg:px-8">
      <p className="text-muted-foreground">
        {data.connected ? "Synced" : data.durable ? "Offline · saved in this browser" : "Offline · changes are not durable"}
      </p>
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
