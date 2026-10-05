import { describe, expect, it, vi } from "vitest";

vi.mock("tinybase/synchronizers/synchronizer-ws-server-durable-object", () => ({
  WsServerDurableObject: class {},
}));

import {
  TASKDO_FIXTURE_DELETED_KEY,
  TASKDO_SQL_STORAGE_PREFIX,
  TaskDO,
} from "./index";

type AdapterHarness = {
  purging: boolean;
  persister: { destroy: () => Promise<void> };
  ctx: {
    storage: {
      get: <T>(key: string) => Promise<T | undefined>;
      deleteAll: () => Promise<void>;
      put: (key: string, value: boolean) => Promise<void>;
    };
    getWebSockets: () => Array<{ close: (code: number, reason: string) => void }>;
  };
  isErased: TaskDO["isErased"];
  purge: TaskDO["purge"];
};

function harness(options: { destroyError?: Error } = {}) {
  const events: string[] = [];
  const storage = new Map<string, boolean>();
  const taskDO = Object.create(TaskDO.prototype) as unknown as AdapterHarness;
  taskDO.purging = false;
  taskDO.persister = {
    destroy: async () => {
      events.push("persister.destroy");
      if (options.destroyError) throw options.destroyError;
    },
  };
  taskDO.ctx = {
    getWebSockets: () => [{
      close: (code, reason) => { events.push(`socket.close:${code}:${reason}`); },
    }],
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      deleteAll: async () => {
        events.push("storage.deleteAll");
        storage.clear();
      },
      put: async (key, value) => {
        events.push(`storage.put:${key}:${value}`);
        storage.set(key, value);
      },
    },
  };
  return { taskDO, events, storage };
}

describe("TaskDO persistence adapter", () => {
  it("keeps the durable storage identifiers stable", () => {
    expect(TASKDO_SQL_STORAGE_PREFIX).toBe("taskdo_");
    expect(TASKDO_FIXTURE_DELETED_KEY).toBe("fixtureDeleted");
  });

  it("stops sockets and the persister before deleting SQL, then leaves the erasure marker", async () => {
    const { taskDO, events, storage } = harness();

    await taskDO.purge();

    expect(events).toEqual([
      "socket.close:1000:Account erased",
      "persister.destroy",
      "storage.deleteAll",
      "storage.put:fixtureDeleted:true",
    ]);
    expect(storage.get("fixtureDeleted")).toBe(true);
    expect(await taskDO.isErased()).toBe(true);
  });

  it("treats an in-progress purge as erased so a replica cannot write during deletion", async () => {
    const { taskDO } = harness();
    taskDO.purging = true;
    expect(await taskDO.isErased()).toBe(true);
  });

  it("does not delete storage when stopping persistence fails and allows a retry", async () => {
    const { taskDO, events } = harness({ destroyError: new Error("stop failed") });

    await expect(taskDO.purge()).rejects.toThrow("stop failed");

    expect(events).toEqual([
      "socket.close:1000:Account erased",
      "persister.destroy",
    ]);
    expect(taskDO.purging).toBe(false);
  });
});
