import { localDayInZone } from "./dates";
import { DEFAULT_TIMEZONE } from "./timezone";
import type { Env } from "./types";
import { getUserDO } from "./UserDO/stub";

export type ResolveToday = (env: Env, userId: string) => Promise<string>;

export const userToday: ResolveToday = async (env, userId) => {
  const { timezone } = await getUserDO(env, userId).getSettings();
  return localDayInZone(new Date(), timezone ?? DEFAULT_TIMEZONE);
};
