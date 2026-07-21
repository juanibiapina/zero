import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserJSON, WebhookEvent } from "@clerk/backend";
import type { Env } from "../types";
import { formatSignupMessage, handleClerkEvent } from "./clerk-webhook";
import * as discord from "../discord";

const user = (over: Partial<UserJSON>): UserJSON =>
  ({
    id: "user_123",
    first_name: null,
    last_name: null,
    username: null,
    primary_email_address_id: null,
    email_addresses: [],
    ...over,
  }) as UserJSON;

describe("formatSignupMessage", () => {
  it("includes full name and email", () => {
    const msg = formatSignupMessage(
      user({
        first_name: "Alice",
        last_name: "Smith",
        primary_email_address_id: "e1",
        email_addresses: [{ id: "e1", email_address: "alice@example.com" }] as UserJSON["email_addresses"],
      }),
    );
    expect(msg).toBe("🎉 New signup: Alice Smith — alice@example.com (user_123)");
  });

  it("falls back to username when no name", () => {
    const msg = formatSignupMessage(
      user({
        username: "alice",
        email_addresses: [{ id: "e1", email_address: "alice@example.com" }] as UserJSON["email_addresses"],
      }),
    );
    expect(msg).toBe("🎉 New signup: alice — alice@example.com (user_123)");
  });

  it("omits email when none present", () => {
    const msg = formatSignupMessage(user({ first_name: "Alice", last_name: "Smith" }));
    expect(msg).toBe("🎉 New signup: Alice Smith (user_123)");
  });

  it("omits name when none present", () => {
    const msg = formatSignupMessage(
      user({
        email_addresses: [{ id: "e1", email_address: "alice@example.com" }] as UserJSON["email_addresses"],
      }),
    );
    expect(msg).toBe("🎉 New signup: alice@example.com (user_123)");
  });

  it("falls back to id alone when neither name nor email", () => {
    const msg = formatSignupMessage(user({}));
    expect(msg).toBe("🎉 New signup: (user_123)");
  });

  it("prefers the primary email address", () => {
    const msg = formatSignupMessage(
      user({
        primary_email_address_id: "e2",
        email_addresses: [
          { id: "e1", email_address: "old@example.com" },
          { id: "e2", email_address: "primary@example.com" },
        ] as UserJSON["email_addresses"],
      }),
    );
    expect(msg).toContain("primary@example.com");
  });
});

describe("handleClerkEvent", () => {
  const env = { DISCORD_SIGNUP_WEBHOOK_URL: "https://discord.test/webhook" } as Env;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules a Discord notification on user.created", () => {
    const notify = vi.spyOn(discord, "notifyDiscord").mockResolvedValue(undefined);
    const scheduled: Promise<unknown>[] = [];

    handleClerkEvent(
      {
        type: "user.created",
        data: user({ username: "alice" }),
      } as WebhookEvent,
      env,
      (p) => scheduled.push(p),
    );

    expect(notify).toHaveBeenCalledWith(
      "https://discord.test/webhook",
      expect.stringContaining("alice"),
    );
    expect(scheduled).toHaveLength(1);
  });

  it("ignores other event types", () => {
    const notify = vi.spyOn(discord, "notifyDiscord").mockResolvedValue(undefined);
    const scheduled: Promise<unknown>[] = [];

    handleClerkEvent(
      { type: "user.updated", data: user({}) } as WebhookEvent,
      env,
      (p) => scheduled.push(p),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });
});
