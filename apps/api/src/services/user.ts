/**
 * ============================================================================
 * UserService — User-scoped operations
 * ============================================================================
 *
 * Orchestrates project, provider, and GitHub installation operations via
 * UserDO. Routes instantiate this with the authenticated user's ID and
 * delegate all business logic.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import type { ProjectSummary, ProviderInfo } from "@zero/core";
import {
  getProviderRegistry,
  getProviderMeta,
  generatePKCE,
} from "@zero/providers";
import { getInstallationToken, listInstallationRepos, getInstallationDetails } from "./github";

// ── Anthropic OAuth constants ────────────────────────────────────────────
//
// These are private in pi-ai's anthropic.js module, so we maintain
// them here for the two-step connect/callback flow that Workers require.
// The values are stable (they're Anthropic's published OAuth app).

const ANTHROPIC_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
};

// ── Service ──────────────────────────────────────────────────────────────

export class UserService {
  constructor(
    private env: Env,
    private callerId: string,
  ) {}

  // ── Private helpers ──────────────────────────────────────────────────

  private async getUserDO(): Promise<DurableObjectStub<UserDO>> {
    const userDOIdStr = await this.env.KV.get(`user:${this.callerId}`);
    if (!userDOIdStr) {
      throw new Error("User not found in KV");
    }
    return this.env.USER_DO.get(
      this.env.USER_DO.idFromString(userDOIdStr),
    );
  }

  /**
   * Fetch repos from GitHub API and sync into UserDO.
   * Returns the fresh project list as ProjectSummary[].
   */
  private async syncFromGitHub(
    userDO: DurableObjectStub<UserDO>,
    installationId: number,
  ): Promise<{ projects: ProjectSummary[]; errors: string[] }> {
    const allRepos: ProjectSummary[] = [];

    try {
      const token = await getInstallationToken(this.env, installationId);
      const repos = await listInstallationRepos(token);
      for (const repo of repos) {
        allRepos.push({
          owner: repo.owner.login,
          repo: repo.name,
          fullName: repo.full_name,
          description: repo.description,
          defaultBranch: repo.default_branch,
          private: repo.private,
          archived: repo.archived,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to list repos for installation ${installationId}:`, err);
      return { projects: [], errors: [msg] };
    }

    await userDO.syncProjects(
      allRepos.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        fullName: r.fullName,
        description: r.description,
        defaultBranch: r.defaultBranch,
        isPrivate: r.private,
        archived: r.archived,
      })),
    );

    return { projects: allRepos, errors: [] };
  }

  /**
   * Convert DB rows to ProjectSummary[].
   */
  private rowsToSummaries(
    rows: {
      owner: string;
      repo: string;
      fullName: string | null;
      description: string | null;
      defaultBranch: string | null;
      isPrivate: boolean | null;
      archived: boolean | null;
    }[],
  ): ProjectSummary[] {
    return rows.map((r) => ({
      owner: r.owner,
      repo: r.repo,
      fullName: r.fullName ?? `${r.owner}/${r.repo}`,
      description: r.description,
      defaultBranch: r.defaultBranch ?? "main",
      private: r.isPrivate ?? false,
      archived: r.archived ?? false,
    }));
  }

  // ============================================================================
  // Projects
  // ============================================================================

  /**
   * List cached projects from DB. Auto-syncs from GitHub on first use
   * (empty cache or pre-migration rows without fullName).
   */
  async listProjects(): Promise<{
    projects: ProjectSummary[];
    installUrl: string;
    errors?: string[];
  }> {
    const userDO = await this.getUserDO();
    const installation = await userDO.getGitHubInstallation();
    const installUrl = this.getInstallUrl();

    if (!installation) {
      return { projects: [], installUrl };
    }

    const rows = await userDO.listProjects();

    // Auto-sync on first use (empty cache or pre-migration rows without fullName)
    if (rows.length === 0 || rows[0].fullName === null) {
      const result = await this.syncFromGitHub(userDO, installation.installationId);
      return {
        projects: result.projects,
        installUrl,
        errors: result.errors.length > 0 ? result.errors : undefined,
      };
    }

    return { projects: this.rowsToSummaries(rows), installUrl };
  }

  /**
   * Force-sync the project list from GitHub API and update the cache.
   */
  async refreshProjects(): Promise<{
    projects: ProjectSummary[];
    installUrl: string;
    errors?: string[];
  }> {
    const userDO = await this.getUserDO();
    const installation = await userDO.getGitHubInstallation();
    const installUrl = this.getInstallUrl();

    if (!installation) {
      return { projects: [], installUrl };
    }

    const result = await this.syncFromGitHub(userDO, installation.installationId);
    return {
      projects: result.projects,
      installUrl,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  }

  /**
   * Set the default provider and model for a project.
   */
  async setProjectModel(
    owner: string,
    repo: string,
    provider: string,
    model: string,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    if (!provider || !model) {
      return Result.fail({ message: "Missing provider or model", code: "INVALID" });
    }

    const userDO = await this.getUserDO();
    await userDO.updateProjectModel(owner, repo, provider, model);
    return Result.succeed({ success: true });
  }

  /**
   * GitHub App installation URL for the user to install the app on their account.
   */
  private getInstallUrl(): string {
    const base = "https://github.com/apps/zerocoding-app/installations/new";
    if (this.env.ENVIRONMENT === "development") {
      return `${base}?state=localhost:5176`;
    }
    return base;
  }

  // ============================================================================
  // Providers
  // ============================================================================

  /**
   * List all known providers with their connection status for the authenticated user.
   */
  async listProviders(): Promise<{ providers: ProviderInfo[] }> {
    const userDO = await this.getUserDO();
    const credentials = await userDO.listProviderCredentials();
    const connectedSet = new Set(credentials.map((cr) => cr.provider));

    const registry = getProviderRegistry();

    const providers: ProviderInfo[] = registry
      .filter((meta) => meta.supportsOAuth || meta.supportsApiKey)
      .map((meta) => ({
        id: meta.id,
        name: meta.name,
        connected: connectedSet.has(meta.id),
        credentialType: credentials.find((cr) => cr.provider === meta.id)?.credentialType as ProviderInfo["credentialType"] ?? null,
        supportsOAuth: meta.supportsOAuth,
        supportsApiKey: meta.supportsApiKey,
      }));

    return { providers };
  }

  /**
   * Initiate an OAuth PKCE flow for a provider. Returns the authorization URL.
   */
  async startOAuthFlow(
    providerId: string,
  ): Promise<Result.Result<{ authUrl: string; state: string }, ServiceError<"INVALID">>> {
    const meta = getProviderMeta(providerId);
    if (!meta?.supportsOAuth) {
      return Result.fail({ message: "OAuth not supported for this provider", code: "INVALID" });
    }

    // Currently only Anthropic OAuth is implemented as a two-step web flow.
    // Other OAuth providers (GitHub Copilot, OpenAI Codex, etc.) will be added later.
    if (providerId !== "anthropic") {
      return Result.fail({ message: "OAuth flow not yet implemented for this provider", code: "INVALID" });
    }

    const userDO = await this.getUserDO();

    // Generate PKCE challenge using pi-ai's Web Crypto implementation
    const { verifier, challenge } = await generatePKCE();

    // Random state token for CSRF protection
    const state = crypto.randomUUID();

    // Store verifier in UserDO
    await userDO.storePKCEVerifier(state, verifier, providerId);

    // Build authorization URL
    // Note: Anthropic's flow uses `code=true` and passes the verifier as `state`
    // (the verifier is needed both as state and for PKCE verification)
    const params = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_OAUTH.clientId,
      response_type: "code",
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
      scope: ANTHROPIC_OAUTH.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });

    const authUrl = `${ANTHROPIC_OAUTH.authorizeUrl}?${params.toString()}`;
    return Result.succeed({ authUrl, state });
  }

  /**
   * Complete an OAuth flow by exchanging the authorization code for tokens.
   */
  async completeOAuthFlow(
    providerId: string,
    code: string,
    stateParam?: string,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    const meta = getProviderMeta(providerId);
    if (!meta?.supportsOAuth) {
      return Result.fail({ message: "OAuth not supported for this provider", code: "INVALID" });
    }

    if (providerId !== "anthropic") {
      return Result.fail({ message: "OAuth flow not yet implemented for this provider", code: "INVALID" });
    }

    // Parse code#state format from Anthropic
    let actualCode = code;
    let state = stateParam;
    if (code.includes("#")) {
      const parts = code.split("#");
      actualCode = parts[0];
      state = state ?? parts[1];
    }

    if (!state) {
      return Result.fail({ message: "Missing state parameter", code: "INVALID" });
    }

    const userDO = await this.getUserDO();

    // Retrieve stored PKCE verifier
    const pkce = await userDO.consumePKCEVerifier(state);
    if (!pkce) {
      return Result.fail({ message: "Invalid or expired state", code: "INVALID" });
    }

    // Exchange code for tokens
    const tokenResp = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: ANTHROPIC_OAUTH.clientId,
        code: actualCode,
        state,
        redirect_uri: ANTHROPIC_OAUTH.redirectUri,
        code_verifier: pkce.verifier,
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      console.error("Token exchange failed:", err);
      return Result.fail({ message: "Token exchange failed", code: "INVALID" });
    }

    const tokens: { access_token: string; refresh_token?: string; expires_in?: number } = await tokenResp.json();

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    await userDO.upsertProviderCredential({
      provider: providerId,
      credentialType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    });

    return Result.succeed({ success: true });
  }

  /**
   * Set an API key credential for a provider.
   */
  async setApiKey(
    providerId: string,
    apiKey: string,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID">>> {
    const meta = getProviderMeta(providerId);
    if (!meta?.supportsApiKey) {
      return Result.fail({ message: "API key not supported for this provider", code: "INVALID" });
    }

    if (!apiKey) {
      return Result.fail({ message: "Missing apiKey", code: "INVALID" });
    }

    const userDO = await this.getUserDO();
    await userDO.upsertProviderCredential({
      provider: providerId,
      credentialType: "api_key",
      apiKey,
    });

    return Result.succeed({ success: true });
  }

  /**
   * Remove the stored credential for a provider.
   */
  async disconnectProvider(providerId: string): Promise<{ success: true }> {
    const userDO = await this.getUserDO();
    await userDO.deleteProviderCredential(providerId);
    return { success: true };
  }

  // ============================================================================
  // GitHub Installation
  // ============================================================================

  /**
   * Link a GitHub App installation to the user's account.
   */
  async linkGitHubInstallation(
    installationId: number,
  ): Promise<Result.Result<{ success: true }, ServiceError<"INVALID" | "NOT_FOUND">>> {
    if (!installationId || typeof installationId !== "number") {
      return Result.fail({ message: "Missing or invalid installationId", code: "INVALID" });
    }

    const userDO = await this.getUserDO();

    // Fetch installation details from GitHub API to get account info
    try {
      const details = await getInstallationDetails(this.env, installationId);
      await userDO.addGitHubInstallation(
        installationId,
        details.accountLogin,
        details.accountType,
      );
    } catch (err) {
      console.error("Failed to fetch installation details from GitHub:", err);

      // Fallback: check KV for webhook-stored data
      const kvData = await this.env.KV.get(`gh_installation:${installationId}`);
      if (kvData) {
        const parsed = JSON.parse(kvData) as { accountLogin: string; accountType: string };
        await userDO.addGitHubInstallation(
          installationId,
          parsed.accountLogin,
          parsed.accountType,
        );
      } else {
        return Result.fail({ message: "Installation not found", code: "NOT_FOUND" });
      }
    }

    return Result.succeed({ success: true });
  }
}
