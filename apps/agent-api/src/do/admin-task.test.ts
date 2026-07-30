import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_TASK_KEY,
  MAX_ADMIN_TASK_SUMMARY_CHARS,
  queueAdminTask,
  runAdminTask,
  toAdminTaskStatus,
  type AdminTask,
} from "./admin-task";

const makeStorage = (task?: AdminTask) => {
  const values = new Map<string, unknown>();
  if (task) values.set(ADMIN_TASK_KEY, task);
  const alarms: number[] = [];
  return {
    values,
    alarms,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void values.set(key, value),
      setAlarm: async (time: number) => void alarms.push(time),
    },
  };
};

describe("admin task", () => {
  it("queues a task and rejects a second queued task", async () => {
    const d = makeStorage();
    const first = await queueAdminTask(d.storage, {
      clerkUserId: "user_1",
      prompt: "organize notes",
      status: "queued",
    });
    const second = await queueAdminTask(d.storage, {
      clerkUserId: "user_1",
      prompt: "another task",
      status: "queued",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Queueing never touches UserDO's alarm: that slot belongs to turn draining,
    // and the deadline for this job lives in ScheduleDO.
    expect(d.alarms).toEqual([]);
  });

  it("replaces a terminal task for a manual retry", async () => {
    const d = makeStorage({ clerkUserId: "user_1", status: "failed" });
    await queueAdminTask(d.storage, {
      clerkUserId: "user_1",
      prompt: "retry",
      status: "queued",
    });

    expect(d.values.get(ADMIN_TASK_KEY)).toEqual({
      clerkUserId: "user_1",
      prompt: "retry",
      status: "queued",
    });
  });

  it("removes the prompt and bounds the terminal summary on success", async () => {
    const d = makeStorage({
      clerkUserId: "user_1",
      prompt: "private instruction",
      status: "queued",
    });
    await runAdminTask({
      task: d.values.get(ADMIN_TASK_KEY) as Extract<
        AdminTask,
        { status: "queued" }
      >,
      runAgent: async () => `  ${"x".repeat(MAX_ADMIN_TASK_SUMMARY_CHARS + 1)}  `,
      setTask: async (task) => void d.values.set(ADMIN_TASK_KEY, task),
    });

    expect(d.values.get(ADMIN_TASK_KEY)).toEqual({
      clerkUserId: "user_1",
      status: "done",
      summary: "x".repeat(MAX_ADMIN_TASK_SUMMARY_CHARS),
    });
  });

  it("marks failed when the agent throws", async () => {
    const setTask = vi.fn(async (_task: AdminTask) => {});
    await runAdminTask({
      task: { clerkUserId: "user_1", prompt: "notes", status: "queued" },
      runAgent: async () => {
        throw new Error("gateway down");
      },
      setTask,
    });
    expect(setTask).toHaveBeenCalledWith({
      clerkUserId: "user_1",
      status: "failed",
    });
  });

  it("does not replace a queued record until the agent completes", async () => {
    let resolve!: (summary: string) => void;
    const pending = new Promise<string>((r) => { resolve = r; });
    const setTask = vi.fn(async (_task: AdminTask) => {});
    const run = runAdminTask({
      task: { clerkUserId: "user_1", prompt: "notes", status: "queued" },
      runAgent: async () => pending,
      setTask,
    });

    await Promise.resolve();
    expect(setTask).not.toHaveBeenCalled();
    resolve("Completed the task.");
    await run;
    expect(setTask).toHaveBeenCalledWith({
      clerkUserId: "user_1",
      status: "done",
      summary: "Completed the task.",
    });
  });

  it("redacts the prompt from status responses", () => {
    expect(
      toAdminTaskStatus({
        clerkUserId: "user_1",
        prompt: "private instruction",
        status: "queued",
      }),
    ).toEqual({ clerkUserId: "user_1", status: "queued" });
  });
});
