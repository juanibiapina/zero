// Erasing one user, in the order that makes the erasure stick. Kept free of the
// Durable Objects so the order itself is testable.
//
//   1. Empty TaskDO, then UserDO. Both steps must succeed before the caller may
//      report the data as gone.
//   2. Abort both instances. Their SQLite is gone, so a live instance must not
//      serve another request or write a schema back into a deallocated object.
//      ctx.abort() ALWAYS rejects on the caller's side: the error it raises "is
//      not able to be caught within the application code", so the RPC connection
//      dies instead of returning. That rejection means it worked.
//
// Every step is idempotent, so a failed purge is safe to retry by pressing the
// button again.

export interface PurgeDeps {
  purgeTasks: () => Promise<void>;
  purgeUser: () => Promise<void>;
  resetTasks: () => Promise<void>;
  resetUser: () => Promise<void>;
}

export const purgeUserData = async (deps: PurgeDeps): Promise<void> => {
  await deps.purgeTasks();
  await deps.purgeUser();

  try {
    await deps.resetTasks();
  } catch {
    // Expected: aborting the object is how it is dropped.
  }
  try {
    await deps.resetUser();
  } catch {
    // Expected: aborting the object is how it is dropped.
  }
};
