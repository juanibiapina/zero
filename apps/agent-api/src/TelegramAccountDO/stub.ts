// Typed TelegramAccountDO stub from env, with retry on transient DO errors.
// One instance per Telegram account, keyed by the bare Telegram user id (the
// namespace is Telegram-only, so a prefix would be noise that can never be
// changed without orphaning state).

import type { TelegramAccountDO } from "./index";
import type { Env } from "../types";
import { withDORetry } from "../do/retry";

export type TelegramAccountDOStub = DurableObjectStub<TelegramAccountDO>;

export const getTelegramAccountDO = (
  env: Env,
  telegramId: string,
): TelegramAccountDOStub =>
  withDORetry(() => {
    const id = env.TELEGRAM_ACCOUNT_DO.idFromName(telegramId);
    return env.TELEGRAM_ACCOUNT_DO.get(id);
  });
