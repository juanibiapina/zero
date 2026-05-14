/**
 * ============================================================================
 * AgentContainer
 * ============================================================================
 *
 * Cloudflare Container hosting `@zero/agent-server`. One container per Clerk
 * user (selected with `getByName(clerkUserId)`), which idles after 5 minutes
 * of inactivity and frees its slot for other users.
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

export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
  envVars = {
    REPLY_URL: "http://zero.worker/reply",
  };
}

AgentContainer.outboundByHost = {
  "zero.worker": (req, env) => handleContainerReply(req, env),
};
