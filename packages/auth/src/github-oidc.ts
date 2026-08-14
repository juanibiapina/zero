/**
 * ============================================================================
 * GitHub Actions OIDC — verifying a workflow's identity
 * ============================================================================
 *
 * A GitHub Actions job can ask GitHub for a short-lived OIDC token describing
 * itself. Verifying that token is how Zero lets a workflow read secrets with no
 * API key stored anywhere.
 *
 * Measured against the live provider (2026-08-14), because each fact changes the
 * design:
 *
 * - The token lives **5 minutes** (`exp - iat = 300`) and GitHub already
 *   backdates `nbf` by 5 minutes, so only `exp` needs a skew allowance.
 * - `sub` is **not** a stable identifier. Repositories created after 2026-07-15
 *   use `repo:OWNER@OWNER-ID/REPO@REPO-ID:…`, older ones keep the old shape
 *   until they opt in, and a rename moves them across. Every cloud provider's
 *   tutorial matches on `sub`; this one matches on `repository_id` and
 *   `repository_owner_id`, which are immutable.
 * - The audience is caller-chosen, so it proves nothing on its own — but
 *   requiring ours stops a token minted for AWS from being replayed here.
 * - A fork's `pull_request` run gets **no** token, while its
 *   `pull_request_target` run gets one carrying the **base** repository's ids
 *   and `ref: refs/heads/main`. See `trustAllows`: only the event check stops
 *   that, a ref constraint does not.
 */

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** GitHub already backdates `nbf`; this covers a slow runner's clock on `exp`. */
const CLOCK_SKEW_SECONDS = 60;

/** How long a fetched key set is reused. GitHub rotates rarely. */
const JWKS_CACHE_TTL_SECONDS = 3600;

const JWKS_CACHE_KEY = "jwks:github-actions";

/** The claims a trust decision is allowed to depend on. */
export interface GithubActionsClaims {
  repositoryId: string;
  repositoryOwnerId: string;
  repository: string;
  ref: string;
  eventName: string;
  environment?: string;
  /** For attribution in logs, never for authorization. */
  workflowRef?: string;
  runId?: string;
  actor?: string;
}

export interface VerifyDeps {
  audience: string;
  cache: KVNamespace;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Jwk = { kid?: string; kty: string; alg?: string; n: string; e: string };
type Jwks = { keys: Jwk[] };

/** base64url is base64 with two characters swapped and the padding dropped. */
function base64UrlToBytes(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function usableKey(key: Jwk | undefined): Jwk | null {
  // A key set entry without a modulus is not something to verify against.
  return key && key.kty === "RSA" && key.n && key.e ? key : null;
}

async function loadJwks(deps: VerifyDeps, kid: string): Promise<Jwk | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const cached = await deps.cache.get(JWKS_CACHE_KEY);
  if (cached) {
    const key = usableKey((JSON.parse(cached) as Jwks).keys.find((k) => k.kid === kid));
    // A cache without this kid is stale, not wrong: GitHub rotates keys, so
    // fall through and re-fetch rather than rejecting a valid token.
    if (key) return key;
  }

  let fresh: Jwks;
  try {
    const response = await fetchImpl(GITHUB_JWKS_URL);
    if (!response.ok) return null;
    fresh = (await response.json());
  } catch {
    return null;
  }

  await deps.cache.put(JWKS_CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: JWKS_CACHE_TTL_SECONDS,
  });

  return usableKey(fresh.keys.find((k) => k.kid === kid));
}

/**
 * Verifies a GitHub Actions OIDC token and returns the claims worth acting on,
 * or null if anything about it is wrong. Callers get no detail on purpose: this
 * runs on an unauthenticated endpoint, where a precise error is a probing oracle.
 */
export async function verifyGithubOidcToken(
  token: string,
  deps: VerifyDeps,
): Promise<GithubActionsClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]) as Record<string, unknown>;
    payload = decodeSegment(parts[1]) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Only RS256 is accepted. "none" and symmetric algorithms are the classic
  // JWT forgeries, and GitHub signs with RS256 only.
  if (header.alg !== "RS256") return null;
  const kid = readString(header, "kid");
  if (!kid) return null;

  if (payload.iss !== GITHUB_ISSUER) return null;
  if (payload.aud !== deps.audience) return null;

  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  if (exp + CLOCK_SKEW_SECONDS < now) return null;
  if (nbf - CLOCK_SKEW_SECONDS > now) return null;

  const repositoryId = readString(payload, "repository_id");
  const repositoryOwnerId = readString(payload, "repository_owner_id");
  if (!repositoryId || !repositoryOwnerId) return null;

  const jwk = await loadJwks(deps, kid);
  if (!jwk) return null;

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  return {
    repositoryId,
    repositoryOwnerId,
    repository: readString(payload, "repository") ?? "",
    ref: readString(payload, "ref") ?? "",
    eventName: readString(payload, "event_name") ?? "",
    environment: readString(payload, "environment"),
    workflowRef: readString(payload, "workflow_ref"),
    runId: readString(payload, "run_id"),
    actor: readString(payload, "actor"),
  };
}

/**
 * Events that hand a workflow the base repository's identity while running code
 * or inputs an outsider influenced. Each must be opted into per trust record.
 *
 * `pull_request_target` is the sharp one: measured, a fork's PR triggers it with
 * the base repo's ids and `ref: refs/heads/main`, so a ref constraint lets it
 * straight through.
 */
const EVENTS_REQUIRING_OPT_IN = ["pull_request", "pull_request_target", "workflow_run"];

export interface CiTrust {
  ownerId: string;
  repoId: string;
  ref: string | null;
  environment: string | null;
  allowedEvents: string[];
}

export type TrustDecision =
  | { ok: true }
  | { ok: false; reason: "repository" | "ref" | "environment" | "event" };

/**
 * Whether a trust record covers a verified token. Pure, so every rule is
 * testable without a token, a network, or a Durable Object.
 */
export function trustAllows(trust: CiTrust, claims: GithubActionsClaims): TrustDecision {
  if (trust.ownerId !== claims.repositoryOwnerId || trust.repoId !== claims.repositoryId) {
    return { ok: false, reason: "repository" };
  }

  if (
    EVENTS_REQUIRING_OPT_IN.includes(claims.eventName) &&
    !trust.allowedEvents.includes(claims.eventName)
  ) {
    return { ok: false, reason: "event" };
  }

  if (trust.ref && trust.ref !== claims.ref) return { ok: false, reason: "ref" };

  if (trust.environment && trust.environment !== claims.environment) {
    return { ok: false, reason: "environment" };
  }

  return { ok: true };
}
