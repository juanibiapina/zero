import type { Env } from "../types";
import { getUserDO } from "../UserDO/stub";

export const isTaskDOFixture = (env: Env, userId: string): boolean =>
  env.ENVIRONMENT === "test" && userId.startsWith("taskdo-proof-");

export const getTaskDO = (env: Env, userId: string) =>
  env.TASK_DO.get(env.TASK_DO.idFromName(userId));

export const usesTaskDO = async (env: Env, userId: string): Promise<boolean> => {
  if (isTaskDOFixture(env, userId)) return true;
  // Older route-test environments omit ENVIRONMENT and predate this RPC.
  // Deployed and local Workers always set production/development explicitly.
  if (!env.ENVIRONMENT) return false;
  return (await getUserDO(env, userId).getTodoAuthority()).authority === "switched";
};
