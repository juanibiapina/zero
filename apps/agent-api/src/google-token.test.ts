import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Clerk so we control which Google identity a user has.
const getUserMock = vi.fn();
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser: getUserMock } }),
}));

import { getGoogleAccountEmail, memoizeTokenProvider } from "./google-token";
import type { Env } from "./types";

const env = (): Env =>
  ({
    CLERK_SECRET_KEY: "sk_test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
  }) as unknown as Env;

beforeEach(() => {
  getUserMock.mockReset();
});

describe("getGoogleAccountEmail", () => {
  it("returns the email for an oauth_google external account", async () => {
    getUserMock.mockResolvedValue({
      externalAccounts: [
        { provider: "oauth_github", username: "octocat" },
        { provider: "oauth_google", emailAddress: "alice@gmail.com" },
      ],
    });

    const email = await getGoogleAccountEmail(env(), "user_1");
    expect(email).toBe("alice@gmail.com");
  });

  it("returns null when the user has no Google external account", async () => {
    getUserMock.mockResolvedValue({
      externalAccounts: [{ provider: "oauth_github", username: "octocat" }],
    });

    const email = await getGoogleAccountEmail(env(), "user_1");
    expect(email).toBeNull();
  });

  it("never throws when Clerk fails", async () => {
    getUserMock.mockRejectedValue(new Error("clerk down"));

    await expect(getGoogleAccountEmail(env(), "user_1")).resolves.toBeNull();
  });
});

describe("memoizeTokenProvider", () => {
  it("mints once across multiple calls", async () => {
    const fetchToken = vi.fn(async () => "tok");
    const provider = memoizeTokenProvider(fetchToken);

    const [a, b, c] = await Promise.all([provider(), provider(), provider()]);
    expect([a, b, c]).toEqual(["tok", "tok", "tok"]);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("caches a null result (no retry after not-connected)", async () => {
    const fetchToken = vi.fn(async () => null);
    const provider = memoizeTokenProvider(fetchToken);

    expect(await provider()).toBeNull();
    expect(await provider()).toBeNull();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
