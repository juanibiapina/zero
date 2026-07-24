// One-off admin task state machine. The task deliberately remains `queued`
// while the model runs: a DO reset before the terminal write leaves it runnable
// on the next alarm rather than losing the requested work.

import { fmtErr, logError } from "../log";

export const ADMIN_TASK_KEY = "adminTask";
export const MAX_ADMIN_TASK_SUMMARY_CHARS = 1000;

export type AdminTask =
  | { clerkUserId: string; prompt: string; status: "queued" }
  | { clerkUserId: string; status: "done"; summary: string }
  | { clerkUserId: string; status: "failed" };

export type AdminTaskStatus =
  | { clerkUserId: string; status: "queued" }
  | { clerkUserId: string; status: "done"; summary: string }
  | { clerkUserId: string; status: "failed" };

export interface AdminTaskStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export const toAdminTaskStatus = (task: AdminTask): AdminTaskStatus => {
  if (task.status === "queued") {
    return { clerkUserId: task.clerkUserId, status: "queued" };
  }
  if (task.status === "done") {
    return {
      clerkUserId: task.clerkUserId,
      status: "done",
      summary: task.summary,
    };
  }
  return { clerkUserId: task.clerkUserId, status: "failed" };
};

// A queued task is the only conflict. Done and failed tasks are intentionally
// replaceable so an administrator can retry an incomplete task.
export const queueAdminTask = async (
  storage: AdminTaskStorage,
  task: Extract<AdminTask, { status: "queued" }>,
  now: number = Date.now(),
): Promise<boolean> => {
  const existing = await storage.get<AdminTask>(ADMIN_TASK_KEY);
  if (existing?.status === "queued") return false;
  await storage.put(ADMIN_TASK_KEY, task);
  // A DO has one alarm. Always replace it so this task runs now; its terminal
  // follow-up alarm lets pre-existing turn/onboarding work resume afterwards.
  await storage.setAlarm(now);
  return true;
};

export interface RunAdminTaskDeps {
  task: Extract<AdminTask, { status: "queued" }>;
  runAgent: (prompt: string) => Promise<string>;
  setTask: (task: AdminTask) => Promise<void>;
}

export const runAdminTask = async (deps: RunAdminTaskDeps): Promise<void> => {
  const { task, runAgent, setTask } = deps;
  try {
    const summary = await runAgent(task.prompt);
    await setTask({
      clerkUserId: task.clerkUserId,
      status: "done",
      summary: summary.trim().slice(0, MAX_ADMIN_TASK_SUMMARY_CHARS),
    });
  } catch (err) {
    logError("admin_task_failed", {
      clerk_user_id: task.clerkUserId,
      error: fmtErr(err),
    });
    await setTask({ clerkUserId: task.clerkUserId, status: "failed" });
  }
};
