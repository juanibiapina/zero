// Fetch a fresh Google OAuth access token for a Clerk user via Clerk's
// Backend API. Returns null on no token / Clerk error and never throws,
// so a Clerk outage can't block container startup for users who haven't
// connected Google. Caller is expected to omit the env var entirely on
// null so the Google CLIs (gmcli/gccli/gdcli) exit with a clean auth
// error.

import { createClerkClient } from "@clerk/backend";
import { fmtErr, log } from "./log";
import type { Env } from "./types";

export const getGoogleAccessToken = async (
  env: Env,
  clerkUserId: string,
): Promise<string | null> => {
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
    const tokens = await clerk.users.getUserOauthAccessToken(
      clerkUserId,
      "google",
    );
    return tokens.data[0]?.token ?? null;
  } catch (err) {
    log("google_token_unavailable", {
      clerk_user_id: clerkUserId,
      error: fmtErr(err),
    });
    return null;
  }
};

// The user's Google address from their Clerk external account. The
// badlogic CLIs key their local credential store by account email and
// stamp it into the `From:` header of outgoing Gmail, so it must be the
// real address. Sourced from Clerk rather than a container call; never
// throws, mirroring getGoogleAccessToken.
export const getGoogleAccountEmail = async (
  env: Env,
  clerkUserId: string,
): Promise<string | null> => {
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
    const user = await clerk.users.getUser(clerkUserId);
    const account = user.externalAccounts.find((a) =>
      a.provider.includes("google"),
    );
    return account?.emailAddress ?? null;
  } catch (err) {
    log("google_email_unavailable", {
      clerk_user_id: clerkUserId,
      error: fmtErr(err),
    });
    return null;
  }
};
