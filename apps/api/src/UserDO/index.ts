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
// @ts-expect-error — Generated JS file without type declarations
import migrations from "./db/drizzle/migrations";
import type { MigrationConfig } from "@zero/drizzle-migrator";
import {
  providerCredentialsTable,
  githubInstallationsTable,
  projectsTable,
  pkceVerifiersTable,
  userSecretsTable,
  sessionsTable,
} from "./db/schema";
import type { Env } from "../types";
import type { UserDOReferences, SessionStatus, UserServerMessage } from "@zero/core";
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
  // DO References
  // ============================================================================

  async getDOReferences(): Promise<UserDOReferences> {
    const projects = this.db.select({
      owner: projectsTable.owner,
      repo: projectsTable.repo,
      projectDOId: projectsTable.projectDOId,
    }).from(projectsTable).all();

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
    projectDOId: string;
    defaultProvider?: string;
    defaultModel?: string;
  }) {
    const now = new Date().toISOString();
    const existing = await this.getProject(data.owner, data.repo);

    if (existing) {
      this.db
        .update(projectsTable)
        .set({
          projectDOId: data.projectDOId,
          defaultProvider: data.defaultProvider ?? existing.defaultProvider,
          defaultModel: data.defaultModel ?? existing.defaultModel,
        })
        .where(
          and(eq(projectsTable.owner, data.owner), eq(projectsTable.repo, data.repo))
        )
        .run();
    } else {
      this.db.insert(projectsTable).values({
        owner: data.owner,
        repo: data.repo,
        projectDOId: data.projectDOId,
        defaultProvider: data.defaultProvider ?? null,
        defaultModel: data.defaultModel ?? null,
        createdAt: now,
      }).run();
    }
  }

  async updateProjectModel(owner: string, repo: string, provider: string, model: string) {
    this.db
      .update(projectsTable)
      .set({ defaultProvider: provider, defaultModel: model })
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
  }
}
