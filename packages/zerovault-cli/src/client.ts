/**
 * ============================================================================
 * ZeroVault API Client
 * ============================================================================
 *
 * HTTP client for the ZeroVault API. Uses ZEROVAULT_API_KEY env var.
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

export class ZeroVaultClient {
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

  // Keys
  async whoami() {
    return this.request<{ userId: string; orgId: string }>("/v1/whoami");
  }

  async createKey(label?: string) {
    return this.request<{
      key: string;
      id: number;
      prefix: string;
      suffix: string;
      label?: string;
      createdAt: string;
    }>("/v1/keys", { method: "POST", body: { label } });
  }

  async listKeys() {
    return this.request<{
      keys: { id: number; prefix: string; suffix: string; label?: string; createdAt: string }[];
    }>("/v1/keys");
  }

  async revokeKey(id: number) {
    return this.request<void>(`/v1/keys/${id}`, { method: "DELETE" });
  }

  // Projects
  async listProjects() {
    return this.request<{
      projects: { id: string; name: string; createdAt: string }[];
    }>("/v1/projects");
  }

  async createProject(name: string) {
    return this.request<{
      id: string;
      name: string;
      createdAt: string;
      environments: { id: string; name: string; createdAt: string }[];
    }>("/v1/projects", { method: "POST", body: { name } });
  }

  async deleteProject(name: string) {
    return this.request<void>(`/v1/projects/${name}`, { method: "DELETE" });
  }

  // Environments
  async listEnvironments(project: string) {
    return this.request<{
      environments: { id: string; name: string; createdAt: string }[];
    }>(`/v1/projects/${project}/environments`);
  }

  async createEnvironment(project: string, name: string) {
    return this.request<{
      id: string;
      name: string;
      createdAt: string;
    }>(`/v1/projects/${project}/environments`, {
      method: "POST",
      body: { name },
    });
  }

  async deleteEnvironment(project: string, name: string) {
    return this.request<void>(
      `/v1/projects/${project}/environments/${name}`,
      { method: "DELETE" },
    );
  }

  // Secrets
  async getSecrets(project: string, env: string) {
    return this.request<{
      secrets: { key: string; value: string }[];
    }>(`/v1/projects/${project}/environments/${env}/secrets`);
  }

  async putSecrets(
    project: string,
    env: string,
    secrets: { key: string; value: string }[],
  ) {
    return this.request<{ ok: boolean }>(
      `/v1/projects/${project}/environments/${env}/secrets`,
      { method: "PUT", body: { secrets } },
    );
  }

  async patchSecrets(
    project: string,
    env: string,
    secrets: { key: string; value: string | null }[],
  ) {
    return this.request<{ ok: boolean }>(
      `/v1/projects/${project}/environments/${env}/secrets`,
      { method: "PATCH", body: { secrets } },
    );
  }
}
