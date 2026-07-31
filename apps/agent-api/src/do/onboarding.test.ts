import { describe, expect, it, vi } from "vitest";
import { runOnboarding } from "./onboarding";
import { MemoryStore } from "../store/memory";
import { setBody } from "../store/test-support";

const deps = (over: Partial<Parameters<typeof runOnboarding>[0]> = {}) => {
  const store = new MemoryStore();
  const statuses: string[] = [];
  const notices: string[] = [];
  return {
    store,
    statuses,
    notices,
    args: {
      store,
      clerkUserId: "user_abc",
      topicName: "User",
      description: "identity",
      runAgent: async () => {},
      setStatus: (s: string) => void statuses.push(s),
      notify: async (m: string) => void notices.push(m),
      ...over,
    },
  };
};

describe("runOnboarding", () => {
  it("creates and pins the topic, then marks done on success", async () => {
    const d = deps();
    await runOnboarding(d.args);
    expect(d.store.getTopic("User")?.pinned).toBe(true);
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
    expect(d.store.getTopic("User")?.pinned).toBe(true);
    expect(d.statuses).toEqual(["failed"]);
  });

  it("re-running is idempotent: does not duplicate the topic or lose the pin", async () => {
    const d = deps();
    await runOnboarding(d.args);
    // Simulate the agent having written a body on the first run.
    setBody(d.store, "User", "name: Alice");
    await runOnboarding(d.args);
    expect(d.store.getPinnedTopics().map((t) => t.name)).toEqual(["User"]);
    expect(d.store.getTopic("User")?.body).toBe("name: Alice");
    expect(d.statuses).toEqual(["done", "done"]);
  });

  it("passes the pinned topic name to the agent", async () => {
    const runAgent = vi.fn(async () => {});
    const d = deps({ runAgent });
    await runOnboarding(d.args);
    expect(runAgent).toHaveBeenCalledWith("User");
  });

  it("reports the start and the successful end", async () => {
    const d = deps();
    await runOnboarding(d.args);
    expect(d.notices).toHaveLength(2);
    expect(d.notices[0]).toContain("Onboarding started: user_abc");
    expect(d.notices[1]).toContain("Onboarding done: user_abc");
  });

  it("reports the start and the failure, with the error message", async () => {
    const d = deps({
      runAgent: async () => {
        throw new Error("gateway down");
      },
    });
    await runOnboarding(d.args);
    expect(d.notices).toHaveLength(2);
    expect(d.notices[0]).toContain("Onboarding started: user_abc");
    expect(d.notices[1]).toContain("Onboarding failed: user_abc");
    expect(d.notices[1]).toContain("gateway down");
  });

  it("a failing notification does not change the outcome", async () => {
    const d = deps({
      notify: async () => {
        throw new Error("discord down");
      },
    });
    await runOnboarding(d.args);
    expect(d.statuses).toEqual(["done"]);
    expect(d.store.getTopic("User")?.pinned).toBe(true);
  });

  it("logs a start line and one terminal line", async () => {
    const lines: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args[0]);
    });
    const d = deps();
    await runOnboarding(d.args);
    vi.restoreAllMocks();

    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "onboarding_started",
        clerk_user_id: "user_abc",
      }),
    );
    const finished = (lines as Record<string, unknown>[]).find(
      (l) => l.msg === "onboarding_finished",
    );
    expect(finished).toMatchObject({
      clerk_user_id: "user_abc",
      status: "done",
    });
    expect(typeof finished?.duration_ms).toBe("number");
  });
});
