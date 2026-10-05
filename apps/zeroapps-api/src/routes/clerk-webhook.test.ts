import type { UserJSON, WebhookEvent } from "@clerk/backend";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as discord from "../discord";
import type { Env } from "../types";
import { formatSignupMessage, handleClerkEvent } from "./clerk-webhook";

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
  it("includes the dashboard label, full name, and email", () => {
    const message = formatSignupMessage(
      user({
        first_name: "Alice",
        last_name: "Smith",
        primary_email_address_id: "e1",
        email_addresses: [{ id: "e1", email_address: "alice@example.com" }] as UserJSON["email_addresses"],
      }),
    );

    expect(message).toBe(
      "🎉 New Zero dashboard signup: Alice Smith - alice@example.com (user_123)",
    );
  });

  it("falls back to the primary email when name details are absent", () => {
    const message = formatSignupMessage(
      user({
        email_addresses: [
          { id: "e1", email_address: "old@example.com" },
          { id: "e2", email_address: "primary@example.com" },
        ] as UserJSON["email_addresses"],
        primary_email_address_id: "e2",
      }),
    );

    expect(message).toBe(
      "🎉 New Zero dashboard signup: primary@example.com (user_123)",
    );
  });

  it("falls back to the Clerk ID when no user details are available", () => {
    expect(formatSignupMessage(user({}))).toBe(
      "🎉 New Zero dashboard signup: (user_123)",
    );
  });
});

describe("handleClerkEvent", () => {
  const env = {
    DISCORD_SIGNUP_WEBHOOK_URL: "https://discord.test/webhook",
  } as Env;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules a Discord notification for user.created", () => {
    const notify = vi.spyOn(discord, "notifyDiscord").mockResolvedValue(undefined);
    const scheduled: Promise<unknown>[] = [];

    handleClerkEvent(
      { type: "user.created", data: user({ username: "alice" }) } as WebhookEvent,
      env,
      (promise) => scheduled.push(promise),
    );

    expect(notify).toHaveBeenCalledWith(
      "https://discord.test/webhook",
      expect.stringContaining("alice"),
    );
    expect(scheduled).toHaveLength(1);
  });

  it("ignores Clerk event types other than user.created", () => {
    const notify = vi.spyOn(discord, "notifyDiscord").mockResolvedValue(undefined);
    const scheduled: Promise<unknown>[] = [];

    handleClerkEvent(
      { type: "user.updated", data: user({}) } as WebhookEvent,
      env,
      (promise) => scheduled.push(promise),
    );

    expect(notify).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });
});
