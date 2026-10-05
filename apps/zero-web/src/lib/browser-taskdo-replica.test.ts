import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openBrowserTaskdoReplica, TASKDO_BROWSER_DB_PREFIX } from "./browser-taskdo-replica";

const synchronizers = vi.hoisted(() => [] as Array<{
  startSync: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}>);

vi.mock("tinybase/synchronizers/synchronizer-ws-client", () => ({
  createWsSynchronizer: vi.fn(() => {
    const synchronizer = {
      startSync: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    synchronizers.push(synchronizer);
    return synchronizer;
  }),
}));

class TestSocket extends EventTarget {
  static instances: TestSocket[] = [];
  readonly url: string;
  readyState = 1;
  closeCount = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestSocket.instances.push(this);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.closeCount++;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

let visibility: DocumentVisibilityState;

beforeEach(() => {
  synchronizers.length = 0;
  TestSocket.instances = [];
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, action: () => Promise<unknown>) => action() },
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestSocket });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser TaskDO replica", () => {
  it("keeps browser persistence and browser reconnect policy around the shared session", async () => {
    const durability: Array<[boolean, string | null]> = [];
    const replica = await openBrowserTaskdoReplica("account-a", {
      onSnapshot: () => {},
      onConnection: () => {},
      onDurability: (durable, error) => durability.push([durable, error]),
    });
    await flush();

    expect(replica.durable).toBe(true);
    expect(durability.at(-1)).toEqual([true, null]);
    expect((await indexedDB.databases()).map(({ name }) => name)).toContain(
      `${TASKDO_BROWSER_DB_PREFIX}account-a`,
    );
    expect(TestSocket.instances[0].url).toMatch(/^ws.*\/api\/task-sync$/);

    TestSocket.instances[0].close();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(TestSocket.instances).toHaveLength(2);

    TestSocket.instances[1].close();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(TestSocket.instances).toHaveLength(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(TestSocket.instances).toHaveLength(3);

    await Promise.all([replica.close(), replica.close()]);
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(TestSocket.instances).toHaveLength(3);
    expect(synchronizers.map(({ destroy }) => destroy.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
