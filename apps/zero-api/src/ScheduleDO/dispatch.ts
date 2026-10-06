// Which object owns each kind of deadline, and how it is reached. Kept out of
// ScheduleDO so the table can be read, and tested, without a Durable Object.

import { getAssistantDO } from "../AssistantDO/stub";
import { getUserDO } from "../UserDO/stub";
import type { ScheduleReason } from "../do/schedule";
import type { Env } from "../types";

// What a dispatch is given: the user it belongs to, the bindings to reach the
// object that owns the work, and the conversation for the reasons that have one.
interface DispatchDeps {
  env: Env;
  clerkUserId: string;
  conversationId?: string;
}

// A total Record, so adding a reason to ScheduleReason without a handler is a
// compile error rather than a silent fall through to whichever branch happened
// to be last.
//
// Every entry is one RPC, because ScheduleDO holds *when* and never the work.
// Learning goes to AssistantDO, which starts a learner session and returns. A
// due schedule goes to UserDO, which hands its prompt to AssistantDO, so no LLM
// work happens on the schedule's alarm.
// Onboarding and admin tasks are the exception: those RPCs run their agent
// inline, which is the point of them living here rather than on the alarm that
// drains turns.
const DISPATCH: Record<
  ScheduleReason,
  (deps: DispatchDeps) => Promise<void>
> = {
  idle: ({ env, clerkUserId, conversationId }) =>
    getAssistantDO(env, clerkUserId).learn("idle", conversationId),
  size: ({ env, clerkUserId, conversationId }) =>
    getAssistantDO(env, clerkUserId).learn("size", conversationId),
  reminder: ({ env, clerkUserId }) =>
    getUserDO(env, clerkUserId).runDueSchedules(),
  onboarding: ({ env, clerkUserId }) =>
    getUserDO(env, clerkUserId).runQueuedOnboarding(),
  admin_task: ({ env, clerkUserId }) =>
    getUserDO(env, clerkUserId).runQueuedAdminTask(),
  // The hourly poll for replies on watched mail threads. Like a due schedule,
  // it only queues work on UserDO and returns: the turn a reply books runs on
  // UserDO's own alarm.
  mailwatch: ({ env, clerkUserId }) =>
    getUserDO(env, clerkUserId).checkTrackedMail(),
  // A week of silence came due. Like a due schedule, it only queues work on
  // UserDO and returns: the re-engagement turn runs on UserDO's own alarm.
  wake: ({ env, clerkUserId }) =>
    getUserDO(env, clerkUserId).wakeSleeper(),
};

// The handler for a persisted deadline, or null when nothing claims it.
//
// `reason` is a wire format: these strings sit in live DO storage, so a reason
// that was renamed or retired comes back with no handler. Such an entry is
// dropped with a loud log rather than retried, because no amount of backoff
// will produce a handler for it.
export const dispatchFor = (
  reason: string,
): ((deps: DispatchDeps) => Promise<void>) | null =>
  Object.hasOwn(DISPATCH, reason)
    ? DISPATCH[reason as ScheduleReason]
    : null;
