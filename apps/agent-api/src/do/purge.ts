// Erasing one user, in the order that makes the erasure stick. Kept free of the
// Durable Objects so the order itself is testable (same shape as do/alarm.ts).
//
// The user's data is spread over four objects and two stores, and each of them
// can put data back into the next one. That is what the order is about:
//
//   1. Release the Telegram claim first. While it stands, an inbound message
//      still resolves to this user and writes fresh rows behind the purge.
//   2. Kill the deadlines and the learning job. Both exist to call back into
//      UserDO later, so they have to stop before UserDO is emptied.
//   3. Empty UserDO, which is the data the user actually means.
//   4. Purge deadlines and learning a second time. A learner slice that was
//      already mid-flight in step 2 runs for minutes and keeps writing topics
//      over RPC, so this catches what it re-armed. It cannot close the window
//      completely; a write that lands after this re-creates the object's schema
//      and pressing delete again removes it.
//   5. Abort the UserDO instance. Its SQLite is gone, so the live instance must
//      not serve another request, and nothing may write a schema back into an
//      object we just deallocated.
//
// Every step is idempotent, so a failed purge is safe to retry by pressing the
// button again.

export interface PurgeDeps {
  // The Telegram account to unclaim, or null when the user never linked one.
  telegramId: string | null;
  releaseTelegram: (telegramId: string) => Promise<void>;
  purgeSchedules: () => Promise<void>;
  purgeLearning: () => Promise<void>;
  purgeUser: () => Promise<void>;
  // ctx.abort() on UserDO. ALWAYS rejects on this side: the error it raises "is
  // not able to be caught within the application code", so the RPC connection
  // dies instead of returning. That rejection means it worked.
  resetUser: () => Promise<void>;
}

export const purgeUserData = async (deps: PurgeDeps): Promise<void> => {
  if (deps.telegramId !== null) await deps.releaseTelegram(deps.telegramId);

  await deps.purgeSchedules();
  await deps.purgeLearning();

  await deps.purgeUser();

  await deps.purgeSchedules();
  await deps.purgeLearning();

  try {
    await deps.resetUser();
  } catch {
    // Expected: aborting the object is how it is dropped.
  }
};
