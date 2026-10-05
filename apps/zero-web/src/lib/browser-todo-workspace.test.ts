import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchedule } from "@zeroapps/recurrence";
import { openBrowserTodoWorkspace, BROWSER_WORKSPACE_KEY } from "./browser-todo-workspace";
import type { BrowserTaskdoReplica } from "./browser-taskdo-replica";

class Locks {
  tails = new Map<string, Promise<unknown>>();
  failAccountSave = false;
  async request<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(name) ?? Promise.resolve();
    const pending = tail.catch(() => {}).then(() => {
      if (this.failAccountSave && name.includes("account-a-persistence")) throw new Error("Disk unavailable");
      return operation();
    });
    this.tails.set(name, pending);
    return pending;
  }
}

const opened: BrowserTaskdoReplica[] = [];
let locks: Locks;
const events = { onSnapshot: () => {}, onConnection: () => {}, onSyncState: () => {}, onDurability: () => {} };
async function open(account: string | null) {
  const replica = await openBrowserTodoWorkspace(account, events);
  opened.push(replica);
  return replica;
}

beforeEach(() => {
  localStorage.clear();
  locks = new Locks();
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((replica) => replica.close()));
  vi.unstubAllGlobals();
});

describe("browser guest workspaces", () => {
  it("keeps guest work through reopening without making a network request", async () => {
    const guest = await open(null);
    await guest.tasks.add("Buy milk").isPersisted.promise;
    await guest.close();
    const restored = await open(null);
    expect(restored.durable).toBe(true);
    expect(restored.snapshot().tasks.map((task) => task.text)).toEqual(["Buy milk"]);
  });

  it("adopts relationships, repeats, and order alongside existing account work", async () => {
    const account = await open("account-a");
    await account.tasks.add("Existing account task").isPersisted.promise;
    await account.close();
    const guest = await open(null);
    const project = guest.projects.add("Renovate");
    await project.isPersisted.promise;
    const projectId = String(project.mutations[0].key);
    const prerequisite = guest.projects.add("Permit");
    await prerequisite.isPersisted.promise;
    const prerequisiteId = String(prerequisite.mutations[0].key);
    await guest.waits.addWaiting(projectId, "Builder reply").isPersisted.promise;
    await guest.waits.addAfter(projectId, prerequisiteId).isPersisted.promise;
    const parsed = parseSchedule("Inspect every Monday", { today: "2026-09-30", weekStartsOn: "MO" });
    if (parsed.kind !== "scheduled" || parsed.schedule.kind !== "recurring") throw new Error("Expected recurrence");
    await guest.tasks.add("Inspect", parsed.schedule.recurrence.origin, projectId, parsed.schedule.recurrence).isPersisted.promise;
    const guestSnapshot = guest.snapshot();
    await guest.close();
    const adopted = await open("account-a");
    expect(adopted.snapshot().tasks.map((task) => task.text)).toEqual(expect.arrayContaining(["Existing account task", "Inspect"]));
    expect(adopted.snapshot().projects).toEqual(guestSnapshot.projects);
    expect(adopted.snapshot().conditions).toEqual(guestSnapshot.conditions);
    expect(adopted.snapshot().tasks.find((task) => task.text === "Inspect")).toEqual(guestSnapshot.tasks[0]);
    await adopted.close();
    const reopened = await open("account-a");
    expect(reopened.snapshot()).toEqual(adopted.snapshot());
  });

  it("isolates a fresh signed-out guest and a second account from the first account", async () => {
    const guest = await open(null);
    await guest.tasks.add("Private to A").isPersisted.promise;
    await guest.close();
    const first = await open("account-a");
    await first.close();
    const signedOut = await open(null);
    expect(signedOut.snapshot().tasks).toEqual([]);
    await signedOut.tasks.add("New guest work").isPersisted.promise;
    await signedOut.close();
    const second = await open("account-b");
    expect(second.snapshot().tasks.map((task) => task.text)).toEqual(["New guest work"]);
    const firstAgain = await open("account-a");
    expect(firstAgain.snapshot().tasks.map((task) => task.text)).toEqual(["Private to A"]);
  });

  it("rejects old guest-tab writes after the workspace is bound", async () => {
    const firstTab = await open(null);
    const secondTab = await open(null);
    await secondTab.tasks.add("Saved in second tab").isPersisted.promise;
    await firstTab.refresh();
    expect(firstTab.snapshot().tasks.map((task) => task.text)).toEqual(["Saved in second tab"]);
    const account = await open("account-a");
    await expect(secondTab.tasks.add("Stale edit").isPersisted.promise).rejects.toThrow("linked to an account");
    expect(account.snapshot().tasks.map((task) => task.text)).toEqual(["Saved in second tab"]);
  });

  it("retries an interrupted adoption only into the account that claimed it", async () => {
    const guest = await open(null);
    await guest.tasks.add("Keep after interrupted sign-in").isPersisted.promise;
    await guest.close();
    locks.failAccountSave = true;
    await expect(open("account-a")).rejects.toThrow("Disk unavailable");
    locks.failAccountSave = false;
    const otherAccount = await open("account-b");
    expect(otherAccount.snapshot().tasks).toEqual([]);
    const recovered = await open("account-a");
    expect(recovered.snapshot().tasks.map((task) => task.text)).toEqual(["Keep after interrupted sign-in"]);
    await recovered.close();
    const retried = await open("account-a");
    expect(retried.snapshot().tasks).toHaveLength(1);
  });

  it("lets only the first competing account claim guest work", async () => {
    const guest = await open(null);
    await guest.tasks.add("Adopt once").isPersisted.promise;
    await guest.close();
    const [first, second] = await Promise.all([open("account-a"), open("account-b")]);
    expect(first.snapshot().tasks.map((task) => task.text)).toEqual(["Adopt once"]);
    expect(second.snapshot().tasks).toEqual([]);
  });

  it.each([
    "broken",
    JSON.stringify({ version: 1, guest: "guest-saved", adoptions: [{ workspace: "guest-saved", account: "A" }] }),
    JSON.stringify({ version: 1, guest: null, adoptions: [{ workspace: "guest-saved", account: "A" }, { workspace: "guest-saved", account: "B" }] }),
  ])("reports malformed ownership information instead of replacing local work: %s", async (malformed) => {
    const guest = await open(null);
    await guest.tasks.add("Preserve me").isPersisted.promise;
    await guest.close();
    const saved = localStorage.getItem(BROWSER_WORKSPACE_KEY)!;
    localStorage.setItem(BROWSER_WORKSPACE_KEY, malformed);
    await expect(open(null)).rejects.toThrow();
    localStorage.setItem(BROWSER_WORKSPACE_KEY, saved);
    expect((await open(null)).snapshot().tasks[0].text).toBe("Preserve me");
  });
});
