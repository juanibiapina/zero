import type { AssistantDO } from "./index";
import type { Env } from "../types";
import { withDORetry } from "../do/retry";

export type AssistantDOStub = DurableObjectStub<AssistantDO>;

export const getAssistantDO = (env: Env, clerkUserId: string): AssistantDOStub =>
  withDORetry(() => env.ASSISTANT_DO.get(env.ASSISTANT_DO.idFromName(clerkUserId)));
