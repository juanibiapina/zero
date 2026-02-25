/**
 * ============================================================================
 * ProjectDO Database Schema
 * ============================================================================
 *
 * Per-repo DO storing session index and project settings.
 */

import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Lightweight session index for fast listing without fan-out.
 */
export const sessionIndexTable = sqliteTable("session_index", {
  id: int().primaryKey({ autoIncrement: true }),
  sessionDOId: text().notNull(),
  title: text().notNull(),
  status: text().notNull(), // SessionStatus
  provider: text().notNull(),
  model: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * Project settings.
 */
export const projectSettingsTable = sqliteTable("project_settings", {
  id: int().primaryKey({ autoIncrement: true }),
  key: text().notNull().unique(),
  value: text().notNull(),
});
