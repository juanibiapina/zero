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
import { getInstallationToken } from "./github";
import { ContainerHandle } from "./container";

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
      ) as DurableObjectStub<UserDO>,
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
    repo: string,
    prompt?: string
  ): Promise<Result.Result<CreateSessionResult, ServiceError<"INVALID" | "NOT_FOUND">>> {
    if (!owner || !repo) {
      return Result.fail({
        message: "owner and repo are required",
        code: "INVALID",
      });
    }

    const { userDO, userDOId } = await this.getUserDO();

    // Verify user has access to this project
    const projects = (await userDO.getDOReferences()).projects;
    const projectRef = projects.find(
      (p) => p.owner === owner && p.repo === repo
    );
    if (!projectRef) {
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

    // 1. Get first connected credential (API key or OAuth)
    const credentials = await userDO.listProviderCredentials();
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

    const provider = cred.provider;
    const apiKey = (cred.apiKey ?? cred.accessToken)!;

    // Resolve model: use project default or a sensible default per provider
    const project = await userDO.getProject(owner, repo);
    let model: string;
    if (project?.defaultProvider === provider && project?.defaultModel) {
      model = project.defaultModel;
    } else {
      model = "claude-sonnet-4-20250514";
    }

    // 2. Get GitHub installation token
    const githubToken = await getInstallationToken(
      this.env,
      installation.installationId
    );

    // 3. Create SessionDO
    const sessionDOId = this.env.SESSION_DO.newUniqueId();
    const sessionDO = this.env.SESSION_DO.get(sessionDOId);

    const containerName = `session-${sessionDOId.toString()}`;
    const title = `Session ${sessionDOId.toString().slice(0, 8)}`;

    await sessionDO.initSession({
      status: "starting",
      containerName,
      projectOwner: owner,
      projectRepo: repo,
      provider,
      model,
      userDOId,
    });

    // 4. Add to UserDO session index
    await userDO.addSession({
      sessionDOId: sessionDOId.toString(),
      owner,
      repo,
      title,
      status: "starting",
      provider,
      model,
    });

    // 5. Fetch user secrets for injection into the container environment
    const userSecretsList = await userDO.listUserSecretsWithValues();
    const secrets = Object.fromEntries(
      userSecretsList.map((s) => [s.name, s.value])
    );

    // 6. Start container
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    try {
      const container = new ContainerHandle(this.env, containerName);

      // Tell the container which SessionDO to notify on stop
      await container.bindToSession(sessionDOId.toString());

      await container.start({
        repoUrl,
        token: githubToken,
        provider,
        model,
        apiKey,
        secrets,
        ...(prompt ? { prompt } : {}),
      });

      // Connect SessionDO's event stream so status events (e.g. "ready")
      // reach the browser. Without this, the lazy architecture deadlocks:
      // browser waits for "ready" before sending the prompt, but SessionDO
      // only opens the event WS on receiving a command.
      sessionDO.connectToContainer().catch((err) => {
        console.error("Failed to connect event stream after /start:", err);
      });
    } catch (err) {
      // Update session status on container start failure
      await sessionDO.updateStatus("failed");
      throw new Error(
        `Failed to start container: ${err instanceof Error ? err.message : String(err)}`
      );
    }

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

    const session = await sessionDO.getSession();
    if (!session) {
      // SessionDO already cleared — just clean up index
      await userDO.removeSession(id);
      return Result.succeed({ ok: true as const });
    }

    // Step 1: Best-effort stop container process
    try {
      const container = new ContainerHandle(this.env, session.containerName);
      await container.stop();
    } catch (err) {
      console.error("Delete: container stop failed (ok):", err);
    }

    // Step 2: Clear R2 workspace snapshot
    try {
      await this.env.SNAPSHOTS.delete(
        `workspace-snapshots/${id}/snapshot.tar.zst`
      );
    } catch (err) {
      console.error("Delete: R2 snapshot cleanup failed (ok):", err);
    }

    // Step 3: Clear SessionDO storage
    try {
      await sessionDO.deleteSession();
    } catch (err) {
      console.error("Delete: session DO cleanup failed (ok):", err);
    }

    // Step 4: Remove from UserDO index
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
