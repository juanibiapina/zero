import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { createMergeableStore } from "tinybase";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  openBrowserTaskdoPersistence,
  TASKDO_BROWSER_DB_PREFIX,
  type BrowserTaskdoPersistence,
} from "./browser-taskdo-persistence";

class TestLockManager {
  readonly requests: string[] = [];
  fail = false;
  hold: Promise<void> | undefined;
  #tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.requests.push(name);
    if (this.fail) return Promise.reject(new Error("lock failed"));
    const previous = this.#tails.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await this.hold;
      return callback();
    });
    this.#tails.set(name, current);
    return current.finally(() => {
      if (this.#tails.get(name) === current) this.#tails.delete(name);
    });
  }
}

class TestBroadcastChannel extends EventTarget {
  static channels = new Map<string, Set<TestBroadcastChannel>>();
  static names: string[] = [];
  readonly name: string;

  constructor(name: string) {
    super();
    this.name = name;
    TestBroadcastChannel.names.push(name);
    const peers = TestBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    TestBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data: unknown) {
    for (const peer of TestBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) queueMicrotask(() => peer.dispatchEvent(new MessageEvent("message", { data })));
    }
  }

  close() {
    TestBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

type Opened = {
  store: ReturnType<typeof createMergeableStore>;
  persistence: BrowserTaskdoPersistence;
  durability: Array<[boolean, string | null]>;
};

const opened: BrowserTaskdoPersistence[] = [];
let locks: TestLockManager;
let visibility: DocumentVisibilityState;

async function open(accountId: string): Promise<Opened> {
  const store = createMergeableStore();
  const durability: Array<[boolean, string | null]> = [];
  const persistence = await openBrowserTaskdoPersistence({
    accountId,
    store,
    onDurability: (durable, error) => durability.push([durable, error]),
  });
  opened.push(persistence);
  return { store, persistence, durability };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  locks = new TestLockManager();
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: TestBroadcastChannel,
  });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  TestBroadcastChannel.channels.clear();
  TestBroadcastChannel.names = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((persistence) => persistence.close()));
  vi.restoreAllMocks();
});

describe("browser TaskDO persistence", () => {
  test("rejects an invalid account before opening browser persistence", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get: () => { throw new Error("IndexedDB was inspected"); },
    });

    await expect(open("not/an/account")).rejects.toThrow("Invalid account identity");
    expect(locks.requests).toEqual([]);
  });

  test("bootstraps the account database and loads it before returning", async () => {
    const first = await open("account-a");
    first.store.setCell("tasks", "task-a", "text", "Persisted before restart");
    await first.persistence.save();
    await first.persistence.close();

    const second = await open("account-a");

    expect(second.persistence.durable).toBe(true);
    expect(second.persistence.durabilityError).toBeNull();
    expect(second.store.getCell("tasks", "task-a", "text")).toBe("Persisted before restart");
    expect((await indexedDB.databases()).map(({ name }) => name)).toContain(
      `${TASKDO_BROWSER_DB_PREFIX}account-a`,
    );
    expect(locks.requests).toContain(`${TASKDO_BROWSER_DB_PREFIX}account-a-persistence`);
    expect(TestBroadcastChannel.names).toContain(`${TASKDO_BROWSER_DB_PREFIX}account-a-changes`);
  });

  test.each([
    ["Web Locks", "Web Locks are unavailable", () =>
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })],
    ["IndexedDB", "IndexedDB is unavailable", () =>
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined })],
  ])("keeps a functional in-memory store when %s is unavailable", async (_missing, message, removeCapability) => {
    removeCapability();

    const instance = await open("account-fallback");
    instance.store.setCell("tasks", "task-a", "text", "Still usable");
    await instance.persistence.save();
    await instance.persistence.refresh();

    expect(instance.store.getCell("tasks", "task-a", "text")).toBe("Still usable");
    expect(instance.persistence.durable).toBe(false);
    expect(instance.persistence.durabilityError).toContain(message);
    expect(instance.durability.at(-1)).toEqual([
      false,
      `Offline durability is unavailable: ${message}`,
    ]);
  });

  test("merges concurrent tab changes and notifies peers", async () => {
    const first = await open("account-tabs");
    const second = await open("account-tabs");

    first.store.setCell("tasks", "task-a", "text", "From first tab");
    second.store.setCell("tasks", "task-b", "text", "From second tab");
    await Promise.all([first.persistence.save(), second.persistence.save()]);

    await vi.waitFor(() => {
      expect(first.store.getCell("tasks", "task-b", "text")).toBe("From second tab");
      expect(second.store.getCell("tasks", "task-a", "text")).toBe("From first tab");
    });
    const reopened = await open("account-tabs");
    expect(reopened.store.getCell("tasks", "task-a", "text")).toBe("From first tab");
    expect(reopened.store.getCell("tasks", "task-b", "text")).toBe("From second tab");
  });

  test("persists direct table changes without recursively saving merges", async () => {
    const first = await open("account-listeners");
    first.store.setCell("tasks", "task-a", "text", "Task");
    first.store.setCell("projects", "project-a", "name", "Project");
    first.store.setCell("conditions", "condition-a", "type", "waiting");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await first.persistence.refresh();

    const reopened = await open("account-listeners");
    expect(reopened.store.getCell("tasks", "task-a", "text")).toBe("Task");
    expect(reopened.store.getCell("projects", "project-a", "name")).toBe("Project");
    expect(reopened.store.getCell("conditions", "condition-a", "type")).toBe("waiting");
  });

  test("polls only while visible and refreshes immediately when visibility resumes", async () => {
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
    visibility = "hidden";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(123 as never);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const reader = await open("account-visibility");
    const writer = await open("account-visibility");
    writer.store.setCell("tasks", "task-a", "text", "Written elsewhere");
    await writer.persistence.save();

    expect(reader.store.hasRow("tasks", "task-a")).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    visibility = "visible";
    reader.persistence.setVisible(true);
    await reader.persistence.refresh();
    expect(reader.store.hasRow("tasks", "task-a")).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);

    reader.store.delRow("tasks", "task-a");
    await reader.persistence.save();
    writer.store.setCell("tasks", "task-b", "text", "Safety refresh");
    await writer.persistence.save();
    expect(reader.store.hasRow("tasks", "task-b")).toBe(false);
    const safetyRefresh = setIntervalSpy.mock.calls[0]?.[0];
    expect(safetyRefresh).toBeTypeOf("function");
    (safetyRefresh as () => void)();
    await reader.persistence.refresh();
    expect(reader.store.hasRow("tasks", "task-b")).toBe(true);

    visibility = "hidden";
    reader.persistence.setVisible(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
  });

  test("reports failures after opening without breaking the live store", async () => {
    const instance = await open("account-failure");
    locks.fail = true;
    instance.store.setCell("tasks", "task-a", "text", "Unsaved but live");

    await instance.persistence.save();

    expect(instance.store.getCell("tasks", "task-a", "text")).toBe("Unsaved but live");
    expect(instance.persistence.durable).toBe(false);
    expect(instance.persistence.durabilityError).toContain("lock failed");
    expect(instance.durability.at(-1)?.[0]).toBe(false);
  });

  test("waits for pending persistence and stops accepting work after close", async () => {
    const instance = await open("account-close");
    instance.store.setCell("tasks", "task-before-close", "text", "Must finish saving");
    let release!: () => void;
    locks.hold = new Promise<void>((resolve) => { release = resolve; });
    const save = instance.persistence.save();
    let closed = false;
    const close = instance.persistence.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(closed).toBe(false);
    release();
    await Promise.all([save, close]);

    instance.store.setCell("tasks", "task-after-close", "text", "Must stay in memory");
    await instance.persistence.save();
    await instance.persistence.refresh();

    const reopened = await open("account-close");
    expect(reopened.store.getCell("tasks", "task-before-close", "text")).toBe("Must finish saving");
    expect(reopened.store.hasRow("tasks", "task-after-close")).toBe(false);
  });
});
