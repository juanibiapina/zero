import { z } from "zod";
import { log, logError } from "./log";
import { getUserDO } from "./UserDO/stub";
import type { Env } from "./types";

const StatsSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});

const AgentEndBodySchema = z.object({
  sessionId: z.string().min(1),
  clerkUserId: z.string().min(1),
  willRetry: z.boolean(),
  stats: StatsSchema.optional(),
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
        const settings = await userDO.getSettings();
        env.ANALYTICS.writeDataPoint({
          blobs: ["google_onboarding_done"],
          doubles: [new Date(settings.createdAt ?? "").getTime()],
          indexes: [data.clerkUserId],
        });
      }
    }
    if (!data.willRetry && data.stats) {
      await upsertSessionCost(env, data.sessionId, data.clerkUserId, data.stats);
    }
    log("task_reply_discarded", { session_id: data.sessionId });
    return new Response(null, { status: 204 });
  }

  if (!data.willRetry) {
    if (record.type === "webui") {
      await userDO.markSessionIdleById(data.sessionId);
    } else {
      await userDO.markSessionIdle(record.chatId, record.topicId);
    }
    if (data.stats) {
      await upsertSessionCost(env, data.sessionId, data.clerkUserId, data.stats);
    }
  }

  return new Response(null, { status: 204 });
};

const upsertSessionCost = async (
  env: Env,
  sessionId: string,
  clerkUserId: string,
  stats: z.infer<typeof StatsSchema>,
): Promise<void> => {
  const now = new Date().toISOString();
  try {
    await env.SESSIONS_DB.prepare(`
      INSERT INTO sessions (session_id, clerk_user_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        cost_usd = excluded.cost_usd,
        updated_at = excluded.updated_at
    `)
      .bind(
        sessionId, clerkUserId, stats.model,
        stats.inputTokens, stats.outputTokens,
        stats.cacheReadTokens, stats.cacheWriteTokens,
        stats.costUsd, now, now,
      )
      .run();
  } catch (err) {
    logError("session_cost_upsert_failed", {
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
