import type { Env } from "../types";

export const isTaskDOFixture = (env: Env, userId: string): boolean =>
  env.ENVIRONMENT === "test" && userId.startsWith("taskdo-proof-");

export const getTaskDO = (env: Env, userId: string) =>
  env.TASK_DO.get(env.TASK_DO.idFromName(userId));
