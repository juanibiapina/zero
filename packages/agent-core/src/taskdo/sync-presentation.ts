import type { TaskdoSyncState } from "./sync";

export type TodoSyncDisplayKind = "local" | "busy" | "synced" | "offline" | "warning";

export type TodoSyncPresentation = {
  kind: TodoSyncDisplayKind;
  label: string;
  description: string;
};

export function todoSyncPresentation({
  signedIn,
  durable,
  sync,
}: {
  signedIn: boolean;
  durable: boolean;
  sync: TaskdoSyncState;
}): TodoSyncPresentation {
  if (!durable) return {
    kind: "warning",
    label: "Offline saving unavailable",
    description: "Changes may not survive closing this app.",
  };
  if (!signedIn) return {
    kind: "local",
    label: "Saved on this device",
    description: "Sign in to sync across devices.",
  };
  if (sync.phase === "connecting") return {
    kind: "busy",
    label: "Connecting",
    description: "Reconnecting to sync your changes.",
  };
  if (sync.phase === "syncing") return {
    kind: "busy",
    label: "Syncing",
    description: "Exchanging changes with your other devices.",
  };
  if (sync.phase === "synced") return {
    kind: "synced",
    label: "Synced",
    description: "Your saved changes are up to date.",
  };
  return {
    kind: "offline",
    label: "Offline",
    description: "Changes are saved here and will sync when you reconnect.",
  };
}
