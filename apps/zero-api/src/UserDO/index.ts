import { DurableObject } from "cloudflare:workers";
import { createDb, eq, migrate, type Database } from "do-orm";
import { migrations } from "./db/migrations";
import { userSettings } from "./db/schema";
import type { Env } from "../types";

export interface UserSettings {
  createdAt: string | null;
  timezone: string | null;
  // True only on the access that seeded the row (the user's first ever read).
  isNewUser: boolean;
}

// One instance per Clerk user: the user's account settings. The todo data
// itself lives in TaskDO.
export class UserDO extends DurableObject<Env> {
  private db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  getSettings(): UserSettings {
    const row = this.db.get(userSettings);
    if (row) {
      return { createdAt: row.createdAt ?? null, timezone: row.timezone ?? null, isNewUser: false };
    }
    this.db.insert(userSettings, { createdAt: new Date().toISOString() });
    const seeded = this.db.get(userSettings)!;
    return { createdAt: seeded.createdAt ?? null, timezone: seeded.timezone ?? null, isNewUser: true };
  }

  updateSettings(patch: { timezone?: string }): void {
    const existing = this.db.get(userSettings);
    if (!existing) {
      this.db.insert(userSettings, { createdAt: new Date().toISOString(), ...patch });
      return;
    }
    if (patch.timezone !== undefined) {
      this.db.update(userSettings, { timezone: patch.timezone }, { where: eq("id", existing.id) });
    }
  }

  // Erase this user. The caller drops the instance with reset() afterwards.
  async deleteAllData(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  reset(): void {
    this.ctx.abort("user data deleted");
  }
}
