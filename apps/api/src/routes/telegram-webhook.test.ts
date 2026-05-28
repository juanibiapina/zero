import { describe, expect, it } from "vitest";
import { resolveContext } from "./telegram-webhook";

describe("resolveContext", () => {
  it("returns topicId from forum supergroup topic message", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
      is_topic_message: true,
      message_thread_id: 42,
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 42,
    });
  });

  it("returns topicId from DM with topics enabled", () => {
    const result = resolveContext(111, {
      chat: { type: "private", id: 100 },
      is_topic_message: true,
      message_thread_id: 7,
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 7,
    });
  });

  it("returns topicId=0 for plain DM without topics", () => {
    const result = resolveContext(111, {
      chat: { type: "private", id: 100 },
    });
    expect(result).toEqual({
      telegramId: "111",
      chatId: 100,
      topicId: 0,
    });
  });

  it("drops group chat message (not a topic)", () => {
    const result = resolveContext(111, {
      chat: { type: "group", id: 100 },
    });
    expect(result).toBeNull();
  });

  it("drops supergroup message without topic", () => {
    const result = resolveContext(111, {
      chat: { type: "supergroup", id: 100 },
    });
    expect(result).toBeNull();
  });

  it("drops channel message", () => {
    const result = resolveContext(111, {
      chat: { type: "channel", id: 100 },
    });
    expect(result).toBeNull();
  });
});
