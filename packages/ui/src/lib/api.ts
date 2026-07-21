/**
 * ============================================================================
 * API Client
 * ============================================================================
 *
 * The shared fetch wrapper for /api/* account-management endpoints. Attaches
 * the Clerk session JWT, sets JSON headers, unwraps errors, and handles 204.
 * Product-specific endpoint functions live in each app and call this.
 */

export type GetToken = () => Promise<string | null>;

export async function fetchApi<T>(
  path: string,
  getToken: GetToken,
  options: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body: unknown = await res
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
