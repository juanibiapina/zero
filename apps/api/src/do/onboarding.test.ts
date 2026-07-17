import { describe, expect, it, vi } from "vitest";
import { runOnboarding } from "./onboarding";
import { MemoryStore } from "../store/memory";

const deps = (over: Partial<Parameters<typeof runOnboarding>[0]> = {}) => {
  const store = new MemoryStore();
  const statuses: string[] = [];
  return {
    store,
    statuses,
    args: {
      store,
      topicName: "About You",
      description: "identity",
      runAgent: async () => {},
      setStatus: (s: string) => void statuses.push(s),
      ...over,
    },
  };
};

describe("runOnboarding", () => {
  it("creates and pins the topic, then marks done on success", async () => {
    const d = deps();
    await runOnboarding(d.args);
    expect(d.store.getTopic("About You")?.pinned).toBe(true);
    expect(d.statuses).toEqual(["done"]);
  });

  it("marks failed when the agent throws", async () => {
    const d = deps({
      runAgent: async () => {
        throw new Error("gateway down");
      },
    });
    await runOnboarding(d.args);
    // The topic is still created and pinned; only the run failed.
    expect(d.store.getTopic("About You")?.pinned).toBe(true);
    expect(d.statuses).toEqual(["failed"]);
  });

  it("re-running is idempotent: does not duplicate the topic or lose the pin", async () => {
    const d = deps();
    await runOnboarding(d.args);
    // Simulate the agent having written a body on the first run.
    d.store.updateTopicBody("About You", "name: Alice");
    await runOnboarding(d.args);
    expect(d.store.getPinnedTopics().map((t) => t.name)).toEqual(["About You"]);
    expect(d.store.getTopic("About You")?.body).toBe("name: Alice");
    expect(d.statuses).toEqual(["done", "done"]);
  });

  it("passes the pinned topic name to the agent", async () => {
    const runAgent = vi.fn(async () => {});
    const d = deps({ runAgent });
    await runOnboarding(d.args);
    expect(runAgent).toHaveBeenCalledWith("About You");
  });
});
