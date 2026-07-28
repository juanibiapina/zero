/**
 * ============================================================================
 * Account API Client
 * ============================================================================
 *
 * Typed fetch client for the account-level (organization-scoped) endpoints.
 * All requests include the Clerk session JWT for authentication.
 *
 * The endpoints keep their `/api/vault/keys` paths: one key already authorizes
 * every product, and adding an `/api/keys` alias would widen the server
 * surface with nothing to show the user for it.
 *
 * `ApiKeyInfo` and `ApiKeyCreated` also stay in `@zero/vault-core` rather than
 * moving to `@zero/auth`, whose types reference Workers globals a browser app
 * has no business importing.
 */

import { fetchApi } from "@zero/ui";
import type { ApiKeyInfo, ApiKeyCreated } from "@zero/vault-core";

export async function createApiKey(
  getToken: () => Promise<string | null>,
  label?: string,
): Promise<ApiKeyCreated> {
  return fetchApi<ApiKeyCreated>("/api/vault/keys", getToken, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export async function listApiKeys(
  getToken: () => Promise<string | null>,
): Promise<{ keys: ApiKeyInfo[] }> {
  return fetchApi<{ keys: ApiKeyInfo[] }>("/api/vault/keys", getToken);
}

export async function revokeApiKey(
  getToken: () => Promise<string | null>,
  id: number,
): Promise<void> {
  return fetchApi<void>(`/api/vault/keys/${id}`, getToken, { method: "DELETE" });
}
