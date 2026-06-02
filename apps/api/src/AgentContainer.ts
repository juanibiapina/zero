// Per-user Cloudflare Container hosting `@zero/agent-server`.
// Architecture, secret proxying, and the R2/Telegram outbound contract are
// documented in docs/design.md and docs/framework.md.

import { Container } from "@cloudflare/containers";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { z } from "zod";
import { getGoogleAccessToken } from "./google-token";
import { fmtErr, log, logError } from "./log";
import { resolveMounts, type MountSpec } from "./mounts";
import { mintR2TempCreds } from "./r2-temp-credentials";
import { createSecretProxy } from "./secret-proxy";
import { getUserDO } from "./UserDO/stub";
import type { Env } from "./types";
import { formatAndSend } from "./telegram/send";

const secretProxy = createSecretProxy(
  ["ANTHROPIC_API_KEY", "BRAVE_API_KEY"],
  ["GOOGLE_WORKSPACE_CLI_TOKEN"],
);

const ReplyBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string(),
  clerkUserId: z.string().min(1),
});

const CloseSessionBodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  clerkUserId: z.string().min(1),
});

type SessionRecord = { type: string; chatId: number; topicId: number };

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

const handleContainerReply = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  const result = await withSession(req, env, ReplyBodySchema);
  if (result instanceof Response) return result;
  const { data, record } = result;

  if (record.type === "task") {
    log("task_reply_discarded", { session_id: data.sessionId });
    return new Response(null, { status: 204 });
  }

  await getUserDO(env, data.clerkUserId).markSessionIdle(record.chatId, record.topicId);

  // Empty reply: agent_end with no text. Nothing to send to Telegram.
  if (data.text.length === 0) {
    return new Response(null, { status: 204 });
  }

  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
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
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });

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

const handleNotes = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  const clerkUserId = req.headers.get("X-Clerk-User-Id");
  if (!clerkUserId) return new Response("missing user id", { status: 400 });

  const key = `${clerkUserId}/notes.tar.gz`;

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
    log("notes_saved", { clerk_user_id: clerkUserId, size: body.byteLength });
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
};

const AGENT_STATE_DIR = "/mnt/agent-state";

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

  // Re-mint R2 temp creds and rebuild envVars on every call. A live
  // container keeps its existing env; the next cold start picks up the
  // refreshed values.
  private async refreshEnvVars(): Promise<void> {
    const clerkUserId = this.ctx.id.name;
    if (!clerkUserId) {
      throw new Error(
        "AgentContainer must be addressed via env.AGENT_CONTAINER.getByName(clerkUserId)",
      );
    }

    const [creds, googleToken] = await Promise.all([
      mintR2TempCreds({
        bucket: this.env.R2_BUCKET_NAME,
        accountId: this.env.R2_ACCOUNT_ID,
        parentAccessKeyId: this.env.R2_PARENT_ACCESS_KEY_ID,
        parentSecretAccessKey: this.env.R2_PARENT_SECRET_ACCESS_KEY,
        scope: "object-read-write",
        ttlSeconds: 3600,
        prefixes: [`${clerkUserId}/`],
      }),
      getGoogleAccessToken(this.env, clerkUserId),
    ]);

    const mounts = await resolveMounts(this.env, clerkUserId, creds);

    // Push runtime-secret overrides to the substitute handler. Pushed on
    // every fetch; simpler than diffing.
    const overrides: Record<string, string> = {};
    if (googleToken !== null) {
      overrides.GOOGLE_WORKSPACE_CLI_TOKEN = googleToken;
    }
    await this.setOutboundHandler("substitute", { overrides });

    // Omit sentinels whose real value isn't available this call so the
    // consumer (e.g. gws) exits with a clean auth error instead of
    // forwarding an unsubstituted sentinel upstream.
    const sentinels = { ...secretProxy.fakes };
    if (googleToken === null) delete sentinels.GOOGLE_WORKSPACE_CLI_TOKEN;

    this.envVars = {
      CALLBACK_URL: "http://zero.worker",
      ...sentinels,
      CLERK_USER_ID: clerkUserId,
      AGENT_STATE_DIR,
      ...flattenMounts(mounts),
    };
  }
}

// Flatten the ordered MountSpec list into MOUNT_<n>_* env groups for
// `entrypoint.sh` to iterate. The shape stays scope-agnostic so adding
// a third mount needs no entrypoint change.
const flattenMounts = (mounts: MountSpec[]): Record<string, string> => {
  const out: Record<string, string> = { MOUNT_COUNT: String(mounts.length) };
  mounts.forEach((m, idx) => {
    const i = (idx + 1).toString();
    out[`MOUNT_${i}_NAME`] = m.name;
    out[`MOUNT_${i}_POINT`] = m.mountPoint;
    out[`MOUNT_${i}_ENDPOINT`] = m.endpoint;
    out[`MOUNT_${i}_BUCKET`] = m.bucket;
    out[`MOUNT_${i}_PREFIX`] = m.prefix;
    out[`MOUNT_${i}_ACCESS_KEY_ID`] = m.accessKeyId;
    out[`MOUNT_${i}_SECRET_ACCESS_KEY`] = m.secretAccessKey;
    out[`MOUNT_${i}_SESSION_TOKEN`] = m.sessionToken;
  });
  return out;
};

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => {
    const path = new URL(req.url).pathname;
    if (path === "/reply") return handleContainerReply(req, env);
    if (path === "/close-session") return handleCloseSession(req, env);
    if (path === "/notes") return handleNotes(req, env);
    return new Response("not found", { status: 404 });
  },
  // R2 traffic carries no registered secrets, but still runs through the
  // worker because interceptHttps='*' when the catch-all is active. Must
  // buffer the body and rebuild the Request: streamed bodies lose their
  // Content-Length (→ R2 411) and can be re-framed in a way that breaks
  // the SigV4 hash (→ R2 403). log() is kept so a regression is visible
  // in `wrangler tail`.
  "*.r2.cloudflarestorage.com": async (req) => {
    const url = req.url;
    const method = req.method;
    let body: BodyInit | null = null;
    if (method !== "GET" && method !== "HEAD") {
      body = new Uint8Array(await req.arrayBuffer());
    }
    const res = await fetch(url, {
      method,
      headers: req.headers,
      body,
      redirect: "manual",
    });
    log("r2_request", {
      url,
      method,
      status: res.status,
      content_length: res.headers.get("content-length"),
    });
    return res;
  },
};

// Named registration so `setOutboundHandler('substitute', { overrides })`
// in `refreshEnvVars` can target it.
AgentContainer.outboundHandlers = { substitute: secretProxy.outbound };
