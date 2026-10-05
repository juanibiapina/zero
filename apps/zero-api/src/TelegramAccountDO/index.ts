// TelegramAccountDO: one instance per Telegram account, keyed by the Telegram
// user id. It represents one Telegram account's claim on a Zero user: its
// identity is the Telegram account, its state is the answer to "who does this
// account belong to?". It is the counterpart of UserDO, which holds the same
// binding from the Clerk side.
//
// It is the SOURCE OF TRUTH for that binding; the `tg:{id}` KV entry is a
// derived cache. This is not a rebuildable index and must not be deleted as
// one: KV alone cannot answer a lookup in the minute after a link, because a
// colo that read the key before it existed keeps serving the cached miss (see
// docs/telegram-login.md).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

const OWNER_KEY = "clerkUserId";

export class TelegramAccountDO extends DurableObject<Env> {
  // The Clerk user this Telegram account belongs to, or null if unclaimed.
  async owner(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(OWNER_KEY)) ?? null;
  }

  // Bind this Telegram account to a Clerk user. A re-claim overwrites.
  async claim(clerkUserId: string): Promise<void> {
    await this.ctx.storage.put(OWNER_KEY, clerkUserId);
  }

  // Drop the binding, leaving the account unclaimed.
  async release(): Promise<void> {
    await this.ctx.storage.delete(OWNER_KEY);
  }
}
