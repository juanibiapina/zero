import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Clerk so we control the external accounts a user has.
const getUserMock = vi.fn();
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser: getUserMock } }),
}));

import { externalAccount } from "./clerk";
import type { Env } from "./types";

const env = (): Env =>
  ({
    CLERK_SECRET_KEY: "sk_test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
  }) as unknown as Env;

beforeEach(() => {
  getUserMock.mockReset();
});

describe("externalAccount", () => {
  it("returns username and email for a matching provider", async () => {
    getUserMock.mockResolvedValue({
      externalAccounts: [
        { provider: "oauth_github", username: "octocat", emailAddress: null },
        {
          provider: "oauth_google",
          username: null,
          emailAddress: "a@b.com",
        },
      ],
    });

    const account = await externalAccount(env(), "user_1", "google");
    expect(account).toEqual({ username: null, email: "a@b.com" });
  });

  it("returns null when no account matches the provider", async () => {
    getUserMock.mockResolvedValue({
      externalAccounts: [
        { provider: "oauth_github", username: "octocat", emailAddress: null },
      ],
    });

    const account = await externalAccount(env(), "user_1", "google");
    expect(account).toBeNull();
  });
});
