/**
 * ============================================================================
 * UserDO — User Registry & Credential Store
 * ============================================================================
 *
 * One per user (located via KV bootstrap: user:{clerkUserId} → UserDO ID).
 * Stores:
 * - Provider credentials (OAuth tokens, API keys)
 * - GitHub App installations
 * - Project references (owner/repo → ProjectDO ID)
 * - PKCE verifiers for in-progress OAuth flows
 *
 * Created with newUniqueId() for low-latency placement near the user.
 */

import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { eq, and } from "drizzle-orm";
// @ts-expect-error — Generated migrations file
import migrations from "./db/drizzle/migrations";
import {
  providerCredentialsTable,
  githubInstallationsTable,
  projectsTable,
  pkceVerifiersTable,
  userSecretsTable,
  sessionsTable,
} from "./db/schema";
import type { Env } from "../types";
import type { UserDOReferences, SessionStatus } from "@zero/core";
import { migrate } from "@zero/drizzle-migrator";

export class UserDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  // ============================================================================
  // DO References
  // ============================================================================

  async getDOReferences(): Promise<UserDOReferences> {
    const projects = await this.db.select({
      owner: projectsTable.owner,
      repo: projectsTable.repo,
      projectDOId: projectsTable.projectDOId,
    }).from(projectsTable);

    return {
      inboxDOId: null,
      realtimeDOId: null,
      projects,
    };
  }

  // ============================================================================
  // Provider Credentials
  // ============================================================================

  async listProviderCredentials() {
    return this.db.select().from(providerCredentialsTable);
  }

  async getProviderCredential(provider: string) {
    return this.db
      .select()
      .from(providerCredentialsTable)
      .where(eq(providerCredentialsTable.provider, provider))
      .get();
  }

  async upsertProviderCredential(data: {
    provider: string;
    credentialType: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    apiKey?: string;
  }) {
    const now = new Date().toISOString();
    const existing = await this.getProviderCredential(data.provider);

    if (existing) {
      await this.db
        .update(providerCredentialsTable)
        .set({
          credentialType: data.credentialType,
          accessToken: data.accessToken ?? null,
          refreshToken: data.refreshToken ?? null,
          expiresAt: data.expiresAt ?? null,
          apiKey: data.apiKey ?? null,
          updatedAt: now,
        })
        .where(eq(providerCredentialsTable.provider, data.provider));
    } else {
      await this.db.insert(providerCredentialsTable).values({
        provider: data.provider,
        credentialType: data.credentialType,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        apiKey: data.apiKey ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async deleteProviderCredential(provider: string) {
    await this.db
      .delete(providerCredentialsTable)
      .where(eq(providerCredentialsTable.provider, provider));
  }

  // ============================================================================
  // PKCE Verifiers (for OAuth flows)
  // ============================================================================

  async storePKCEVerifier(state: string, verifier: string, provider: string) {
    const now = new Date().toISOString();
    await this.db.insert(pkceVerifiersTable).values({
      state,
      verifier,
      provider,
      createdAt: now,
    });
  }

  async consumePKCEVerifier(state: string) {
    const row = await this.db
      .select()
      .from(pkceVerifiersTable)
      .where(eq(pkceVerifiersTable.state, state))
      .get();

    if (row) {
      await this.db
        .delete(pkceVerifiersTable)
        .where(eq(pkceVerifiersTable.state, state));
    }

    return row ?? null;
  }

  // ============================================================================
  // GitHub Installations
  // ============================================================================

  async listGitHubInstallations() {
    return this.db.select().from(githubInstallationsTable);
  }

  async getGitHubInstallation() {
    return this.db.select().from(githubInstallationsTable).get() ?? null;
  }

  async addGitHubInstallation(installationId: number, accountLogin: string, accountType: string) {
    const now = new Date().toISOString();
    // Enforce single installation: clear all existing, then insert
    await this.db.delete(githubInstallationsTable);
    await this.db.insert(githubInstallationsTable).values({
      installationId,
      accountLogin,
      accountType,
      createdAt: now,
    });
  }

  async removeGitHubInstallation(installationId: number) {
    await this.db
      .delete(githubInstallationsTable)
      .where(eq(githubInstallationsTable.installationId, installationId));
  }

  // ============================================================================
  // Projects
  // ============================================================================

  async listProjects() {
    return this.db.select().from(projectsTable);
  }

  async getProject(owner: string, repo: string) {
    return this.db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.owner, owner), eq(projectsTable.repo, repo)))
      .get();
  }

  async upsertProject(data: {
    owner: string;
    repo: string;
    projectDOId: string;
    defaultProvider?: string;
    defaultModel?: string;
  }) {
    const now = new Date().toISOString();
    const existing = await this.getProject(data.owner, data.repo);

    if (existing) {
      await this.db
        .update(projectsTable)
        .set({
          projectDOId: data.projectDOId,
          defaultProvider: data.defaultProvider ?? existing.defaultProvider,
          defaultModel: data.defaultModel ?? existing.defaultModel,
        })
        .where(
          and(eq(projectsTable.owner, data.owner), eq(projectsTable.repo, data.repo))
        );
    } else {
      await this.db.insert(projectsTable).values({
        owner: data.owner,
        repo: data.repo,
        projectDOId: data.projectDOId,
        defaultProvider: data.defaultProvider ?? null,
        defaultModel: data.defaultModel ?? null,
        createdAt: now,
      });
    }
  }

  async updateProjectModel(owner: string, repo: string, provider: string, model: string) {
    await this.db
      .update(projectsTable)
      .set({ defaultProvider: provider, defaultModel: model })
      .where(and(eq(projectsTable.owner, owner), eq(projectsTable.repo, repo)));
  }

  // ============================================================================
  // User Secrets
  // ============================================================================

  /** List all secret names + metadata. Values are intentionally excluded. */
  async listUserSecrets() {
    return this.db
      .select({
        name: userSecretsTable.name,
        createdAt: userSecretsTable.createdAt,
      })
      .from(userSecretsTable)
      .orderBy(userSecretsTable.name);
  }

  /** List all secrets with values — only called internally for session injection. */
  async listUserSecretsWithValues() {
    return this.db
      .select({
        name: userSecretsTable.name,
        value: userSecretsTable.value,
      })
      .from(userSecretsTable);
  }

  async upsertUserSecret(name: string, value: string) {
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(userSecretsTable)
      .where(eq(userSecretsTable.name, name))
      .get();

    if (existing) {
      await this.db
        .update(userSecretsTable)
        .set({ value, updatedAt: now })
        .where(eq(userSecretsTable.name, name));
    } else {
      await this.db.insert(userSecretsTable).values({
        name,
        value,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async deleteUserSecret(name: string) {
    await this.db
      .delete(userSecretsTable)
      .where(eq(userSecretsTable.name, name));
  }

  // ============================================================================
  // Sessions
  // ============================================================================

  async addSession(data: {
    sessionDOId: string;
    owner: string;
    repo: string;
    title: string;
    status: SessionStatus;
    provider: string;
    model: string;
  }) {
    const now = new Date().toISOString();
    await this.db.insert(sessionsTable).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateSessionStatus(sessionDOId: string, status: SessionStatus) {
    const now = new Date().toISOString();
    await this.db
      .update(sessionsTable)
      .set({ status, updatedAt: now })
      .where(eq(sessionsTable.sessionDOId, sessionDOId));
  }

  async listSessions(filter?: { owner: string; repo: string }) {
    if (filter) {
      return this.db
        .select()
        .from(sessionsTable)
        .where(
          and(
            eq(sessionsTable.owner, filter.owner),
            eq(sessionsTable.repo, filter.repo)
          )
        )
        .orderBy(sessionsTable.createdAt);
    }
    return this.db
      .select()
      .from(sessionsTable)
      .orderBy(sessionsTable.createdAt);
  }

  async getSessionById(sessionDOId: string) {
    return this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionDOId, sessionDOId))
      .get();
  }

  async removeSession(sessionDOId: string) {
    await this.db
      .delete(sessionsTable)
      .where(eq(sessionsTable.sessionDOId, sessionDOId));
  }
}
