/**
 * ============================================================================
 * SessionService — Agent Session Orchestration
 * ============================================================================
 *
 * Manages session lifecycle: list, create, delete, and WebSocket access
 * verification. Routes instantiate this with the authenticated user's ID
 * and delegate all business logic.
 */

import { Result } from "@praha/byethrow";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import type { ServiceError } from "../lib/result";
import { getDefaultModel, getModel } from "@zero/providers";
import { defaultThinkingLevel, type ThinkingLevel } from "@zero/core";
import { SettingsService } from "./settings";

// ── Types ────────────────────────────────────────────────────────────────

type SessionSummary = {
  id: string;
  owner: string;
  repo: string;
  title: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreateSessionResult = {
  sessionId: string;
  provider: string;
  model: string;
};

// ── Service ──────────────────────────────────────────────────────────────

export class SessionService {
  constructor(
    private env: Env,
    private callerId: string
  ) {}

  // ── Private helpers ──────────────────────────────────────────────────

  private async getUserDO(): Promise<{
    userDO: DurableObjectStub<UserDO>;
    userDOId: string;
  }> {
    const userDOIdStr = await this.env.KV.get(`user:${this.callerId}`);
    if (!userDOIdStr) {
      throw new Error("User not found in KV");
    }
    return {
      userDO: this.env.USER_DO.get(
        this.env.USER_DO.idFromString(userDOIdStr)
      ),
      userDOId: userDOIdStr,
    };
  }

  private async requireSessionAccess(
    sessionId: string
  ): Promise<
    Result.Result<
      { userDO: DurableObjectStub<UserDO>; userDOId: string },
      ServiceError<"NOT_FOUND">
    >
  > {
    const { userDO, userDOId } = await this.getUserDO();
    const sessionRow = await userDO.getSessionById(sessionId);
    if (!sessionRow) {
      return Result.fail({ message: "Session not found", code: "NOT_FOUND" });
    }
    return Result.succeed({ userDO, userDOId });
  }

  // ── Public API ───────────────────────────────────────────────────────

  async listSessions(
    filter?: { owner: string; repo: string }
  ): Promise<{ sessions: SessionSummary[] }> {
    const { userDO } = await this.getUserDO();
    const sessions = await userDO.listSessions(filter);

    return {
      sessions: sessions.map((s) => ({
        id: s.sessionDOId,
        owner: s.owner,
        repo: s.repo,
        title: s.title,
        status: s.status,
        provider: s.provider,
        model: s.model,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    };
  }

  async createSession(
    owner: string,
    repo: string
  ): Promise<Result.Result<CreateSessionResult, ServiceError<"INVALID" | "NOT_FOUND">>> {
    if (!owner || !repo) {
      return Result.fail({
        message: "owner and repo are required",
        code: "INVALID",
      });
    }

    const { userDO, userDOId } = await this.getUserDO();

    // Verify user has access to this project and resolve model defaults
    const project = await userDO.getProject(owner, repo);
    if (!project) {
      return Result.fail({ message: "Project not found", code: "NOT_FOUND" });
    }

    // Verify GitHub installation exists
    const installation = await userDO.getGitHubInstallation();
    if (!installation) {
      return Result.fail({
        message:
          "No GitHub installation linked. Install or link the GitHub App first.",
        code: "INVALID",
      });
    }

    // Load user settings for session defaults
    const settingsService = new SettingsService(this.env, this.callerId);
    const { settings } = await settingsService.getSettings();

    // Get connected credentials
    const credentials = await userDO.listProviderCredentials();

    // Resolve provider: prefer user default if connected, else first connected credential
    let provider: string;
    if (settings.defaultProvider) {
      const defaultCred = credentials.find(
        (c) => c.provider === settings.defaultProvider &&
          ((c.credentialType === "api_key" && c.apiKey) || (c.credentialType === "oauth" && c.accessToken)),
      );
      if (defaultCred) {
        provider = defaultCred.provider;
      } else {
        // Default provider not connected — fall back to first connected
        const cred =
          credentials.find((c) => c.credentialType === "api_key" && c.apiKey) ??
          credentials.find((c) => c.credentialType === "oauth" && c.accessToken);
        if (!cred) {
          return Result.fail({
            message:
              "No API key or OAuth connection configured. Add a provider in Settings → Providers.",
            code: "INVALID",
          });
        }
        provider = cred.provider;
      }
    } else {
      const cred =
        credentials.find((c) => c.credentialType === "api_key" && c.apiKey) ??
        credentials.find((c) => c.credentialType === "oauth" && c.accessToken);
      if (!cred) {
        return Result.fail({
          message:
            "No API key or OAuth connection configured. Add a provider in Settings → Providers.",
          code: "INVALID",
        });
      }
      provider = cred.provider;
    }

    // Resolve model: prefer user default (if valid for provider), else provider default
    let model: string;
    if (settings.defaultProvider === provider && settings.defaultModel) {
      model = settings.defaultModel;
    } else {
      model = getDefaultModel(provider) ?? "claude-sonnet-4-20250514";
    }

    // Create SessionDO
    const sessionDOId = this.env.SESSION_DO.newUniqueId();
    const sessionDO = this.env.SESSION_DO.get(sessionDOId);

    const title = `Session ${sessionDOId.toString().slice(0, 8)}`;

    // Resolve thinking level: prefer user default (if model supports it), else auto
    const modelInfo = getModel(provider as Parameters<typeof getModel>[0], model as never);
    const supportsReasoning = modelInfo?.reasoning ?? false;
    let thinkingLevel: ThinkingLevel;
    if (settings.defaultThinkingLevel && supportsReasoning) {
      thinkingLevel = settings.defaultThinkingLevel;
    } else {
      thinkingLevel = defaultThinkingLevel(supportsReasoning);
    }

    await sessionDO.initSession({
      status: "stopped",
      projectOwner: owner,
      projectRepo: repo,
      provider,
      model,
      thinkingLevel,
      userDOId,
    });

    // Add to UserDO session index
    await userDO.addSession({
      sessionDOId: sessionDOId.toString(),
      owner,
      repo,
      title,
      status: "stopped",
      provider,
      model,
    });

    return Result.succeed({
      sessionId: sessionDOId.toString(),
      provider,
      model,
    });
  }

  async deleteSession(
    id: string
  ): Promise<Result.Result<{ ok: true }, ServiceError<"NOT_FOUND">>> {
    const access = await this.requireSessionAccess(id);
    if (Result.isFailure(access)) return access;
    const { userDO } = access.value;

    // Get SessionDO for cleanup
    let sessionDO;
    try {
      const doId = this.env.SESSION_DO.idFromString(id);
      sessionDO = this.env.SESSION_DO.get(doId);
    } catch {
      // Invalid ID — just remove from index
      await userDO.removeSession(id);
      return Result.succeed({ ok: true as const });
    }

    // Full teardown: stop container, clean R2 snapshot, clear DO storage
    try {
      await sessionDO.destroySession();
    } catch (err) {
      console.error("Delete: session destroy failed (ok):", err);
    }

    // Remove from UserDO index
    await userDO.removeSession(id);

    return Result.succeed({ ok: true as const });
  }

  async getSessionForWebSocket(
    id: string
  ): Promise<Result.Result<{ sessionDOId: string }, ServiceError<"NOT_FOUND" | "INVALID">>> {
    const access = await this.requireSessionAccess(id);
    if (Result.isFailure(access)) return access;

    // Verify the session DO ID is valid
    try {
      this.env.SESSION_DO.idFromString(id);
    } catch {
      return Result.fail({
        message: "Invalid session ID",
        code: "INVALID",
      });
    }

    return Result.succeed({ sessionDOId: id });
  }
}
