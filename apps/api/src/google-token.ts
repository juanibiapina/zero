/**
 * ============================================================================
 * Google OAuth Access Token Helper
 * ============================================================================
 *
 * Fetches a fresh Google OAuth access token for a Clerk user via Clerk's
 * Backend API (`users.getUserOauthAccessToken`). Clerk handles the
 * refresh-token dance — we never see the refresh token, just a
 * short-lived access token suitable for forwarding to the container as
 * `GOOGLE_WORKSPACE_CLI_TOKEN`.
 *
 * The Clerk client is constructed locally per call. Mirrors the
 * `mintR2TempCreds` style (free local operation, no shared singleton).
 *
 * Returns `null` when the user hasn't connected Google (Clerk returns
 * no tokens) or when the Clerk call throws (the throw is caught and
 * logged as `google_token_unavailable`). Never throws into the caller,
 * so a Clerk outage can't block container startup for users who don't
 * use Google at all. The caller then omits
 * `GOOGLE_WORKSPACE_CLI_TOKEN` from `envVars` entirely, and `gws`
 * inside the container exits with a clear "not authenticated" message.
 */

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
