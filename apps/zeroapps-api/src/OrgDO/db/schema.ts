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

/**
 * A CI workload this org trusts. `owner_id`/`repo_id` are GitHub's immutable
 * numeric ids as strings, because the `sub` claim's format is not stable and
 * repository names get reused. `allowed_events` is a comma-separated opt-in
 * list for the events that would otherwise be refused (see @zero/auth).
 */
export const ciTrustsTable = table("ci_trusts", {
  id: column.integer().notNull().primaryKey().autoIncrement(),
  provider: column.text().notNull(),
  owner_id: column.text().notNull(),
  repo_id: column.text().notNull(),
  repository: column.text().notNull(),
  ref: column.text(),
  environment: column.text(),
  allowed_events: column.text().notNull(),
  label: column.text(),
  created_at: column.text().notNull(),
});
