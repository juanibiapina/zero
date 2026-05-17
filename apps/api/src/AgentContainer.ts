// Per-user Cloudflare Container hosting `@zero/agent-server`.
// Architecture, secret proxying, and the R2/Telegram outbound contract are
// documented in docs/design.md and docs/framework.md.

import { Container } from "@cloudflare/containers";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { z } from "zod";
import { getGoogleAccessToken } from "./google-token";
import { fmtErr, log, logError } from "./log";
import { resolveNotesMount } from "./notes-mount";
import { mintR2TempCreds } from "./r2-temp-credentials";
import { createSecretProxy } from "./secret-proxy";
import { lookupSessionRecord } from "./sessions";
import type { Env } from "./types";

const secretProxy = createSecretProxy(
  ["ANTHROPIC_API_KEY"],
  ["GOOGLE_WORKSPACE_CLI_TOKEN"],
);

const ReplyBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
});

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

  let record;
  try {
    record = await lookupSessionRecord(env, sessionId);
  } catch (err) {
    logError("corrupt_session_record", {
      session_id: sessionId,
      error: fmtErr(err),
    });
    return new Response("corrupt session", { status: 500 });
  }
  if (!record) {
    log("reply_unknown_session", { session_id: sessionId });
    return new Response("unknown session", { status: 404 });
  }

  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo });
  await bot.api.sendMessage(record.chatId, text, {
    message_thread_id: record.messageThreadId,
  });

  return new Response(null, { status: 204 });
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

    const notesMount = await resolveNotesMount(this.env, clerkUserId, creds);

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
      REPLY_URL: "http://zero.worker/reply",
      ...sentinels,
      CLERK_USER_ID: clerkUserId,
      R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
      R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
      R2_PREFIX: `${clerkUserId}/sessions`,
      R2_ENDPOINT: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      AGENT_STATE_DIR,
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_SESSION_TOKEN: creds.sessionToken,
      MOUNT_NOTES_ENDPOINT: notesMount.endpoint,
      MOUNT_NOTES_BUCKET: notesMount.bucket,
      MOUNT_NOTES_PREFIX: notesMount.prefix,
      MOUNT_NOTES_ACCESS_KEY_ID: notesMount.accessKeyId,
      MOUNT_NOTES_SECRET_ACCESS_KEY: notesMount.secretAccessKey,
      MOUNT_NOTES_SESSION_TOKEN: notesMount.sessionToken,
    };
  }
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => handleContainerReply(req, env),
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
