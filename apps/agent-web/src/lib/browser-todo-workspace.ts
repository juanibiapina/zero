import { QueryClient } from "@tanstack/react-query";
import { createTaskdoReplica, type AccountTaskdoReplicaEvents } from "@zero/agent-core";
import { createMergeableStore } from "tinybase";
import { openBrowserTaskdoPersistence, TASKDO_BROWSER_DB_PREFIX } from "./browser-taskdo-persistence";
import { openBrowserTaskdoReplica, type BrowserTaskdoReplica } from "./browser-taskdo-replica";

export const BROWSER_WORKSPACE_KEY = "zero.todo-workspaces.v1";
export const GUEST_OWNER_ID = "__zero_guest_workspace__";
type Registry = { version: 1; guest: string | null; adoptions: { workspace: string; account: string }[] };
const LOCK = "zero-todo-workspaces";

function registry(): Registry {
  const raw = localStorage.getItem(BROWSER_WORKSPACE_KEY);
  if (!raw) return { version: 1, guest: null, adoptions: [] };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 || !("guest" in parsed) || !("adoptions" in parsed)) throw new Error("Saved workspace information is invalid. Your local data has been kept.");
  const value = parsed as Registry;
  if ((value.guest !== null && (typeof value.guest !== "string" || !/^guest-[a-zA-Z0-9_-]+$/.test(value.guest))) || !Array.isArray(value.adoptions) || value.adoptions.some((entry) => !entry || typeof entry.workspace !== "string" || !/^guest-[a-zA-Z0-9_-]+$/.test(entry.workspace) || typeof entry.account !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.account))) throw new Error("Saved workspace information is invalid. Your local data has been kept.");
  const workspaces = value.adoptions.map((entry) => entry.workspace);
  if (new Set(workspaces).size !== workspaces.length || (value.guest !== null && workspaces.includes(value.guest))) throw new Error("Saved workspace information is invalid. Your local data has been kept.");
  return value;
}

function saveRegistry(value: Registry) {
  localStorage.setItem(BROWSER_WORKSPACE_KEY, JSON.stringify(value));
}

async function locked<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser cannot safely save a guest workspace. Enable browser storage and try again.");
  return navigator.locks.request(LOCK, operation);
}

async function openGuest(events: AccountTaskdoReplicaEvents): Promise<BrowserTaskdoReplica> {
  const value = registry();
  const id = value.guest ?? `guest-${crypto.randomUUID()}`;
  if (!value.guest) saveRegistry({ ...value, guest: id });
  const store = createMergeableStore();
  const persistence = await openBrowserTaskdoPersistence({ accountId: id, store, onDurability: events.onDurability, beforeSave: () => {
    if (registry().guest !== id) throw new Error("This workspace was linked to an account in another tab. Reopen Home to continue.");
  } });
  let closed = false;
  const save = async () => {
    if (closed) throw new Error("This workspace is closed.");
    await persistence.save();
    if (!persistence.durable) throw new Error(persistence.durabilityError ?? "Your change could not be saved offline.");
  };
  const replica = createTaskdoReplica({ store, queryClient: new QueryClient(), queryKeyScope: [id], save, refresh: persistence.refresh });
  const unsubscribe = replica.subscribe(events.onSnapshot);
  events.onConnection(false);
  const visible = () => persistence.setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", visible);
  let closing: Promise<void> | undefined;
  return {
    ...replica,
    saveLocal: save,
    get durable() { return persistence.durable; },
    get durabilityError() { return persistence.durabilityError; },
    close() {
      closed = true;
      closing ??= (async () => {
        document.removeEventListener("visibilitychange", visible);
        unsubscribe();
        await replica.close();
        await persistence.close();
      })();
      return closing;
    },
  };
}

async function bindGuest(account: string) {
  const value = registry();
  if (!value.guest) return;
  const workspace = value.guest;
  await navigator.locks.request(`${TASKDO_BROWSER_DB_PREFIX}${workspace}-persistence`, async () => {
    saveRegistry({ ...value, guest: null, adoptions: [...value.adoptions, { workspace, account }] });
  });
}

async function adopt(account: string, destination: ReturnType<typeof createMergeableStore>, save: () => Promise<void>) {
  for (const entry of registry().adoptions.filter((item) => item.account === account)) {
    const store = createMergeableStore();
    const persistence = await openBrowserTaskdoPersistence({ accountId: entry.workspace, store, onDurability: () => {} });
    try {
      if (!persistence.durable) throw new Error(persistence.durabilityError ?? "Cannot open your guest work.");
      destination.merge(store);
      await save();
      const current = registry();
      saveRegistry({ ...current, adoptions: current.adoptions.filter((item) => item.workspace !== entry.workspace) });
    } finally { await persistence.close(); }
  }
}

export async function openBrowserTodoWorkspace(accountId: string | null, events: AccountTaskdoReplicaEvents): Promise<BrowserTaskdoReplica> {
  if (accountId && !navigator.locks && localStorage.getItem(BROWSER_WORKSPACE_KEY) === null) return openBrowserTaskdoReplica(accountId, events);
  return locked(async () => {
    if (!accountId) return openGuest(events);
    await bindGuest(accountId);
    return openBrowserTaskdoReplica(accountId, { ...events, queryClient: new QueryClient(), prepareStore: (store, save) => adopt(accountId, store, save) });
  });
}
