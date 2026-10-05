// Typed LearningDO stub from env, with retry on transient DO errors. One
// instance per user, keyed by the same Clerk user id as UserDO and ScheduleDO.

import type { LearningDO } from "./index";
import type { Env } from "../types";
import { withDORetry } from "../do/retry";

export type LearningDOStub = DurableObjectStub<LearningDO>;

export const getLearningDO = (env: Env, clerkUserId: string): LearningDOStub =>
  withDORetry(() => {
    const id = env.LEARNING_DO.idFromName(clerkUserId);
    return env.LEARNING_DO.get(id);
  });
