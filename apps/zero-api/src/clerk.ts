// The one place that constructs a Clerk backend client and reads a user's
// connected external account. Google-token, github-token, and admin-users all
// route through here so the env-var wiring and the external-account lookup
// shape live in a single module. Per-site error handling and logging stay at
// the call sites (this module never catches).

import { createClerkClient } from "@clerk/backend";
import type { Env } from "./types";

// The one place that knows which env vars build a Clerk backend client.
export const clerkClient = (env: Env) =>
  createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });

// Find a user's connected external account for a provider ("google", "github").
// Returns both normalized fields so each caller reads the one it needs, or null
// when the user has no matching account. Callers collapse the no-account and
// account-without-field cases to null via their own `?? null`. Does NOT catch:
// callers keep their own error/logging conventions (google logs + returns null;
// github lets its outer flow catch).
export const externalAccount = async (
  env: Env,
  clerkUserId: string,
  provider: string,
): Promise<{ username: string | null; email: string | null } | null> => {
  const user = await clerkClient(env).users.getUser(clerkUserId);
  const account = user.externalAccounts.find((a) =>
    a.provider.includes(provider),
  );
  if (!account) return null;
  return {
    username: account.username ?? null,
    email: account.emailAddress ?? null,
  };
};
