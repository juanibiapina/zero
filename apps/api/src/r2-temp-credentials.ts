/**
 * ============================================================================
 * R2 Temporary Credentials
 * ============================================================================
 *
 * Mint short-lived, prefix-scoped R2 credentials by signing a JWT locally
 * with the parent R2 token's secret access key. No round trip to the
 * Cloudflare API is needed; the JWT *is* the session token (after a small
 * encoding step) and R2 verifies the signature on each request.
 *
 * The minted credential carries:
 *   - the parent token's access key id (reused as-is)
 *   - a derived secret access key (SHA-256 hex digest of the signed JWT)
 *   - a session token (`base64("jwt/" + signed JWT)`)
 *
 * Reference:
 *   https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
 *   https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/
 *
 * The container's tigrisfs adapter picks up these credentials from
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN. Standard
 * AWS SDK Go (which tigrisfs uses) honours session tokens transparently.
 */

import { SignJWT } from "jose";

export type R2Scope =
  | "object-read-only"
  | "object-read-write"
  | "admin-read-only"
  | "admin-read-write";

export interface MintR2TempCredsOptions {
  bucket: string;
  accountId: string;
  parentAccessKeyId: string;
  parentSecretAccessKey: string;
  scope: R2Scope;
  /** Time-to-live in seconds. Defaults to 1 hour. */
  ttlSeconds?: number;
  /** Restrict credential to keys starting with any listed prefix. */
  prefixes?: string[];
  /** Restrict credential to specific S3 actions (locks down listing). */
  actions?: string[];
}

export interface R2TempCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const mintR2TempCreds = async (
  opts: MintR2TempCredsOptions,
): Promise<R2TempCreds> => {
  const ttl = opts.ttlSeconds ?? 3600;
  const claims: Record<string, unknown> = {
    bucket: opts.bucket,
    scope: opts.scope,
  };
  if (opts.actions !== undefined && opts.actions.length > 0) {
    claims.actions = opts.actions;
  }
  if (opts.prefixes !== undefined && opts.prefixes.length > 0) {
    claims.paths = { prefixPaths: opts.prefixes, objectPaths: [] };
  }

  const audience = `${opts.accountId}.r2.cloudflarestorage.com`;
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(opts.accountId)
    .setIssuer(opts.parentAccessKeyId)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl.toString()}s`)
    .sign(new TextEncoder().encode(opts.parentSecretAccessKey));

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jwt),
  );

  return {
    accessKeyId: opts.parentAccessKeyId,
    secretAccessKey: toHex(digest),
    sessionToken: btoa(`jwt/${jwt}`),
  };
};
