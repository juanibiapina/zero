/**
 * ============================================================================
 * ZeroVault API client
 * ============================================================================
 *
 * Every path is prefixed `/vault/v1`, including API keys: `/vault/v1/keys` is
 * the only API-key route for key management, even though the CLI presents
 * `zero keys` at the top level because a key is org-scoped and authorizes
 * every product.
 *
 * Response shapes are declared inline on purpose. This package publishes to
 * npm with `commander` as its only runtime dependency, so it must not import
 * the unpublished `@zero/*` workspace packages.
 */

import { HttpClient } from "./http.js";

const P = "/vault/v1";

export class VaultClient {
  private http: HttpClient;

  constructor(baseUrl: string, apiKey: string) {
    this.http = new HttpClient(baseUrl, apiKey);
  }

  async whoami() {
    return this.http.request<{ userId: string; orgId: string }>(`${P}/whoami`);
  }

  // Keys
  async createKey(label?: string) {
    return this.http.request<{
      key: string;
      id: number;
      prefix: string;
      suffix: string;
      label?: string;
      createdAt: string;
    }>(`${P}/keys`, { method: "POST", body: { label } });
  }

  async listKeys() {
    return this.http.request<{
      keys: { id: number; prefix: string; suffix: string; label?: string; createdAt: string }[];
    }>(`${P}/keys`);
  }

  async revokeKey(id: number) {
    return this.http.request<void>(`${P}/keys/${id}`, { method: "DELETE" });
  }

  // CI trusts
  async addCiTrust(input: {
    ownerId: string;
    repoId: string;
    repository: string;
    ref?: string;
    environment?: string;
    allowedEvents?: string[];
    label?: string;
  }) {
    return this.http.request<{ id: number; createdAt: string }>(`${P}/ci/trusts`, {
      method: "POST",
      body: input,
    });
  }

  async listCiTrusts() {
    return this.http.request<{
      trusts: {
        id: number;
        repository: string;
        ownerId: string;
        repoId: string;
        ref: string | null;
        environment: string | null;
        allowedEvents: string[];
        label?: string;
        createdAt: string;
      }[];
    }>(`${P}/ci/trusts`);
  }

  async removeCiTrust(id: string) {
    return this.http.request<void>(`${P}/ci/trusts/${id}`, { method: "DELETE" });
  }

  // Projects
  async listProjects() {
    return this.http.request<{
      projects: { id: string; name: string; createdAt: string }[];
    }>(`${P}/projects`);
  }

  async createProject(name: string) {
    return this.http.request<{
      id: string;
      name: string;
      createdAt: string;
      environments: { id: string; name: string; createdAt: string }[];
    }>(`${P}/projects`, { method: "POST", body: { name } });
  }

  async deleteProject(name: string) {
    return this.http.request<void>(`${P}/projects/${name}`, { method: "DELETE" });
  }

  // Environments
  async listEnvironments(project: string) {
    return this.http.request<{
      environments: { id: string; name: string; createdAt: string }[];
    }>(`${P}/projects/${project}/environments`);
  }

  async createEnvironment(project: string, name: string) {
    return this.http.request<{
      id: string;
      name: string;
      createdAt: string;
    }>(`${P}/projects/${project}/environments`, {
      method: "POST",
      body: { name },
    });
  }

  async deleteEnvironment(project: string, name: string) {
    return this.http.request<void>(
      `${P}/projects/${project}/environments/${name}`,
      { method: "DELETE" },
    );
  }

  // Secrets
  async getSecrets(project: string, env: string) {
    return this.http.request<{
      secrets: { key: string; value: string }[];
    }>(`${P}/projects/${project}/environments/${env}/secrets`);
  }

  async putSecrets(
    project: string,
    env: string,
    secrets: { key: string; value: string }[],
  ) {
    return this.http.request<{ ok: boolean }>(
      `${P}/projects/${project}/environments/${env}/secrets`,
      { method: "PUT", body: { secrets } },
    );
  }

  async patchSecrets(
    project: string,
    env: string,
    secrets: { key: string; value: string | null }[],
  ) {
    return this.http.request<{ ok: boolean }>(
      `${P}/projects/${project}/environments/${env}/secrets`,
      { method: "PATCH", body: { secrets } },
    );
  }
}
