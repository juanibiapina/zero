// One-off admin task state machine. The task deliberately remains `queued`
// while the model runs: a DO reset before the terminal write leaves it runnable
// on the next alarm rather than losing the requested work.

import { fmtErr, logError } from "../log";

export const ADMIN_TASK_KEY = "adminTask";
// Bounds one DO storage value, well inside the 128 KB per-value limit. Kept
// generous because the agent's real answers are markdown documents, and a tight
// cap truncated them mid-structure.
export const MAX_ADMIN_TASK_SUMMARY_CHARS = 16_000;

export type AdminTask =
  | { clerkUserId: string; prompt: string; status: "queued"; id?: string }
  | { clerkUserId: string; status: "done"; summary: string }
  | { clerkUserId: string; status: "failed" };

export type AdminTaskStatus =
  | { clerkUserId: string; status: "queued" }
  | { clerkUserId: string; status: "done"; summary: string }
  | { clerkUserId: string; status: "failed" };

export interface AdminTaskStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
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
): Promise<boolean> => {
  const existing = await storage.get<AdminTask>(ADMIN_TASK_KEY);
  if (existing?.status === "queued") return false;
  await storage.put(ADMIN_TASK_KEY, task);
  // No alarm here: the deadline for this job lives in ScheduleDO, so it can
  // never take UserDO's single alarm slot away from turn draining. The caller
  // (UserDO.queueAdminTask) asks the schedule to dispatch it.
  return true;
};

export interface RunAdminTaskDeps {
  task: Extract<AdminTask, { status: "queued" }>;
  runAgent: (prompt: string) => Promise<string>;
  setTask: (task: AdminTask) => Promise<void>;
  // Report a failed task to ZeroErrors. Optional and injected by the DO so
  // this module stays free of env; the task is terminal-failed, so the
  // requested work is lost until an administrator re-queues it.
  reportError?: (err: unknown) => Promise<void>;
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
    await deps.reportError?.(err);
    await setTask({ clerkUserId: task.clerkUserId, status: "failed" });
  }
};
