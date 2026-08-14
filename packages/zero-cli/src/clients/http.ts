/**
 * ============================================================================
 * Zero API — HTTP transport
 * ============================================================================
 *
 * The one place that knows how a Zero API request is authenticated and how a
 * failure becomes an error. Product clients (`VaultClient`, `ErrorsClient`)
 * are thin typed façades over this: they own paths and response shapes only.
 *
 * `baseUrl` is a product-neutral origin (e.g. `https://api.zeroapps.dev`);
 * each client passes its own prefixed path (`/vault/v1/...`, `/errors/v1/...`).
 */

/**
 * Error carrying the HTTP status from a failed API request.
 * Lets callers distinguish e.g. 409 (already exists) from other failures
 * without brittle message-string matching.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class HttpClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Request failed" }));
      const msg = (body as { error?: string }).error || `HTTP ${res.status}`;
      throw new ApiError(msg, res.status);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }
}
