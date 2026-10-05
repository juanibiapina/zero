// Typed ScheduleDO stub from env, with retry on transient DO errors. One
// instance per user, keyed by the same Clerk user id as UserDO and LearningDO.

import type { ScheduleDO } from "./index";
import type { Env } from "../types";
import { withDORetry } from "../do/retry";

export type ScheduleDOStub = DurableObjectStub<ScheduleDO>;

export const getScheduleDO = (env: Env, clerkUserId: string): ScheduleDOStub =>
  withDORetry(() => {
    const id = env.SCHEDULE_DO.idFromName(clerkUserId);
    return env.SCHEDULE_DO.get(id);
  });
