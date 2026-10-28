import { describe, expect, it, vi } from "vitest";

vi.mock("tinybase/synchronizers/synchronizer-ws-server-durable-object", () => ({
  WsServerDurableObject: class {},
}));

import { RecordingModel } from "@zero/agent-core";
import { createMergeableStore } from "tinybase";

import type { Titler } from "../transcription/titler";
import { TaskDomain } from "./domain";
import {
  TASKDO_FIXTURE_DELETED_KEY,
  TASKDO_SQL_STORAGE_PREFIX,
  TaskDO,
} from "./index";

type AdapterHarness = {
  purging: boolean;
  persister: { destroy: () => Promise<void> };
  domain: TaskDomain;
  env: Record<string, unknown>;
  ctx: {
    storage: {
      get: <T>(key: string) => Promise<T | undefined>;
      deleteAll: () => Promise<void>;
      deleteAlarm: () => Promise<void>;
      setAlarm: (at: number) => Promise<void>;
      put: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      list: <T>(options: { prefix: string }) => Promise<Map<string, T>>;
    };
    getWebSockets: () => Array<{ close: (code: number, reason: string) => void }>;
  };
  createTitler: () => Titler;
  isErased: TaskDO["isErased"];
  purge: TaskDO["purge"];
  alarm: TaskDO["alarm"];
  scheduleUntitled: TaskDO["scheduleUntitled"];
  setRecordingTranscript: TaskDO["setRecordingTranscript"];
};

function harness(options: { destroyError?: Error } = {}) {
  const events: string[] = [];
  const storage = new Map<string, unknown>();
  const alarms: number[] = [];
  const store = createMergeableStore();
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
      deleteAlarm: async () => { events.push("storage.deleteAlarm"); },
      setAlarm: async (at) => { alarms.push(at); },
      put: async (key, value) => {
        if (typeof value === "boolean") events.push(`storage.put:${key}:${value}`);
        storage.set(key, value);
      },
      delete: async (key) => storage.delete(key),
      list: async <T>({ prefix }: { prefix: string }) =>
        new Map([...storage].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    },
  };
  taskDO.env = {};
  taskDO.domain = new TaskDomain({ store, save: async () => {}, isErased: () => taskDO.isErased() });
  const titles: string[] = [];
  taskDO.createTitler = () => ({ model: "fake", title: async () => titles.shift() ?? "A title" });
  const recordings = new RecordingModel(store);
  const add = (id: string) =>
    recordings.add({ id, startedAt: "2026-10-20T18:30:00.000Z", timeZone: "Europe/Berlin", durationMs: 1000, source: "app", device: "Pixel 7" });
  return { taskDO, events, storage, alarms, recordings, add, titles };
}

const spoken = (text: string) => ({ text, verbatim: text, model: "m", transcribedAt: "2026-10-20T18:31:00.000Z" });

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
      "storage.deleteAlarm",
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

describe("TaskDO recording titles", () => {
  it("wakes to title a voice note as soon as its transcript has text", async () => {
    const { taskDO, alarms, add, recordings } = harness();
    add("r1");

    expect(await taskDO.setRecordingTranscript("r1", spoken("Call Ana."))).toBe("set");
    expect(alarms).toHaveLength(1);

    await taskDO.alarm();
    expect(recordings.get("r1")?.title).toBe("A title");
  });

  it("does not wake for a silent note", async () => {
    const { taskDO, alarms, add } = harness();
    add("r1");

    await taskDO.setRecordingTranscript("r1", spoken(""));
    expect(alarms).toEqual([]);
  });

  it("wakes on start when a voice note is still untitled", async () => {
    const { taskDO, alarms, add, recordings } = harness();
    add("titled");
    recordings.setTranscript("titled", spoken("Buy grout."));
    recordings.setTitle("titled", "Buy grout");
    await taskDO.scheduleUntitled();
    expect(alarms).toEqual([]);

    add("old");
    recordings.setTranscript("old", spoken("Call Ana."));
    await taskDO.scheduleUntitled();
    expect(alarms).toHaveLength(1);
  });

  it("keeps a failed attempt in storage and wakes again for the retry", async () => {
    const { taskDO, alarms, add, recordings, storage } = harness();
    taskDO.createTitler = () => ({ model: "fake", title: async () => { throw new Error("down"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    add("r1");
    recordings.setTranscript("r1", spoken("Call Ana."));

    await taskDO.alarm();

    expect(storage.get("recordingTitle:r1")).toMatchObject({ attempts: 1, reported: false });
    expect(alarms).toHaveLength(1);
  });

  it("does nothing when the alarm fires for an erased account", async () => {
    const { taskDO, alarms, add, recordings, storage } = harness();
    add("r1");
    recordings.setTranscript("r1", spoken("Call Ana."));
    storage.set("fixtureDeleted", true);

    await taskDO.alarm();
    await taskDO.scheduleUntitled();

    expect(recordings.get("r1")?.title).toBeNull();
    expect(alarms).toEqual([]);
  });
});
