import { createMergeableStore } from "tinybase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTaskdoSyncLifecycle,
  type TaskdoSynchronizer,
} from "./sync";

type SocketEvent = "open" | "error" | "close";

class FakeSocket {
  readyState = 0;
  closeCount = 0;
  private readonly listeners = new Map<SocketEvent, Set<() => void>>();

  addEventListener(event: SocketEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.closeCount++;
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  fail(): void {
    this.emit("error");
  }

  remoteClose(): void {
    this.readyState = 3;
    this.emit("close");
  }

  private emit(event: SocketEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

function setup({ eligible = () => true }: { eligible?: () => boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const synchronizers: Array<TaskdoSynchronizer & {
    startSync: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    emitStatus: (status: number) => void;
  }> = [];
  const connections: boolean[] = [];
  const syncStates: Array<{ phase: string; lastSyncedAt: string | null }> = [];
  const lifecycle = createTaskdoSyncLifecycle({
    store: createMergeableStore(),
    canConnect: eligible,
    onConnection: (connected) => connections.push(connected),
    onSyncState: (state) => syncStates.push(state),
    now: () => new Date("2026-09-27T12:00:00.000Z"),
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    createSynchronizer: () => {
      const statusListeners = new Set<(synchronizer: TaskdoSynchronizer, status: number) => void>();
      const synchronizer = {
        startSync: vi.fn(async () => {}),
        load: vi.fn(async () => {}),
        save: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        addStatusListener: vi.fn((listener: (synchronizer: TaskdoSynchronizer, status: number) => void) => {
          statusListeners.add(listener);
          return "status";
        }),
        delListener: vi.fn(() => statusListeners.clear()),
        emitStatus: (status: number) => {
          for (const listener of statusListeners) listener(synchronizer, status);
        },
      };
      synchronizers.push(synchronizer);
      return synchronizer;
    },
  });
  return { lifecycle, sockets, synchronizers, connections, syncStates };
}

describe("TaskDO synchronization lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects once and reports the completed initial synchronization", async () => {
    const { lifecycle, sockets, synchronizers, connections, syncStates } = setup();

    lifecycle.start();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await flush();

    expect(synchronizers[0].startSync.mock.calls).toHaveLength(1);
    expect(connections).toEqual([true]);
    expect(syncStates).toEqual([
      { phase: "connecting", lastSyncedAt: null },
      { phase: "synced", lastSyncedAt: "2026-09-27T12:00:00.000Z" },
    ]);
  });

  it("deduplicates concurrent connection attempts", async () => {
    const { lifecycle, sockets } = setup();

    lifecycle.start();
    const first = lifecycle.reconnect();
    const second = lifecycle.reconnect();
    await flush();

    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await Promise.all([first, second]);
  });

  it("cleans up a closed session and reconnects after exponential delays", async () => {
    const { lifecycle, sockets, synchronizers, connections } = setup();

    lifecycle.start();
    await flush();
    sockets[0].fail();
    await flush();
    expect(connections).toEqual([false]);

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    sockets[2].open();
    await flush();
    sockets[2].remoteClose();
    await flush();
    expect(synchronizers[0].destroy.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(4);
  });

  it("caps retry delay at thirty seconds", async () => {
    const { lifecycle, sockets } = setup();
    lifecycle.start();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await flush();
      sockets.at(-1)?.fail();
      await flush();
      await vi.advanceTimersByTimeAsync(delay - 1);
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
    }
  });

  it("immediate reconnect cancels a scheduled retry", async () => {
    const { lifecycle, sockets } = setup();
    lifecycle.start();
    await flush();
    sockets[0].fail();
    await flush();

    const reconnect = lifecycle.reconnect();
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await reconnect;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
  });

  it("reports connecting before a failed reconnect instead of flashing offline first", async () => {
    const { lifecycle, sockets, syncStates } = setup();
    lifecycle.start();
    await flush();
    sockets[0].open();
    await flush();
    sockets[0].remoteClose();
    await flush();

    const reconnect = lifecycle.reconnect();
    expect(syncStates.at(-1)?.phase).toBe("connecting");
    await flush();
    sockets[1].fail();
    await reconnect;

    expect(syncStates.at(-1)?.phase).toBe("offline");
  });

  it("reports the previous successful sync when starting offline", async () => {
    const syncStates: Array<{ phase: string; lastSyncedAt: string | null }> = [];
    const lifecycle = createTaskdoSyncLifecycle({
      store: createMergeableStore(),
      canConnect: () => false,
      initialLastSyncedAt: "2026-09-26T08:30:00.000Z",
      onConnection: () => {},
      onSyncState: (state) => syncStates.push(state),
      openSocket: () => new FakeSocket() as unknown as WebSocket,
    });

    lifecycle.start();
    await flush();

    expect(syncStates).toEqual([{
      phase: "offline",
      lastSyncedAt: "2026-09-26T08:30:00.000Z",
    }]);
  });

  it("refreshes a connected synchronizer with one load and save", async () => {
    const { lifecycle, sockets, synchronizers } = setup();
    lifecycle.start();
    await flush();
    sockets[0].open();
    await flush();

    await lifecycle.refresh();

    expect(synchronizers[0].load.mock.calls).toHaveLength(1);
    expect(synchronizers[0].save.mock.calls).toHaveLength(1);
  });

  it("reports real synchronizer activity and its successful completion", async () => {
    const { lifecycle, sockets, synchronizers, syncStates } = setup();
    lifecycle.start();
    await flush();
    sockets[0].open();
    await flush();

    synchronizers[0].emitStatus(2);
    expect(syncStates.at(-1)?.phase).toBe("syncing");
    synchronizers[0].emitStatus(0);
    expect(syncStates.at(-1)).toEqual({
      phase: "synced",
      lastSyncedAt: "2026-09-27T12:00:00.000Z",
    });
  });

  it("refresh reconnects immediately and fails truthfully when ineligible", async () => {
    let online = false;
    const { lifecycle, sockets } = setup({ eligible: () => online });

    await expect(lifecycle.refresh()).rejects.toThrow("Sync unavailable");
    expect(sockets).toHaveLength(0);
    online = true;
    const refresh = lifecycle.refresh();
    await flush();
    sockets[0].open();
    await refresh;
  });

  it("checkpoints through a newly established connection", async () => {
    const { lifecycle, sockets, synchronizers } = setup();

    const checkpoint = lifecycle.checkpoint();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await checkpoint;

    expect(synchronizers[0].load.mock.calls).toHaveLength(1);
    expect(synchronizers[0].save.mock.calls).toHaveLength(1);
  });

  it("reports socket and synchronizer setup failures as disconnected", async () => {
    const socketFailure = setup();
    socketFailure.lifecycle.start();
    await flush();
    socketFailure.sockets[0].fail();
    await flush();
    expect(socketFailure.connections).toEqual([false]);

    const setupFailureSocket = new FakeSocket();
    const connections: boolean[] = [];
    const lifecycle = createTaskdoSyncLifecycle({
      store: createMergeableStore(),
      openSocket: () => setupFailureSocket as unknown as WebSocket,
      onConnection: (connected) => connections.push(connected),
      createSynchronizer: async () => { throw new Error("setup failed"); },
    });
    lifecycle.start();
    await flush();
    setupFailureSocket.open();
    await flush();
    expect(connections).toEqual([false]);
    expect(setupFailureSocket.closeCount).toBe(1);
  });

  it("stops idempotently without retrying and ignores stale close events", async () => {
    const { lifecycle, sockets, synchronizers, connections } = setup();
    lifecycle.start();
    await flush();
    sockets[0].open();
    await flush();
    sockets[0].remoteClose();
    await flush();
    const reconnect = lifecycle.reconnect();
    await flush();
    sockets[1].open();
    await reconnect;

    sockets[0].remoteClose();
    await flush();
    expect(synchronizers[1].destroy.mock.calls).toHaveLength(0);

    await lifecycle.stop();
    await lifecycle.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    expect(synchronizers[1].destroy.mock.calls).toHaveLength(1);
    expect(connections.at(-1)).toBe(true);
  });

  it("settles a pending socket safely after shutdown", async () => {
    let resolveSocket: ((socket: WebSocket) => void) | undefined;
    const pendingSocket = new Promise<WebSocket>((resolve) => { resolveSocket = resolve; });
    const socket = new FakeSocket();
    const connections: boolean[] = [];
    const lifecycle = createTaskdoSyncLifecycle({
      store: createMergeableStore(),
      openSocket: () => pendingSocket,
      onConnection: (connected) => connections.push(connected),
    });

    lifecycle.start();
    await lifecycle.stop();
    resolveSocket?.(socket as unknown as WebSocket);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.closeCount).toBe(1);
    expect(connections).toEqual([]);
  });
});
