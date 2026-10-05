import type { Env } from "../types";

export const getTaskDO = (env: Env, userId: string) =>
  env.TASK_DO.get(env.TASK_DO.idFromName(userId));
