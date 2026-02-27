/**
 * ============================================================================
 * UserDO Database Schema
 * ============================================================================
 *
 * Stores provider credentials, GitHub installations, project references,
 * and PKCE verifiers for OAuth flows.
 */

import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Provider credentials — OAuth tokens or API keys for AI providers.
 */
export const providerCredentialsTable = sqliteTable("provider_credentials", {
  id: int().primaryKey({ autoIncrement: true }),
  provider: text().notNull(),
  credentialType: text().notNull(), // 'oauth' | 'api_key'
  // OAuth fields
  accessToken: text(),
  refreshToken: text(),
  expiresAt: text(),
  // API key field
  apiKey: text(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * GitHub App installations for this user.
 */
export const githubInstallationsTable = sqliteTable("github_installations", {
  id: int().primaryKey({ autoIncrement: true }),
  installationId: int().notNull().unique(),
  accountLogin: text().notNull(),
  accountType: text().notNull(), // 'User' | 'Organization'
  createdAt: text().notNull(),
});

/**
 * Project references — maps owner/repo to project settings and cached GitHub metadata.
 */
export const projectsTable = sqliteTable("projects", {
  id: int().primaryKey({ autoIncrement: true }),
  owner: text().notNull(),
  repo: text().notNull(),
  fullName: text(),
  description: text(),
  defaultBranch: text(),
  isPrivate: int({ mode: "boolean" }),
  archived: int({ mode: "boolean" }),
  defaultProvider: text(),
  defaultModel: text(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * PKCE verifiers for in-progress OAuth flows.
 * Keyed by a random state token, cleaned up after use.
 */
export const pkceVerifiersTable = sqliteTable("pkce_verifiers", {
  id: int().primaryKey({ autoIncrement: true }),
  state: text().notNull().unique(),
  verifier: text().notNull(),
  provider: text().notNull(),
  createdAt: text().notNull(),
});

/**
 * User-level secrets — named environment variables injected into all agent sessions.
 * Values are stored plaintext (DO storage is encrypted at rest by Cloudflare).
 * Values are never returned via the API — only names and metadata.
 */
export const userSecretsTable = sqliteTable("user_secrets", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
  value: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * User-level settings — key/value store for UI preferences (hotkey prefix, etc.).
 * Extensible: new settings are added as new keys without schema migrations.
 */
export const userSettingsTable = sqliteTable("user_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * Prompt templates — user-managed templates invoked via /slug in chat.
 * Content supports $ARGUMENTS placeholder for argument substitution.
 */
export const promptTemplatesTable = sqliteTable("prompt_templates", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  slug: text().notNull().unique(),
  content: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/**
 * Top-level session index — all sessions for this user across all projects.
 * Status is kept in sync by SessionDO on every status transition.
 */
export const sessionsTable = sqliteTable("sessions", {
  id: int().primaryKey({ autoIncrement: true }),
  sessionDOId: text().notNull().unique(),
  owner: text().notNull(),
  repo: text().notNull(),
  title: text().notNull(),
  status: text().notNull(),
  provider: text().notNull(),
  model: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});
