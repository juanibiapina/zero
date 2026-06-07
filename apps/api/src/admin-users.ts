// Clerk-backed user roster for the admin views.
//
// Clerk is the source of truth for "who are my users" — the per-user
// UserDO can't be enumerated and the D1 sessions table only knows users
// who completed a turn. These helpers list and fetch users from Clerk so
// the admin can see every signed-up account, including zero-session ones.
//
// Kept in its own module (like google-token.ts / github-token.ts) so the
// admin route can be tested without standing up the Clerk SDK.

import { createClerkClient } from "@clerk/backend";
import type { User } from "@clerk/backend";
import type { Env } from "./types";

export interface AdminUserIdentity {
  clerkUserId: string;
  email: string | null;
  username: string | null;
  createdAt: string;
}

// Clerk caps getUserList at 500 per page.
const CLERK_PAGE_SIZE = 500;

const toIdentity = (u: User): AdminUserIdentity => {
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId);
  const email = primary?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? null;
  return {
    clerkUserId: u.id,
    email,
    username: u.username ?? null,
    createdAt: new Date(u.createdAt).toISOString(),
  };
};

const clerkClient = (env: Env) =>
  createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });

// Every signed-up Clerk user. Pages past the 500 cap so the list is never
// silently truncated, but does no per-user enrichment (no UserDO reads).
export const listClerkUsers = async (env: Env): Promise<AdminUserIdentity[]> => {
  const clerk = clerkClient(env);
  const all: AdminUserIdentity[] = [];
  let offset = 0;
  for (;;) {
    const page = await clerk.users.getUserList({ limit: CLERK_PAGE_SIZE, offset });
    all.push(...page.data.map(toIdentity));
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) break;
  }
  return all;
};

// A single user's identity, or null if Clerk doesn't know the id.
export const getClerkUser = async (
  env: Env,
  userId: string,
): Promise<AdminUserIdentity | null> => {
  try {
    const user = await clerkClient(env).users.getUser(userId);
    return toIdentity(user);
  } catch {
    return null;
  }
};
