/**
 * ============================================================================
 * ErrorsDO Database Schema
 * ============================================================================
 *
 * Per-org SQLite schema inside ErrorsDO. One row per distinct bug in `issues`,
 * one row per occurrence in `events`. The DO is already org-scoped
 * (idFromName(orgId)), so the fingerprint does not include the org.
 *
 * Property names must match SQL column names (do-orm uses them directly).
 */

import { table, column } from "do-orm";

export const issuesTable = table("issues", {
  id: column.text().notNull().primaryKey(),
  fingerprint: column.text().notNull().unique(),
  project: column.text().notNull(),
  title: column.text().notNull(),
  level: column.text().notNull(),
  status: column.text().notNull(),
  count: column.integer().notNull(),
  first_seen_at: column.text().notNull(),
  last_seen_at: column.text().notNull(),
});

export const eventsTable = table("events", {
  id: column.text().notNull().primaryKey(),
  issue_id: column.text().notNull(),
  message: column.text().notNull(),
  stack: column.text(),
  context_json: column.text(),
  user_id: column.text().notNull(),
  created_at: column.text().notNull(),
});
