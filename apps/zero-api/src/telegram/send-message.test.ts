import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessageSpy = vi.fn();

vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage: sendMessageSpy };
  },
}));

import { sendMessage } from "./send-message";
import type { Env } from "../types";

const env = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_BOT_INFO: JSON.stringify({
    id: 1,
    is_bot: true,
    first_name: "bot",
    username: "bot",
  }),
  TELEGRAM_API_ROOT: "https://api.telegram.org",
} as unknown as Env;

describe("sendMessage", () => {
  beforeEach(() => {
    sendMessageSpy.mockReset();
    vi.restoreAllMocks();
  });

  it("sends without logging on success", async () => {
    sendMessageSpy.mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendMessage(env, 100, 200, "hi");

    expect(sendMessageSpy).toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("logs telegram_send_failed and rethrows when the send fails", async () => {
    sendMessageSpy.mockRejectedValue(
      Object.assign(new Error("Server Error"), { error_code: 500 }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendMessage(env, 100, 200, "hi")).rejects.toThrow(
      "Server Error",
    );

    const events = errSpy.mock.calls.map(
      (c) => c[0] as { msg: string; chat_id: number; topic_id: number },
    );
    const failure = events.find((e) => e.msg === "telegram_send_failed");
    expect(failure).toBeDefined();
    expect(failure?.chat_id).toBe(100);
    expect(failure?.topic_id).toBe(200);
  });
});
