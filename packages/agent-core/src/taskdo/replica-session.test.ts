import { QueryClient } from "@tanstack/react-query";
import { createMergeableStore } from "tinybase";
import { describe, expect, it, vi } from "vitest";

import { createSyncedTaskdoReplicaSession } from "./replica-session";
import type { TaskdoSynchronizer } from "./sync";

const NOW = "2026-09-27T12:00:00.000Z";

class OpenSocket {
  readonly readyState = 1;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(event: string, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.closeCount++;
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

function setup({ refreshLocal }: { refreshLocal?: () => Promise<void> } = {}) {
  const store = createMergeableStore();
  const socket = new OpenSocket();
  const snapshots: number[] = [];
  const connections: boolean[] = [];
  const startSync = vi.fn(async () => {});
  const load = vi.fn(async () => {});
  const save = vi.fn(async () => {});
  const destroy = vi.fn(async () => {});
  const synchronizer: TaskdoSynchronizer = {
    startSync,
    load,
    save,
    destroy,
  };
  const session = createSyncedTaskdoReplicaSession({
    store,
    queryClient: new QueryClient(),
    queryKeyScope: ["test"],
    onSnapshot: (snapshot) => snapshots.push(snapshot.tasks.length),
    refreshLocal,
    sync: {
      onConnection: (connected) => connections.push(connected),
      openSocket: () => socket as unknown as WebSocket,
      createSynchronizer: () => synchronizer,
    },
  });
  return { connections, destroy, load, save, session, snapshots, socket, startSync, store };
}

describe("synced TaskDO replica session", () => {
  it("publishes the initial snapshot and starts synchronization", async () => {
    const { connections, session, snapshots, startSync, store } = setup();

    expect(snapshots).toEqual([0]);
    await flush();
    expect(startSync).toHaveBeenCalledOnce();
    expect(connections).toEqual([true]);

    store.setRow("tasks", "task", { text: "Task", createdAt: NOW });
    expect(snapshots).toEqual([0, 1]);
    await session.close();
  });

  it("refreshes local persistence before remote synchronization", async () => {
    const order: string[] = [];
    const { load, save, session } = setup({
      refreshLocal: async () => { order.push("local"); },
    });
    load.mockImplementation(async () => { order.push("load"); });
    save.mockImplementation(async () => { order.push("save"); });
    await flush();

    await session.refresh();

    expect(order).toEqual(["local", "load", "save"]);
    await session.close();
  });

  it("closes synchronization and snapshot delivery exactly once", async () => {
    const { destroy, session, snapshots, socket, store } = setup();
    await flush();

    await Promise.all([session.close(), session.close()]);
    store.setRow("tasks", "after-close", { text: "Ignored", createdAt: NOW });

    expect(socket.closeCount).toBe(1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([0]);
  });
});
