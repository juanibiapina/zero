import { createAgentClient } from "./agent-client";
import { log, logError } from "./log";
import { getUserDO } from "./UserDO/stub";
import type { Env } from "./types";

export const runTask = async (
  env: Env,
  clerkUserId: string,
  prompt: string,
  name?: string,
): Promise<void> => {
  const agent = createAgentClient(env, clerkUserId);
  const userDO = getUserDO(env, clerkUserId);

  const result = await agent.createSession();
  if (result.kind === "error") {
    logError("task_create_session_failed", {
      clerk_user_id: clerkUserId,
      status: result.status,
    });
    throw new Error(`Failed to create task session: HTTP ${result.status}`);
  }

  const { sessionId } = result;
  await userDO.recordTaskSession(sessionId, name);
  log("task_created", { session_id: sessionId, clerk_user_id: clerkUserId });

  const sendResult = await agent.sendMessage(sessionId, prompt);
  if (sendResult.kind === "error") {
    logError("task_send_failed", {
      clerk_user_id: clerkUserId,
      session_id: sessionId,
      status: sendResult.status,
    });
    throw new Error(`Failed to send task prompt: HTTP ${sendResult.status}`);
  }

  log("task_prompted", { session_id: sessionId, clerk_user_id: clerkUserId });
};
