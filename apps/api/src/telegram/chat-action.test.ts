import { describe, it, expect, vi, beforeEach } from "vitest";

const sendChatActionSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("grammy", () => ({
  Bot: class {
    api = { sendChatAction: sendChatActionSpy };
  },
}));

import { sendChatAction } from "./chat-action";
import type { Env } from "../types";

const env = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_BOT_INFO: JSON.stringify({ id: 1, is_bot: true, first_name: "bot", username: "bot" }),
} as unknown as Env;

describe("sendChatAction", () => {
  beforeEach(() => {
    sendChatActionSpy.mockClear();
  });

  it("sends typing without thread id for a plain DM (topicId 0)", async () => {
    await sendChatAction(env, 100, 0);
    expect(sendChatActionSpy).toHaveBeenCalledWith(100, "typing", {});
  });

  it("includes message_thread_id when topicId is set", async () => {
    await sendChatAction(env, 100, 200);
    expect(sendChatActionSpy).toHaveBeenCalledWith(100, "typing", {
      message_thread_id: 200,
    });
  });
});
