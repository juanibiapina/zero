// The whole policy for "which Zero user does this Telegram account belong to?".
// Callers (webhook, /start, /new, settings routes) go through here and do not
// learn that the mapping lives in two stores.
//
// Two stores, on purpose:
//
//   - KV `tg:{telegramId} → clerkUserId` is the hot path. The mapping never
//     changes once set, it is read on every inbound message, and an edge-cached
//     read is the fastest thing available.
//   - TelegramAccountDO is the authoritative record, consulted ONLY on a KV
//     miss. KV caches negative lookups per colo for ~60s, so a user who
//     messaged the bot before linking keeps getting "you are not linked" from
//     the webhook's colo for a minute after linking. The DO is strongly
//     consistent and answers immediately. Do not delete it as a redundant copy
//     of KV: it is the reason linking works on the next message.
//
// A miss happens twice in a user's life: the first-link propagation window, and
// a stranger messaging the bot. Settled traffic never touches the DO.

import { log } from "../log";
import { getTelegramAccountDO } from "../TelegramAccountDO/stub";
import type { Env } from "../types";

export const tgKey = (telegramId: string) => `tg:${telegramId}`;

// Cache first, authoritative record on a miss. Logs both outcomes so the
// backstop is visible in production: `telegram_account_fallback` proves the DO
// answered a lookup KV could not.
export const resolveClerkUserId = async (
  env: Env,
  telegramId: string,
): Promise<string | null> => {
  const cached = await env.KV.get(tgKey(telegramId));
  if (cached) return cached;

  const owner = await getTelegramAccountDO(env, telegramId).owner();
  if (!owner) {
    log("drop_unknown_telegram_id", { telegram_id: telegramId });
    return null;
  }

  log("telegram_account_fallback", {
    telegram_id: telegramId,
    clerk_user_id: owner,
  });
  return owner;
};

// Bind a Telegram account to a Clerk user, releasing a previous account of the
// same user. The authoritative record is written before the cache, so a crash
// between the two leaves the truth correct and the cache merely stale, which
// the read path already tolerates.
export const linkTelegramAccount = async (
  env: Env,
  telegramId: string,
  clerkUserId: string,
  previous?: string | null,
): Promise<void> => {
  await getTelegramAccountDO(env, telegramId).claim(clerkUserId);

  if (previous && previous !== telegramId) {
    await unlinkTelegramAccount(env, previous);
  }
  await env.KV.put(tgKey(telegramId), clerkUserId);
};

// Drop a Telegram account's claim from both stores.
export const unlinkTelegramAccount = async (
  env: Env,
  telegramId: string,
): Promise<void> => {
  await getTelegramAccountDO(env, telegramId).release();
  await env.KV.delete(tgKey(telegramId));
};
