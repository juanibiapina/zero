/**
 * ============================================================================
 * SessionDO Database Schema
 * ============================================================================
 *
 * Session metadata + persisted event log for WebSocket replay.
 */

import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Session metadata (single row per DO).
 */
export const sessionMetaTable = sqliteTable("session_meta", {
  id: int().primaryKey({ autoIncrement: true }),
  status: text().notNull(),
  projectOwner: text().notNull(),
  projectRepo: text().notNull(),
  provider: text().notNull(),
  model: text().notNull(),
  thinkingLevel: text(),     // "off" | "low" | "medium" | "high" — null = model default
  userDOId: text(),          // UserDO ID for status sync callbacks
  createdAt: text().notNull(),
});

/**
 * Persisted event log — all agent + user + system events.
 * `seq` is SessionDO's own monotonic counter (used for client dedup/resume).
 * `containerSeq` is the container's original SSE seq (used for SSE reconnection).
 */
export const sessionEventsTable = sqliteTable("session_events", {
  id: int().primaryKey({ autoIncrement: true }),
  seq: int().notNull().unique(),
  containerSeq: int(),
  source: text().notNull(),
  eventType: text().notNull(),
  data: text().notNull(),
  createdAt: text().notNull(),
});
