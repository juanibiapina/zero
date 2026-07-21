/**
 * ============================================================================
 * Zero Auth — Shared API Key Authentication
 * ============================================================================
 *
 * The suite's shared front door. A `zv_` key created in ZeroVault authorizes
 * every product (ZeroVault, ZeroErrors, ...). Keys are opaque tokens
 * (zv_<random>) validated via a KV lookup keyed by SHA-256 of the token.
 *
 * Key lifecycle (create, revoke) lives entirely in ZeroVault; other products
 * only read. This package owns the read path: hashing and validation.
 */

/**
 * Versioned JSON value stored in KV for each API key.
 *
 * v2 keys are org-scoped: `orgId` routes the DOs, `userId` is the creator
 * (kept for attribution/logging). Legacy v1 keys ({ v: 1, userId }) are invalid
 * under the org model and rejected.
 */
export type ApiKeyKVValue = {
  v: 2;
  orgId: string;
  userId: string;
};

/**
 * Hashes an API key using SHA-256 for KV and DO storage.
 */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validates an API key and returns its org context, or null if invalid.
 * Rejects legacy v1 keys (returns null → 401).
 *
 * Takes the `APIKEYS` KVNamespace directly rather than a whole `Env`, so it
 * depends only on the binding it needs and is reusable across products.
 */
export async function validateApiKey(
  apikeys: KVNamespace,
  authHeader: string | undefined,
): Promise<{ orgId: string; userId: string } | null> {
  if (!authHeader) return null;

  const key = authHeader.replace("Bearer ", "");

  if (!key.startsWith("zv_")) return null;

  const keyHash = await hashApiKey(key);
  const raw = await apikeys.get(keyHash);

  if (!raw) return null;

  let data: { v?: number; orgId?: string; userId?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.v !== 2 || !data.orgId || !data.userId) return null;

  return { orgId: data.orgId, userId: data.userId };
}
