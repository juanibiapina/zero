/**
 * ============================================================================
 * OrgDO Database Schema
 * ============================================================================
 *
 * Per-org SQLite schema inside OrgDO. Holds the project registry and the org's
 * API key metadata. Stores no ciphertext, so it has no DEK / vault_config.
 *
 * Property names must match SQL column names (do-orm uses them directly).
 */

import { table, column } from "do-orm";

export const projectsTable = table("projects", {
  id: column.text().notNull().primaryKey(),
  name: column.text().notNull().unique(),
  created_at: column.text().notNull(),
});

export const apiKeysTable = table("api_keys", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  key_hash: column.text().notNull().unique(),
  prefix: column.text().notNull(),
  suffix: column.text().notNull(),
  label: column.text(),
  encrypted_key: column.text(),
  created_at: column.text().notNull(),
});
