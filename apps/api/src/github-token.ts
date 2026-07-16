// Mint a short-lived GitHub App installation token for a Clerk user.
//
// The repo capability authenticates as the GitHub App `zerocoding-app`
// (not as the user): we sign an app JWT with the app's private key, look
// up the user's own installation via their connected GitHub identity, and
// exchange the JWT for an installation access token (~1h). The connect
// plumbing and status live here; there is no consumer of the token yet
// (the container that ran git/gh was removed with the container runtime).
//
// Every function returns null / a "not connected" status on failure and
// never throws, mirroring google-token.ts: a GitHub outage or an
// un-installed user must not block a turn.

import { createClerkClient } from "@clerk/backend";
import { importPKCS8, SignJWT } from "jose";
import { fmtErr, log } from "./log";
import type { Env } from "./types";

const GITHUB_API = "https://api.github.com";

const githubHeaders = (jwt: string): HeadersInit => ({
  Authorization: `Bearer ${jwt}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "zero-worker",
});

// Non-secret diagnostics for the admin GitHub-status view. Never carries
// the token itself — only a prefix and expiry for sanity checks.
export interface GithubInstallationStatus {
  githubConnected: boolean;
  githubUsername: string | null;
  installationId: number | null;
  tokenMinted: boolean;
  tokenPrefix: string | null;
  expiresAt: string | null;
}

const DISCONNECTED: GithubInstallationStatus = {
  githubConnected: false,
  githubUsername: null,
  installationId: null,
  tokenMinted: false,
  tokenPrefix: null,
  expiresAt: null,
};

// The user's GitHub login from their Clerk external account. This is how
// we find the right installation: each user installs the app on their own
// GitHub account, so there is no global "the one installation" shortcut.
const getGithubUsername = async (
  env: Env,
  clerkUserId: string,
): Promise<string | null> => {
  const clerk = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
  const user = await clerk.users.getUser(clerkUserId);
  const account = user.externalAccounts.find((a) =>
    a.provider.includes("github"),
  );
  return account?.username ?? null;
};

// Self-signed app JWT (RS256). Authenticates as the app before any
// installation-specific call. Expiry kept well under GitHub's 10-min cap.
const mintAppJwt = async (env: Env): Promise<string> => {
  const key = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
};

const getInstallationId = async (
  jwt: string,
  username: string,
): Promise<number | null> => {
  const res = await fetch(
    `${GITHUB_API}/users/${encodeURIComponent(username)}/installation`,
    { headers: githubHeaders(jwt) },
  );
  if (!res.ok) return null;
  const body = await res.json<{ id?: number }>();
  return body.id ?? null;
};

const mintInstallationToken = async (
  jwt: string,
  installationId: number,
): Promise<{ token: string; expiresAt: string } | null> => {
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: githubHeaders(jwt) },
  );
  if (!res.ok) return null;
  const body = await res.json<{ token?: string; expires_at?: string }>();
  if (!body.token) return null;
  return { token: body.token, expiresAt: body.expires_at ?? "" };
};

// Full diagnostic flow used by the admin status view. Mirrors the token
// flow step-for-step but surfaces where it stopped, without the secret.
export const getGithubInstallationStatus = async (
  env: Env,
  clerkUserId: string,
): Promise<GithubInstallationStatus> => {
  try {
    const username = await getGithubUsername(env, clerkUserId);
    if (!username) return DISCONNECTED;

    const jwt = await mintAppJwt(env);
    const installationId = await getInstallationId(jwt, username);
    if (installationId === null) {
      return { ...DISCONNECTED, githubConnected: true, githubUsername: username };
    }

    const minted = await mintInstallationToken(jwt, installationId);
    return {
      githubConnected: true,
      githubUsername: username,
      installationId,
      tokenMinted: minted !== null,
      tokenPrefix: minted ? minted.token.slice(0, 4) : null,
      expiresAt: minted ? minted.expiresAt : null,
    };
  } catch (err) {
    log("github_token_unavailable", {
      clerk_user_id: clerkUserId,
      error: fmtErr(err),
    });
    return DISCONNECTED;
  }
};

// Production path: the installation access token for a user, or null when
// they haven't connected/installed or GitHub is unreachable.
export const getGithubInstallationToken = async (
  env: Env,
  clerkUserId: string,
): Promise<string | null> => {
  try {
    const username = await getGithubUsername(env, clerkUserId);
    if (!username) return null;

    const jwt = await mintAppJwt(env);
    const installationId = await getInstallationId(jwt, username);
    if (installationId === null) return null;

    const minted = await mintInstallationToken(jwt, installationId);
    return minted?.token ?? null;
  } catch (err) {
    log("github_token_unavailable", {
      clerk_user_id: clerkUserId,
      error: fmtErr(err),
    });
    return null;
  }
};
