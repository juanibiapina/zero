/**
 * ============================================================================
 * SessionService — Agent Session Orchestration
 * ============================================================================
 *
 * Creates sessions: resolves credentials, gets GitHub token, creates
 * SessionDO, starts container.
 */

import { getContainer } from "@cloudflare/containers";
import type { Env } from "../types";
import type { UserDO } from "../UserDO";
import { getInstallationToken } from "./github";

interface CreateSessionParams {
  env: Env;
  userDO: DurableObjectStub<UserDO>;
  userDOId: string;
  owner: string;
  repo: string;
  installationId: number;
  prompt?: string;
}

interface CreateSessionResult {
  sessionId: string;
  provider: string;
  model: string;
}

export async function createSession(
  params: CreateSessionParams
): Promise<CreateSessionResult> {
  const { env, userDO, userDOId, owner, repo, installationId, prompt } = params;

  // 1. Get first connected credential (API key or OAuth)
  const credentials = await userDO.listProviderCredentials();
  const cred =
    credentials.find((c) => c.credentialType === "api_key" && c.apiKey) ??
    credentials.find((c) => c.credentialType === "oauth" && c.accessToken);
  if (!cred) {
    throw new Error(
      "No API key or OAuth connection configured. Add a provider in Settings → Providers."
    );
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
  const githubToken = await getInstallationToken(env, installationId);

  // 3. Create SessionDO
  const sessionDOId = env.SESSION_DO.newUniqueId();
  const sessionDO = env.SESSION_DO.get(sessionDOId);

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
  const secrets = Object.fromEntries(userSecretsList.map((s) => [s.name, s.value]));

  // 6. Start container (fire-and-forget via fetch to /start)
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  try {
    const container = getContainer(env.AGENT_CONTAINER, containerName);

    // Tell the container which SessionDO to notify on stop (RPC call)
    await container.setSessionDOId(sessionDOId.toString());

    const startResp = await container.fetch("http://container/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl,
        token: githubToken,
        provider,
        model,
        apiKey,
        secrets,
        ...(prompt ? { prompt } : {}),
      }),
    });

    if (!startResp.ok) {
      const body = await startResp.text();
      throw new Error(`Container /start returned ${startResp.status}: ${body}`);
    }

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

  return {
    sessionId: sessionDOId.toString(),
    provider,
    model,
  };
}
