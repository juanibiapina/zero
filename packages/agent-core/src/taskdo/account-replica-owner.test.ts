import { describe, expect, it, vi } from "vitest";

import type { TaskdoReplica, TodoSnapshot } from "./replica";
import {
  createAccountTaskdoReplicaOwner,
  selectAccountTaskdoReplicaState,
  type AccountTaskdoReplicaEvents,
  type AccountTaskdoReplicaState,
  type OpenAccountTaskdoReplica,
} from "./account-replica-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function snapshot(recoveryId?: string): TodoSnapshot {
  return {
    tasks: [],
    projects: [],
    conditions: [],
    medicines: [],
    doses: [],
    recoveries: recoveryId
      ? [{ table: "tasks", id: recoveryId, text: recoveryId, reason: "Invalid Task" }]
      : [],
  };
}

function replica(id: string, close = vi.fn(async () => {})): TaskdoReplica {
  return {
    close,
    snapshot: () => snapshot(id),
  } as unknown as TaskdoReplica;
}

function opened(value: TaskdoReplica, durable = true) {
  return { replica: value, durability: { durable, error: null } };
}

function accountState(accountId: string | null): AccountTaskdoReplicaState {
  return {
    accountId,
    replica: accountId ? replica(accountId) : null,
    ready: accountId !== null,
    connected: accountId !== null,
    sync: { phase: accountId ? "synced" : "offline", lastSyncedAt: null },
    durable: false,
    error: accountId ? "current error" : null,
    durabilityError: "current durability error",
    recoveries: accountId ? snapshot(accountId).recoveries : [],
  };
}

describe("account TaskDO replica client state", () => {
  it("selects the matching account without exposing its identity", () => {
    const state = selectAccountTaskdoReplicaState(accountState("A"), "A");

    expect(state).toMatchObject({
      ready: true,
      connected: true,
      durable: false,
      error: "current error",
      durabilityError: "current durability error",
      recoveries: snapshot("A").recoveries,
    });
    expect(state).not.toHaveProperty("accountId");
  });

  it("hides a stale account with the requested fallback durability", () => {
    expect(selectAccountTaskdoReplicaState(
      accountState("A"),
      "B",
      { durable: false, error: "not persisted" },
    )).toEqual({
      replica: null,
      ready: false,
      connected: false,
      sync: { phase: "offline", lastSyncedAt: null },
      durable: false,
      error: null,
      durabilityError: "not persisted",
      recoveries: [],
    });
  });

  it("uses durable local state by default while hiding a stale account", () => {
    expect(selectAccountTaskdoReplicaState(accountState("A"), "B")).toMatchObject({
      replica: null,
      ready: false,
      durable: true,
      durabilityError: null,
    });
  });

  it("selects the signed-out state when both account identities are null", () => {
    const state = selectAccountTaskdoReplicaState(accountState(null), null);

    expect(state).toMatchObject({
      replica: null,
      ready: false,
      durable: false,
      durabilityError: "current durability error",
    });
    expect(state).not.toHaveProperty("accountId");
  });
});

describe("account TaskDO replica owner", () => {
  it("does not open without an account and immediately hides a signed-out account", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn<OpenAccountTaskdoReplica>(async () => opened(replica("A", close)));
    const owner = createAccountTaskdoReplicaOwner({ open });

    expect(owner.getSnapshot()).toMatchObject({ accountId: null, replica: null, ready: false });
    expect(open).not.toHaveBeenCalled();

    await owner.setAccount("A");
    const signingOut = owner.setAccount(null);
    expect(owner.getSnapshot()).toMatchObject({ accountId: null, replica: null, ready: false });
    await signingOut;
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains current-account events emitted while its replica opens", async () => {
    const pending = deferred<ReturnType<typeof opened>>();
    let events!: AccountTaskdoReplicaEvents;
    const owner = createAccountTaskdoReplicaOwner({
      initialDurability: { durable: false, error: null },
      open: async (_accountId, nextEvents) => {
        events = nextEvents;
        return pending.promise;
      },
    });

    const opening = owner.setAccount("A");
    await Promise.resolve();
    events.onSnapshot(snapshot("during-open"));
    events.onConnection(true);
    events.onDurability(true, "durability detail");
    expect(owner.getSnapshot()).toMatchObject({
      accountId: "A",
      connected: true,
      durable: true,
      durabilityError: "durability detail",
      ready: false,
    });

    const value = replica("resolved");
    pending.resolve(opened(value, false));
    await opening;
    expect(owner.getSnapshot()).toMatchObject({
      accountId: "A",
      replica: value,
      ready: true,
      connected: true,
      durable: true,
      recoveries: snapshot("during-open").recoveries,
    });
  });

  it("closes the previous account before opening and exposing the next", async () => {
    const order: string[] = [];
    const a = replica("A", vi.fn(async () => { order.push("close A"); }));
    const b = replica("B");
    const owner = createAccountTaskdoReplicaOwner({
      open: async (accountId) => {
        order.push(`open ${accountId}`);
        return opened(accountId === "A" ? a : b);
      },
    });

    await owner.setAccount("A");
    const switching = owner.setAccount("B");
    expect(owner.getSnapshot()).toMatchObject({ accountId: "B", replica: null, ready: false });
    await switching;
    expect(order).toEqual(["open A", "close A", "open B"]);
    expect(owner.getSnapshot()).toMatchObject({ accountId: "B", replica: b, ready: true });
  });

  it("exposes only the last account across rapid switches and closes stale handles once", async () => {
    const aPending = deferred<ReturnType<typeof opened>>();
    const closeA = vi.fn(async () => {});
    const opens: string[] = [];
    const c = replica("C");
    const owner = createAccountTaskdoReplicaOwner({
      open: async (accountId) => {
        opens.push(accountId);
        if (accountId === "A") return aPending.promise;
        return opened(c);
      },
    });

    const openingA = owner.setAccount("A");
    await Promise.resolve();
    const switchingB = owner.setAccount("B");
    const switchingC = owner.setAccount("C");
    expect(owner.getSnapshot()).toMatchObject({ accountId: "C", replica: null, ready: false });
    aPending.resolve(opened(replica("A", closeA)));
    await Promise.all([openingA, switchingB, switchingC]);

    expect(opens).toEqual(["A", "C"]);
    expect(closeA).toHaveBeenCalledOnce();
    expect(owner.getSnapshot()).toMatchObject({ accountId: "C", replica: c, ready: true });
  });

  it("closes a late open after sign-out and never exposes it", async () => {
    const pending = deferred<ReturnType<typeof opened>>();
    const close = vi.fn(async () => {});
    const owner = createAccountTaskdoReplicaOwner({ open: () => pending.promise });

    const opening = owner.setAccount("A");
    await Promise.resolve();
    const signingOut = owner.setAccount(null);
    pending.resolve(opened(replica("A", close)));
    await Promise.all([opening, signingOut]);

    expect(close).toHaveBeenCalledOnce();
    expect(owner.getSnapshot()).toMatchObject({ accountId: null, replica: null, ready: false });
  });

  it("ignores callbacks and errors from stale accounts", async () => {
    const aPending = deferred<ReturnType<typeof opened>>();
    let aEvents!: AccountTaskdoReplicaEvents;
    const owner = createAccountTaskdoReplicaOwner({
      open: async (accountId, events) => {
        if (accountId === "A") {
          aEvents = events;
          return aPending.promise;
        }
        return opened(replica("B"));
      },
    });

    const openingA = owner.setAccount("A");
    await Promise.resolve();
    const openingB = owner.setAccount("B");
    aPending.reject(new Error("stale failure"));
    await Promise.all([openingA, openingB]);
    aEvents.onSnapshot(snapshot("stale"));
    aEvents.onConnection(true);
    aEvents.onDurability(false, "stale durability");

    expect(owner.getSnapshot()).toMatchObject({
      accountId: "B",
      error: null,
      connected: false,
      durable: true,
      durabilityError: null,
      recoveries: snapshot("B").recoveries,
    });
  });

  it("surfaces the current open failure and can retry safely", async () => {
    let attempts = 0;
    const value = replica("A");
    const owner = createAccountTaskdoReplicaOwner({
      open: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("open failed");
        return opened(value);
      },
    });

    await owner.setAccount("A");
    expect(owner.getSnapshot()).toMatchObject({ accountId: "A", ready: false, error: "Error: open failed" });
    await owner.setAccount("A");
    expect(owner.getSnapshot()).toMatchObject({ accountId: "A", replica: value, ready: true, error: null });
  });

  it("closes idempotently, waits for pending teardown, and ignores future work", async () => {
    const pending = deferred<ReturnType<typeof opened>>();
    const close = vi.fn(async () => {});
    let events!: AccountTaskdoReplicaEvents;
    const open = vi.fn<OpenAccountTaskdoReplica>((_accountId, nextEvents) => {
      events = nextEvents;
      return pending.promise;
    });
    const owner = createAccountTaskdoReplicaOwner({ open });
    const notifications = vi.fn();
    owner.subscribe(notifications);
    void owner.setAccount("A");
    await Promise.resolve();

    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    pending.resolve(opened(replica("A", close)));
    await closing;
    await owner.setAccount("B");
    const countAfterClose = notifications.mock.calls.length;
    events.onSnapshot(snapshot("late"));
    events.onConnection(true);
    events.onDurability(false, "late");

    expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(owner.getSnapshot()).toMatchObject({ accountId: null, replica: null, ready: false });
    expect(countAfterClose).toBeGreaterThan(0);
    expect(notifications).toHaveBeenCalledTimes(countAfterClose);
  });

  it("does not overlap accounts when close rejects and can recover on a later switch", async () => {
    const opens: string[] = [];
    const closeA = vi.fn(async () => { throw new Error("close failed"); });
    const owner = createAccountTaskdoReplicaOwner({
      open: async (accountId) => {
        opens.push(accountId);
        return opened(replica(accountId, accountId === "A" ? closeA : vi.fn(async () => {})));
      },
    });

    await owner.setAccount("A");
    await owner.setAccount("B");
    expect(opens).toEqual(["A"]);
    expect(owner.getSnapshot()).toMatchObject({ accountId: "B", ready: false, error: "Error: close failed" });

    await owner.setAccount("C");
    expect(opens).toEqual(["A", "C"]);
    expect(closeA).toHaveBeenCalledOnce();
    expect(owner.getSnapshot()).toMatchObject({ accountId: "C", ready: true, error: null });
  });
});
