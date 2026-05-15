/**
 * ============================================================================
 * AgentContainer
 * ============================================================================
 *
 * Cloudflare Container hosting `@zero/agent-server`. One container per Clerk
 * user (selected with `getByName(clerkUserId)`), which idles after 5 minutes
 * of inactivity and frees its slot for other users.
 *
 * Pi-ai inside the container talks to api.anthropic.com directly using
 * `ANTHROPIC_API_KEY`, which the worker injects into the container's env
 * (see `refreshEnvVars` below).
 *
 * Persistence: the container mounts an R2 prefix (`<clerkUserId>/`) at
 * `/mnt/agent-state` via tigrisfs and points pi at it. Credentials are
 * prefix-scoped temporary R2 credentials minted on every `fetch` call, so
 * the container can never see another user's data even at the S3 API
 * level. The temp-creds TTL is 1h, sleepAfter is 5m — plenty of headroom
 * across container sleep/wake cycles. We re-mint on every call instead of
 * on a timer because local JWT signing is essentially free (no API round
 * trip) and re-doing it ensures fresh creds on every container restart.
 *
 * Outbound contract:
 *
 *   The container POSTs replies to `http://zero.worker/reply`. That request
 *   never leaves the machine — `outboundByHost["zero.worker"]` (below)
 *   intercepts it and runs the handler inside the Workers runtime, where
 *   we have the KV binding and the Telegram bot token.
 *
 *   The Worker entrypoint must `export { ContainerProxy }` from
 *   `@cloudflare/containers` for this interception to work; see `index.ts`.
 */

import { Container } from "@cloudflare/containers";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { z } from "zod";
import { mintR2TempCreds } from "./r2-temp-credentials";
import type { Env } from "./types";

const ReplyBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
});

const SessionRecordSchema = z.object({
  clerkUserId: z.string(),
  chatId: z.number(),
  messageThreadId: z.number(),
});

/**
 * Handle a reply call from the container. Looks up the Telegram coordinates
 * for the session and sends the message back to the originating topic.
 */
const handleContainerReply = async (
  req: Request,
  env: Env,
): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const parsed = ReplyBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid body", { status: 400 });
  }
  const { sessionId, text } = parsed.data;

  const raw = await env.KV.get(`session:${sessionId}`);
  if (!raw) {
    console.log(`Container reply for unknown sessionId=${sessionId}`);
    return new Response("unknown session", { status: 404 });
  }

  let record: z.infer<typeof SessionRecordSchema>;
  try {
    record = SessionRecordSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error(
      `Corrupt session record for sessionId=${sessionId}:`,
      err,
    );
    return new Response("corrupt session", { status: 500 });
  }

  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
  await bot.api.sendMessage(record.chatId, text, {
    message_thread_id: record.messageThreadId,
  });

  return new Response(null, { status: 204 });
};

/** Hardcoded mount point inside the container. */
const AGENT_STATE_DIR = "/mnt/agent-state";

export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  override async fetch(request: Request): Promise<Response> {
    await this.refreshEnvVars();
    return super.fetch(request);
  }

  /**
   * Re-mint R2 temp creds and rebuild `this.envVars`. Called on every
   * incoming worker call. The Container base class only restarts the
   * underlying container process when it isn't already running, so a
   * live container keeps its existing env (and its existing tigrisfs
   * mount); the next cold start picks up the fresh values.
   */
  private async refreshEnvVars(): Promise<void> {
    const clerkUserId = this.ctx.id.name;
    if (!clerkUserId) {
      throw new Error(
        "AgentContainer must be addressed via env.AGENT_CONTAINER.getByName(clerkUserId)",
      );
    }

    const creds = await mintR2TempCreds({
      bucket: this.env.R2_BUCKET_NAME,
      accountId: this.env.R2_ACCOUNT_ID,
      parentAccessKeyId: this.env.R2_PARENT_ACCESS_KEY_ID,
      parentSecretAccessKey: this.env.R2_PARENT_SECRET_ACCESS_KEY,
      scope: "object-read-write",
      ttlSeconds: 3600,
      prefixes: [`${clerkUserId}/`],
    });

    this.envVars = {
      REPLY_URL: "http://zero.worker/reply",
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      CLERK_USER_ID: clerkUserId,
      R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
      R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
      R2_PREFIX: clerkUserId,
      R2_ENDPOINT: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      AGENT_STATE_DIR,
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_SESSION_TOKEN: creds.sessionToken,
    };
  }
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => handleContainerReply(req, env),
};
