/**
 * ============================================================================
 * UserDO — User Registry & Credential Store
 * ============================================================================
 *
 * One per user (located via KV bootstrap: user:{clerkUserId} → UserDO ID).
 * Stores:
 * - Provider credentials (OAuth tokens, API keys)
 * - GitHub App installations
 * - Project references (owner/repo → default provider/model)
 * - PKCE verifiers for in-progress OAuth flows
 *
 * Created with newUniqueId() for low-latency placement near the user.
 */

import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import { eq, and } from "drizzle-orm";
// @ts-expect-error — Generated JS file without type declarations
import migrations from "./db/drizzle/migrations";
import type { MigrationConfig } from "@zero/drizzle-migrator";
import {
  providerCredentialsTable,
  githubInstallationsTable,
  projectsTable,
  pkceVerifiersTable,
  userSecretsTable,
  userSettingsTable,
  promptTemplatesTable,
  sessionsTable,
} from "./db/schema";
import type { Env } from "../types";
import type { SessionStatus, UserServerMessage } from "@zero/core";
import { migrate } from "@zero/drizzle-migrator";

export class UserDO extends DurableObject<Env> {
  db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });

    // Auto-respond to ping/pong at the edge without waking the DO from hibernation.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );

    void ctx.blockConcurrencyWhile(async () => {
      migrate(this.db, migrations as MigrationConfig);
    });
  }

  // ============================================================================
  // Browser WebSocket (Hibernation API)
  // ============================================================================

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> { /* ping/pong handled by auto-response */ }
  async webSocketClose(): Promise<void> { /* Hibernation API manages cleanup */ }
  async webSocketError(): Promise<void> { /* Hibernation API manages cleanup */ }

  private broadcastToWebSockets(message: UserServerMessage): void {
    const json = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(json); }
      catch {
        try { ws.close(1011, "Send failed"); } catch { /* already closed */ }
      }
    }
  }

  // ============================================================================
  // Provider Credentials
  // ============================================================================

  async listProviderCredentials() {
    return this.db.select().from(providerCredentialsTable).all();
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
      this.db
        .update(providerCredentialsTable)
        .set({
          credentialType: data.credentialType,
          accessToken: data.accessToken ?? null,
          refreshToken: data.refreshToken ?? null,
          expiresAt: data.expiresAt ?? null,
          apiKey: data.apiKey ?? null,
          updatedAt: now,
        })
        .where(eq(providerCredentialsTable.provider, data.provider))
        .run();
    } else {
      this.db.insert(providerCredentialsTable).values({
        provider: data.provider,
        credentialType: data.credentialType,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        apiKey: data.apiKey ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  async deleteProviderCredential(provider: string) {
    this.db
      .delete(providerCredentialsTable)
      .where(eq(providerCredentialsTable.provider, provider))
      .run();
  }

  // ============================================================================
  // PKCE Verifiers (for OAuth flows)
  // ============================================================================

  async storePKCEVerifier(state: string, verifier: string, provider: string) {
    const now = new Date().toISOString();
    this.db.insert(pkceVerifiersTable).values({
      state,
      verifier,
      provider,
      createdAt: now,
    }).run();
  }

  async consumePKCEVerifier(state: string) {
    const row = this.db
      .select()
      .from(pkceVerifiersTable)
      .where(eq(pkceVerifiersTable.state, state))
      .get();

    if (row) {
      this.db
        .delete(pkceVerifiersTable)
        .where(eq(pkceVerifiersTable.state, state))
        .run();
    }

    return row ?? null;
  }

  // ============================================================================
  // GitHub Installations
  // ============================================================================

  async listGitHubInstallations() {
    return this.db.select().from(githubInstallationsTable).all();
  }

  async getGitHubInstallation() {
    return this.db.select().from(githubInstallationsTable).get() ?? null;
  }

  async addGitHubInstallation(installationId: number, accountLogin: string, accountType: string) {
    const now = new Date().toISOString();
    // Enforce single installation: clear all existing, then insert
    this.db.delete(githubInstallationsTable).run();
    this.db.insert(githubInstallationsTable).values({
      installationId,
      accountLogin,
      accountType,
      createdAt: now,
    }).run();
  }

  async removeGitHubInstallation(installationId: number) {
    this.db
      .delete(githubInstallationsTable)
      .where(eq(githubInstallationsTable.installationId, installationId))
      .run();
  }

  // ============================================================================
  // Projects
  // ============================================================================

  async listProjects() {
    return this.db.select().from(projectsTable).all();
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
    fullName?: string;
    description?: string | null;
    defaultBranch?: string;
    isPrivate?: boolean;
    archived?: boolean;
    defaultProvider?: string;
    defaultModel?: string;
  }) {
    const now = new Date().toISOString();
    const existing = await this.getProject(data.owner, data.repo);

    if (existing) {
      this.db
        .update(projectsTable)
        .set({
          fullName: data.fullName ?? existing.fullName,
          description: data.description !== undefined ? data.description : existing.description,
          defaultBranch: data.defaultBranch ?? existing.defaultBranch,
          isPrivate: data.isPrivate ?? existing.isPrivate,
          archived: data.archived ?? existing.archived,
          defaultProvider: data.defaultProvider ?? existing.defaultProvider,
          defaultModel: data.defaultModel ?? existing.defaultModel,
          updatedAt: now,
        })
        .where(
          and(eq(projectsTable.owner, data.owner), eq(projectsTable.repo, data.repo))
        )
        .run();
    } else {
      this.db.insert(projectsTable).values({
        owner: data.owner,
        repo: data.repo,
        fullName: data.fullName ?? null,
        description: data.description ?? null,
        defaultBranch: data.defaultBranch ?? null,
        isPrivate: data.isPrivate ?? null,
        archived: data.archived ?? null,
        defaultProvider: data.defaultProvider ?? null,
        defaultModel: data.defaultModel ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  /**
   * Sync projects from GitHub: upsert all repos, remove stale ones.
   * Preserves user settings (defaultProvider, defaultModel).
   */
  async syncProjects(repos: {
    owner: string;
    repo: string;
    fullName: string;
    description: string | null;
    defaultBranch: string;
    isPrivate: boolean;
    archived: boolean;
  }[]) {
    for (const r of repos) {
      await this.upsertProject({
        owner: r.owner,
        repo: r.repo,
        fullName: r.fullName,
        description: r.description,
        defaultBranch: r.defaultBranch,
        isPrivate: r.isPrivate,
        archived: r.archived,
      });
    }

    // Remove projects no longer in the installation
    const repoKeys = new Set(repos.map((r) => `${r.owner}/${r.repo}`));
    const existing = await this.listProjects();
    for (const row of existing) {
      if (!repoKeys.has(`${row.owner}/${row.repo}`)) {
        this.db
          .delete(projectsTable)
          .where(and(eq(projectsTable.owner, row.owner), eq(projectsTable.repo, row.repo)))
          .run();
      }
    }
  }

  async updateProjectModel(owner: string, repo: string, provider: string, model: string) {
    const now = new Date().toISOString();
    this.db
      .update(projectsTable)
      .set({ defaultProvider: provider, defaultModel: model, updatedAt: now })
      .where(and(eq(projectsTable.owner, owner), eq(projectsTable.repo, repo)))
      .run();
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
      .orderBy(userSecretsTable.name)
      .all();
  }

  /** List all secrets with values — only called internally for session injection. */
  async listUserSecretsWithValues() {
    return this.db
      .select({
        name: userSecretsTable.name,
        value: userSecretsTable.value,
      })
      .from(userSecretsTable)
      .all();
  }

  async upsertUserSecret(name: string, value: string) {
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(userSecretsTable)
      .where(eq(userSecretsTable.name, name))
      .get();

    if (existing) {
      this.db
        .update(userSecretsTable)
        .set({ value, updatedAt: now })
        .where(eq(userSecretsTable.name, name))
        .run();
    } else {
      this.db.insert(userSecretsTable).values({
        name,
        value,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  async deleteUserSecret(name: string) {
    this.db
      .delete(userSecretsTable)
      .where(eq(userSecretsTable.name, name))
      .run();
  }

  // ============================================================================
  // User Settings
  // ============================================================================

  async getUserSetting(key: string) {
    return this.db
      .select()
      .from(userSettingsTable)
      .where(eq(userSettingsTable.key, key))
      .get();
  }

  async setUserSetting(key: string, value: string) {
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(userSettingsTable)
      .where(eq(userSettingsTable.key, key))
      .get();

    if (existing) {
      this.db
        .update(userSettingsTable)
        .set({ value, updatedAt: now })
        .where(eq(userSettingsTable.key, key))
        .run();
    } else {
      this.db.insert(userSettingsTable).values({
        key,
        value,
        updatedAt: now,
      }).run();
    }
  }

  async getAllUserSettings(): Promise<Record<string, string>> {
    const rows = this.db.select().from(userSettingsTable).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ============================================================================
  // Prompt Templates
  // ============================================================================

  async listPromptTemplates() {
    return this.db
      .select()
      .from(promptTemplatesTable)
      .orderBy(promptTemplatesTable.name)
      .all();
  }

  async getPromptTemplate(id: number) {
    return this.db
      .select()
      .from(promptTemplatesTable)
      .where(eq(promptTemplatesTable.id, id))
      .get();
  }

  async createPromptTemplate(name: string, slug: string, content: string) {
    const now = new Date().toISOString();
    const result = this.db.insert(promptTemplatesTable).values({
      name,
      slug,
      content,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return result;
  }

  async updatePromptTemplate(id: number, fields: { name?: string; slug?: string; content?: string }) {
    const now = new Date().toISOString();
    this.db
      .update(promptTemplatesTable)
      .set({ ...fields, updatedAt: now })
      .where(eq(promptTemplatesTable.id, id))
      .run();
  }

  async deletePromptTemplate(id: number) {
    this.db
      .delete(promptTemplatesTable)
      .where(eq(promptTemplatesTable.id, id))
      .run();
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
    this.db.insert(sessionsTable).values({
      ...data,
      createdAt: now,
      updatedAt: now,
    }).run();

    this.broadcastToWebSockets({
      type: "session_created",
      session: {
        id: data.sessionDOId,
        owner: data.owner,
        repo: data.repo,
        title: data.title,
        status: data.status,
        provider: data.provider,
        model: data.model,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async updateSessionProviderModel(sessionDOId: string, provider: string, model: string) {
    const now = new Date().toISOString();
    this.db
      .update(sessionsTable)
      .set({ provider, model, updatedAt: now })
      .where(eq(sessionsTable.sessionDOId, sessionDOId))
      .run();
  }

  async updateSessionStatus(sessionDOId: string, status: SessionStatus) {
    const now = new Date().toISOString();
    this.db
      .update(sessionsTable)
      .set({ status, updatedAt: now })
      .where(eq(sessionsTable.sessionDOId, sessionDOId))
      .run();

    // Push status change to all connected browsers
    this.broadcastToWebSockets({
      type: "session_status",
      sessionId: sessionDOId,
      status,
    });
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
        .orderBy(sessionsTable.createdAt)
        .all();
    }
    return this.db
      .select()
      .from(sessionsTable)
      .orderBy(sessionsTable.createdAt)
      .all();
  }

  async getSessionById(sessionDOId: string) {
    return this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionDOId, sessionDOId))
      .get();
  }

  async removeSession(sessionDOId: string) {
    this.db
      .delete(sessionsTable)
      .where(eq(sessionsTable.sessionDOId, sessionDOId))
      .run();

    this.broadcastToWebSockets({
      type: "session_deleted",
      sessionId: sessionDOId,
    });
  }
}
