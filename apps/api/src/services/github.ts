/**
 * ============================================================================
 * GitHubService — GitHub App API interactions
 * ============================================================================
 *
 * Manages:
 * - Installation token generation via private key JWT
 * - Repo listing via GitHub API
 * - Webhook signature verification
 */

import type { Env } from "../types";

/**
 * Creates a JWT signed with the GitHub App's private key.
 * Used to authenticate as the GitHub App and request installation tokens.
 */
async function createAppJWT(appId: string, privateKeyPEM: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  // Import PEM private key
  const pemBody = privateKeyPEM
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const sigInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, sigInput);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/**
 * Get details about a specific installation of the GitHub App.
 */
export async function getInstallationDetails(
  env: Env,
  installationId: number
): Promise<{ accountLogin: string; accountType: string }> {
  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Zero-App",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to get installation details: ${resp.status} ${body}`);
  }

   
  const data: { account: { login: string; type: string } } = await resp.json();

  return {
    accountLogin: data.account.login,
    accountType: data.account.type,
  };
}

/**
 * Get an installation access token for a given installation ID.
 */
export async function getInstallationToken(
  env: Env,
  installationId: number
): Promise<string> {
  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Zero-App",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to get installation token: ${resp.status} ${body}`);
  }

   
  const data: { token: string } = await resp.json();
  return data.token;
}

/**
 * List repos accessible to a given installation.
 */
export async function listInstallationRepos(
  token: string
): Promise<
  {
    full_name: string;
    name: string;
    owner: { login: string };
    description: string | null;
    default_branch: string;
    private: boolean;
    archived: boolean;
  }[]
> {
  const repos: {
    full_name: string;
    name: string;
    owner: { login: string };
    description: string | null;
    default_branch: string;
    private: boolean;
    archived: boolean;
  }[] = [];

  let page = 1;
  while (true) {
    const resp = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Zero-App",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!resp.ok) break;

     
    const data: { repositories: typeof repos; total_count: number } = await resp.json();
    repos.push(...data.repositories);
    if (repos.length >= data.total_count) break;
    page++;
  }

  return repos;
}

/**
 * Verify a GitHub webhook signature (HMAC SHA-256).
 */
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signatureHeader: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return expected === signatureHeader;
}
