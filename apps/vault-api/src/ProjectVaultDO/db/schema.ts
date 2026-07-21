/**
 * ============================================================================
 * ProjectVaultDO Database Schema
 * ============================================================================
 *
 * Per-project SQLite schema inside ProjectVaultDO. Stores this project's DEK,
 * environments, and encrypted secrets. There is no `projects` table and no
 * `project_id` — the DO IS the project.
 *
 * Property names must match SQL column names (do-orm uses them directly).
 */

import { table, column } from "do-orm";

export const vaultConfigTable = table("vault_config", {
  key: column.text().notNull().primaryKey(),
  value: column.text().notNull(),
});

export const environmentsTable = table("environments", {
  id: column.text().notNull().primaryKey(),
  name: column.text().notNull().unique(),
  created_at: column.text().notNull(),
});

export const secretsTable = table("secrets", {
  id: column.text().notNull().primaryKey(),
  environment_id: column.text().notNull(),
  key_encrypted: column.text().notNull(),
  key_hash: column.text().notNull(),
  value_encrypted: column.text().notNull(),
  updated_at: column.text().notNull(),
});
