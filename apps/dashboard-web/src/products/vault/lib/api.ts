/**
 * ============================================================================
 * API Client
 * ============================================================================
 *
 * Typed fetch client for the /api/* account management endpoints.
 * All requests include the Clerk session JWT for authentication.
 */

import { fetchApi } from "@zero/ui";
import type {
  ApiKeyInfo,
  ApiKeyCreated,
  Project,
  Environment,
  SecretEntry,
} from "@zero/vault-core";

// ============================================================================
// API Keys
// ============================================================================

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

// ============================================================================
// Projects
// ============================================================================

export async function listProjects(
  getToken: () => Promise<string | null>,
): Promise<{ projects: Project[] }> {
  return fetchApi<{ projects: Project[] }>("/api/vault/projects", getToken);
}

export async function createProject(
  getToken: () => Promise<string | null>,
  name: string,
): Promise<Project> {
  return fetchApi<Project>("/api/vault/projects", getToken, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(
  getToken: () => Promise<string | null>,
  name: string,
): Promise<void> {
  return fetchApi<void>(`/api/vault/projects/${name}`, getToken, { method: "DELETE" });
}

// ============================================================================
// Environments
// ============================================================================

export async function listEnvironments(
  getToken: () => Promise<string | null>,
  projectName: string,
): Promise<{ environments: Environment[] }> {
  return fetchApi<{ environments: Environment[] }>(
    `/api/vault/projects/${projectName}/environments`,
    getToken,
  );
}

export async function createEnvironment(
  getToken: () => Promise<string | null>,
  projectName: string,
  envName: string,
): Promise<Environment> {
  return fetchApi<Environment>(
    `/api/vault/projects/${projectName}/environments`,
    getToken,
    {
      method: "POST",
      body: JSON.stringify({ name: envName }),
    },
  );
}

export async function deleteEnvironment(
  getToken: () => Promise<string | null>,
  projectName: string,
  envName: string,
): Promise<void> {
  return fetchApi<void>(
    `/api/vault/projects/${projectName}/environments/${envName}`,
    getToken,
    { method: "DELETE" },
  );
}

// ============================================================================
// Secrets
// ============================================================================

export async function getSecrets(
  getToken: () => Promise<string | null>,
  projectName: string,
  envName: string,
): Promise<{ secrets: SecretEntry[] }> {
  return fetchApi<{ secrets: SecretEntry[] }>(
    `/api/vault/projects/${projectName}/environments/${envName}/secrets`,
    getToken,
  );
}

export async function putSecrets(
  getToken: () => Promise<string | null>,
  projectName: string,
  envName: string,
  secrets: SecretEntry[],
): Promise<void> {
  return fetchApi<void>(
    `/api/vault/projects/${projectName}/environments/${envName}/secrets`,
    getToken,
    {
      method: "PUT",
      body: JSON.stringify({ secrets }),
    },
  );
}

export async function patchSecrets(
  getToken: () => Promise<string | null>,
  projectName: string,
  envName: string,
  secrets: { key: string; value: string | null }[],
): Promise<void> {
  return fetchApi<void>(
    `/api/vault/projects/${projectName}/environments/${envName}/secrets`,
    getToken,
    {
      method: "PATCH",
      body: JSON.stringify({ secrets }),
    },
  );
}
