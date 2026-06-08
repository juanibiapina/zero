// Per-user Cloudflare Container hosting `@zero/agent-server`.
// Architecture, secret proxying, and the state-archive/Telegram outbound
// contract are documented in docs/design.md and docs/framework.md.

import { Container } from "@cloudflare/containers";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { z } from "zod";
import { getGoogleAccessToken } from "./google-token";
import { getGithubInstallationToken } from "./github-token";
import { fmtErr, log, logError } from "./log";
import { createSecretProxy } from "./secret-proxy";
import { withGatewayMetadata } from "./ai-gateway";
import { getUserDO } from "./UserDO/stub";
import type { Env } from "./types";
import { formatAndSend } from "./telegram/send";
import { handleAgentEnd } from "./handle-agent-end";

const secretProxy = createSecretProxy(
  ["CLOUDFLARE_API_KEY", "BRAVE_API_KEY"],
  ["GOOGLE_WORKSPACE_CLI_TOKEN", "GH_TOKEN"],
);

const MessageEndBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  clerkUserId: z.string().min(1),
});


const CloseSessionBodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  clerkUserId: z.string().min(1),
});

type SessionRecord = { type: string; chatId: number; topicId: number; name?: string };

type WithSessionOk<T> = { data: T & { sessionId: string; clerkUserId: string }; record: SessionRecord };


const withSession = async <T extends z.ZodType>(
  req: Request,
  env: Env,
  schema: T,
): Promise<WithSessionOk<z.infer<T>> | Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid body", { status: 400 });
  }
  const data = parsed.data as z.infer<T> & { sessionId: string; clerkUserId: string };

  const userDO = getUserDO(env, data.clerkUserId);
  const record = await userDO.lookupSessionById(data.sessionId);
  if (!record) {
    log("unknown_session", { session_id: data.sessionId });
    return new Response("unknown session", { status: 404 });
  }

  return { data, record };
};


const handleMessageEnd = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  const result = await withSession(req, env, MessageEndBodySchema);
  if (result instanceof Response) return result;
  const { data, record } = result;

  if (record.type === "task") {
    log("task_message_discarded", { session_id: data.sessionId });
    return new Response(null, { status: 204 });
  }

  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: { apiRoot: env.TELEGRAM_API_ROOT },
  });
  await formatAndSend(data.text, (text, parseMode) =>
    bot.api.sendMessage(record.chatId, text, {
      ...(record.topicId && { message_thread_id: record.topicId }),
      ...(parseMode && { parse_mode: parseMode }),
    }),
  );

  return new Response(null, { status: 204 });
};


const handleCloseSession = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  const result = await withSession(req, env, CloseSessionBodySchema);
  if (result instanceof Response) return result;
  const { data, record } = result;

  if (record.type === "task") {
    return Response.json({ message: "Task sessions cannot be closed." });
  }

  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: { apiRoot: env.TELEGRAM_API_ROOT },
  });

  await formatAndSend(data.message, (text, parseMode) =>
    bot.api.sendMessage(record.chatId, text, {
      ...(record.topicId && { message_thread_id: record.topicId }),
      ...(parseMode && { parse_mode: parseMode }),
    }),
  );

  if (record.topicId) {
    try {
      await bot.api.closeForumTopic(record.chatId, record.topicId);
    } catch (err) {
      logError("close_topic_failed", {
        session_id: data.sessionId,
        chat_id: record.chatId,
        thread_id: record.topicId,
        error: fmtErr(err),
      });
    }
    const userDO = getUserDO(env, data.clerkUserId);
    await userDO.forgetSession(data.sessionId);
    log("session_closed", { session_id: data.sessionId });
  }

  return Response.json({ message: "Session closed." });
};

const handleState = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  const clerkUserId = req.headers.get("X-Clerk-User-Id");
  if (!clerkUserId) return new Response("missing user id", { status: 400 });

  const key = `${clerkUserId}/state.tar.gz`;

  if (req.method === "GET") {
    const obj = await env.AGENT_STATE_BUCKET.get(key);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(obj.body, {
      headers: { "Content-Type": "application/gzip" },
    });
  }

  if (req.method === "PUT") {
    const body = await req.arrayBuffer();
    await env.AGENT_STATE_BUCKET.put(key, body);
    log("state_saved", { clerk_user_id: clerkUserId, size: body.byteLength });
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
};

export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  // Required so the catch-all `outbound` handler also intercepts HTTPS
  // (entrypoint installs Cloudflare's MITM CA into the trust store).
  override interceptHttps = true;

  override async fetch(request: Request): Promise<Response> {
    await this.refreshEnvVars();
    return super.fetch(request);
  }

  // Rebuild envVars on every call. A live container keeps its existing
  // env; the next cold start picks up the refreshed values.
  private async refreshEnvVars(): Promise<void> {
    const clerkUserId = this.ctx.id.name;
    if (!clerkUserId) {
      throw new Error(
        "AgentContainer must be addressed via env.AGENT_CONTAINER.getByName(clerkUserId)",
      );
    }

    const googleToken = await getGoogleAccessToken(this.env, clerkUserId);
    const githubToken = await getGithubInstallationToken(this.env, clerkUserId);

    // Push runtime-secret overrides to the substitute handler. Pushed on
    // every fetch; simpler than diffing.
    const overrides: Record<string, string> = {};
    if (googleToken !== null) {
      overrides.GOOGLE_WORKSPACE_CLI_TOKEN = googleToken;
    }
    if (githubToken !== null) {
      overrides.GH_TOKEN = githubToken;
    }
    await this.setOutboundHandler("substitute", { overrides, userId: clerkUserId });

    // Omit sentinels whose real value isn't available this call so the
    // consumer (e.g. gws, git/gh) exits with a clean auth error instead of
    // forwarding an unsubstituted sentinel upstream.
    const sentinels = { ...secretProxy.fakes };
    if (googleToken === null) delete sentinels.GOOGLE_WORKSPACE_CLI_TOKEN;
    if (githubToken === null) delete sentinels.GH_TOKEN;

    this.envVars = {
      CALLBACK_URL: "http://zero.worker",
      ...sentinels,
      CLERK_USER_ID: clerkUserId,
      CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_GATEWAY_ID: this.env.CLOUDFLARE_GATEWAY_ID,
      MODEL_ID: this.env.MODEL_ID,
      LLM_BASE_URL_OVERRIDE: this.env.LLM_BASE_URL_OVERRIDE,
    };
  }
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => {
    const path = new URL(req.url).pathname;
    if (path === "/message-end") return handleMessageEnd(req, env);
    if (path === "/agent-end") return handleAgentEnd(req, env);
    if (path === "/close-session") return handleCloseSession(req, env);
    if (path === "/state") return handleState(req, env);
    return new Response("not found", { status: 404 });
  },
};

// Named registration so `setOutboundHandler('substitute', { overrides, userId })`
// in `refreshEnvVars` can target it.
AgentContainer.outboundHandlers = {
  substitute: withGatewayMetadata(secretProxy.outbound),
};
