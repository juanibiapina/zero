/**
 * ============================================================================
 * Vault transfer — export / import
 * ============================================================================
 *
 * Walks the whole vault the current key can see and serialises it to a
 * portable, versioned JSON document (`exportVault`), and replays such a
 * document back against a vault (`importVault`).
 *
 * The logic sits behind narrow client ports so the round-trip is testable
 * against an in-memory fake with no running Worker. The real HTTP client
 * (production) and the in-memory fake (tests) are the two adapters.
 */

import { ApiError } from "./client.js";

export interface VaultExport {
  version: 1;
  projects: {
    name: string;
    environments: {
      name: string;
      secrets: { key: string; value: string }[];
    }[];
  }[];
}

// Narrow ports — only what each direction needs.
export interface ExportClient {
  listProjects(): Promise<{ projects: { name: string }[] }>;
  listEnvironments(project: string): Promise<{ environments: { name: string }[] }>;
  getSecrets(project: string, env: string): Promise<{ secrets: { key: string; value: string }[] }>;
}

export interface ImportClient {
  createProject(name: string): Promise<unknown>;
  createEnvironment(project: string, name: string): Promise<unknown>;
  putSecrets(
    project: string,
    env: string,
    secrets: { key: string; value: string }[],
  ): Promise<unknown>;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/**
 * Walk projects → environments → secrets and produce a deterministic
 * (sorted) document. Determinism makes the round-trip test a plain
 * deep-equality check and keeps export diffs stable.
 */
export async function exportVault(client: ExportClient): Promise<VaultExport> {
  const { projects } = await client.listProjects();
  const out: VaultExport["projects"] = [];

  for (const project of [...projects].sort(byName)) {
    const { environments } = await client.listEnvironments(project.name);
    const envs: VaultExport["projects"][number]["environments"] = [];

    for (const env of [...environments].sort(byName)) {
      const { secrets } = await client.getSecrets(project.name, env.name);
      envs.push({
        name: env.name,
        secrets: [...secrets].sort((a, b) => a.key.localeCompare(b.key)),
      });
    }

    out.push({ name: project.name, environments: envs });
  }

  return { version: 1, projects: out };
}

function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * Replay a document against a vault. Creates each project and environment
 * (ignoring 409 "already exists" so re-runs converge) and full-replaces the
 * secrets of every environment via PUT. Idempotent.
 */
export async function importVault(client: ImportClient, data: VaultExport): Promise<void> {
  if (data.version !== 1) {
    throw new Error(`Unsupported vault export version: ${(data as { version: unknown }).version}`);
  }

  for (const project of data.projects) {
    try {
      await client.createProject(project.name);
    } catch (err) {
      if (!isConflict(err)) throw err;
    }

    for (const env of project.environments) {
      try {
        await client.createEnvironment(project.name, env.name);
      } catch (err) {
        if (!isConflict(err)) throw err;
      }

      await client.putSecrets(project.name, env.name, env.secrets);
    }
  }
}
