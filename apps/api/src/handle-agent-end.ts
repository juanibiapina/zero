import { z } from "zod";
import { log } from "./log";
import { getUserDO } from "./UserDO/stub";
import type { Env } from "./types";

const AgentEndBodySchema = z.object({
  sessionId: z.string().min(1),
  clerkUserId: z.string().min(1),
  willRetry: z.boolean(),
});

export const handleAgentEnd = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const parsed = AgentEndBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid body", { status: 400 });
  }
  const data = parsed.data;

  const userDO = getUserDO(env, data.clerkUserId);
  const record = await userDO.lookupSessionById(data.sessionId);
  if (!record) {
    log("unknown_session", { session_id: data.sessionId });
    return new Response("unknown session", { status: 404 });
  }

  if (record.type === "task") {
    if (!data.willRetry && record.name) {
      if (record.name === "google-onboarding") {
        await userDO.setGoogleOnboardingStatus("done");
      }
    }
    log("task_reply_discarded", { session_id: data.sessionId });
    return new Response(null, { status: 204 });
  }

  if (!data.willRetry) {
    await userDO.markSessionIdle(record.chatId, record.topicId);
  }

  return new Response(null, { status: 204 });
};
