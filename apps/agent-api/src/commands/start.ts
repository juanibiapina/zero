// Handles the /start bot command, which Telegram puts in front of every user
// who opens a t.me/<bot>?start=<payload> deep link — including users who have
// chatted before, since Telegram replaces the input bar with a Start button on
// those links. So both branches below are hot paths.
//
// A bot cannot initiate a conversation, so this is the earliest point at which
// Zero can speak. First contact runs a real turn (the introduction); every
// later /start gets a cheap canned ack instead of another model run.

import { log } from "../log";
import type { TopicContext } from "../telegram/context";
import { resolveClerkUserId } from "../telegram/identity";
import { getUserDO } from "../UserDO/stub";
import type { Env } from "../types";
import type { SendReplyFn } from "./new";

// The web app's origin. agent-api has no web-URL binding and adding one for a
// single string is not worth it; this matches wrangler.jsonc's route.
const WEB_APP_URL = "https://zero.juanibiapina.dev";

export const SIGN_IN_REPLY =
  `Hi — I'm Zero. Sign in at ${WEB_APP_URL} and link this Telegram account, then come back here.`;

export const ALREADY_STARTED_REPLY = "Still here. What's on your mind?";

export const processStartCommand = async (
  ctx: TopicContext,
  env: Env,
  deps: {
    sendReply: SendReplyFn;
    sendTyping: (chatId: number, topicId: number) => Promise<void>;
  },
  updateId: string,
  chatType: string,
): Promise<void> => {
  const clerkUserId = await resolveClerkUserId(env, ctx.telegramId);
  if (!clerkUserId) {
    log("start_command", { linked: false, chat_type: chatType });
    await deps.sendReply(ctx.chatId, ctx.topicId, SIGN_IN_REPLY);
    return;
  }

  const enqueued = await getUserDO(env, clerkUserId).startConversation(
    clerkUserId,
    ctx.chatId,
    ctx.topicId,
    // Synthetic id derived from the real update, so webhook retries still
    // dedupe through markProcessed.
    `start:${updateId}`,
  );
  log("start_command", {
    clerk_user_id: clerkUserId,
    linked: true,
    chat_type: chatType,
    enqueued,
  });

  if (enqueued) {
    // This path runs an LLM turn; without the typing indicator the user presses
    // Start and sits in silence for seconds.
    await deps.sendTyping(ctx.chatId, ctx.topicId).catch(() => {});
    return;
  }
  await deps.sendReply(ctx.chatId, ctx.topicId, ALREADY_STARTED_REPLY);
};
