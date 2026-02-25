/**
 * ============================================================================
 * ProjectDO — Per-Repo Project State
 * ============================================================================
 *
 * One per GitHub repo. Stores:
 * - Session index (lightweight, for fast listing)
 * - Project settings
 *
 * Created with newUniqueId() (ref stored in UserDO).
 */

import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
// @ts-expect-error — Generated migrations file
import migrations from "./db/drizzle/migrations";
import { projectSettingsTable } from "./db/schema";
import type { Env } from "../types";
import { migrate } from "@zero/drizzle-migrator";

export class ProjectDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  // ============================================================================
  // Settings
  // ============================================================================

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .select()
      .from(projectSettingsTable)
      .where(eq(projectSettingsTable.key, key))
      .get();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    const existing = await this.getSetting(key);
    if (existing !== null) {
      await this.db
        .update(projectSettingsTable)
        .set({ value })
        .where(eq(projectSettingsTable.key, key));
    } else {
      await this.db.insert(projectSettingsTable).values({ key, value });
    }
  }
}
