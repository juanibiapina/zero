/**
 * ============================================================================
 * OrgDO — Per-Org Index and Key Ring
 * ============================================================================
 *
 * One OrgDO instance per organization (keyed by Clerk org ID).
 * Holds the project registry and the org's API key metadata.
 *
 * OrgDO stores NO ciphertext — secrets live in per-project ProjectVaultDO
 * instances, each with its own DEK. So OrgDO has no vault_config / DEK.
 */

import { DurableObject } from "cloudflare:workers";
import { createDb, migrate, eq, and, type Database } from "do-orm";
import { migrations } from "./db/migrations";
import { projectsTable, apiKeysTable, ciTrustsTable } from "./db/schema";
import type { Env } from "../types";
import { hashApiKey, type ApiKeyKVValue, type CiTrust } from "@zero/auth";

/**
 * KV key for the repository → orgs index. The exchange endpoint is
 * unauthenticated and has no org in hand, so this is what turns a verified
 * token into the org (or orgs) that trust it, without scanning every OrgDO.
 */
export function ciTrustIndexKey(ownerId: string, repoId: string): string {
  return `ci:github:${ownerId}/${repoId}`;
}

export class OrgDO extends DurableObject<Env> {
  db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);

    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  // ============================================================================
  // API Key Operations
  // ============================================================================

  async createApiKey(
    ctx: { orgId: string; userId: string },
    label?: string,
  ): Promise<{
    key: string;
    id: number;
    prefix: string;
    suffix: string;
    label?: string;
    createdAt: string;
  }> {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const key = `zv_${randomHex}`;
    const keyHash = await hashApiKey(key);
    const prefix = key.slice(0, 7) + "...";
    const suffix = key.slice(-4);
    const createdAt = new Date().toISOString();

    // Org-scoped KV value: orgId routes DOs, userId attributes the creator.
    const kvValue: ApiKeyKVValue = {
      v: 2,
      orgId: ctx.orgId,
      userId: ctx.userId,
    };
    await this.env.APIKEYS.put(keyHash, JSON.stringify(kvValue));

    const result = this.db.insertReturning(
      apiKeysTable,
      {
        key_hash: keyHash,
        prefix,
        suffix,
        label: label ?? null,
        encrypted_key: null,
        created_at: createdAt,
      },
      ["id"],
    );

    console.log({
      event: "org.key_created",
      orgId: ctx.orgId,
      userId: ctx.userId,
      label: label ?? null,
    });

    return {
      key,
      id: result.id,
      prefix,
      suffix,
      createdAt,
      ...(label && { label }),
    };
  }

  async listApiKeys(): Promise<
    { id: number; prefix: string; suffix: string; label?: string; createdAt: string }[]
  > {
    const keys = this.db.select(apiKeysTable, ["id", "prefix", "suffix", "label", "created_at"]);

    return keys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      suffix: k.suffix,
      createdAt: k.created_at,
      ...(k.label && { label: k.label }),
    }));
  }

  async revokeApiKey(id: number): Promise<void> {
    const key = this.db.selectOne(apiKeysTable, ["key_hash"], {
      where: eq("id", id),
    });

    if (key) {
      await this.env.APIKEYS.delete(key.key_hash);
    }

    this.db.delete(apiKeysTable, { where: eq("id", id) });
  }

  // ============================================================================
  // CI Trust Operations
  // ============================================================================

  /**
   * Trust a GitHub repository to exchange its OIDC token for a credential in
   * this org. The KV index is what the (unauthenticated) exchange endpoint
   * reads, so it never has to guess which org a workflow belongs to.
   *
   * Idempotent: trusting the same repository again rewrites its constraints
   * rather than failing. "Trust this repo with these rules" is the intent, and
   * a second `zero ci trust add` should tighten a ref or add an event, not
   * force the user to delete a record first.
   */
  async addCiTrust(input: {
    ownerId: string;
    repoId: string;
    repository: string;
    ref?: string | null;
    environment?: string | null;
    allowedEvents?: string[];
    label?: string;
    orgId: string;
  }): Promise<{ id: number; createdAt: string }> {
    const createdAt = new Date().toISOString();

    const existing = this.db.selectOne(ciTrustsTable, ["id"], {
      where: and(eq("owner_id", input.ownerId), eq("repo_id", input.repoId)),
    });

    if (existing) {
      this.db.update(
        ciTrustsTable,
        {
          repository: input.repository,
          ref: input.ref ?? null,
          environment: input.environment ?? null,
          allowed_events: (input.allowedEvents ?? []).join(","),
          label: input.label ?? null,
        },
        { where: eq("id", existing.id) },
      );
      await this.indexCiTrust(input.ownerId, input.repoId, input.orgId);
      return { id: existing.id, createdAt };
    }

    const result = this.db.insertReturning(
      ciTrustsTable,
      {
        provider: "github",
        owner_id: input.ownerId,
        repo_id: input.repoId,
        repository: input.repository,
        ref: input.ref ?? null,
        environment: input.environment ?? null,
        allowed_events: (input.allowedEvents ?? []).join(","),
        label: input.label ?? null,
        created_at: createdAt,
      },
      ["id"],
    );

    await this.indexCiTrust(input.ownerId, input.repoId, input.orgId);

    console.log({
      event: "org.ci_trust_added",
      orgId: input.orgId,
      repository: input.repository,
      repoId: input.repoId,
    });

    return { id: result.id, createdAt };
  }

  listCiTrusts(): (CiTrust & {
    id: number;
    repository: string;
    label?: string;
    createdAt: string;
  })[] {
    const rows = this.db.select(ciTrustsTable, [
      "id",
      "owner_id",
      "repo_id",
      "repository",
      "ref",
      "environment",
      "allowed_events",
      "label",
      "created_at",
    ]);

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      repoId: r.repo_id,
      repository: r.repository,
      ref: r.ref,
      environment: r.environment,
      allowedEvents: r.allowed_events ? r.allowed_events.split(",") : [],
      createdAt: r.created_at,
      ...(r.label && { label: r.label }),
    }));
  }

  /** The trust record for a repository, or null when this org trusts none. */
  findCiTrust(ownerId: string, repoId: string): CiTrust | null {
    const row = this.db.selectOne(
      ciTrustsTable,
      ["owner_id", "repo_id", "ref", "environment", "allowed_events"],
      { where: and(eq("owner_id", ownerId), eq("repo_id", repoId)) },
    );
    if (!row) return null;

    return {
      ownerId: row.owner_id,
      repoId: row.repo_id,
      ref: row.ref,
      environment: row.environment,
      allowedEvents: row.allowed_events ? row.allowed_events.split(",") : [],
    };
  }

  async removeCiTrust(id: number, orgId: string): Promise<void> {
    const row = this.db.selectOne(ciTrustsTable, ["owner_id", "repo_id"], {
      where: eq("id", id),
    });
    this.db.delete(ciTrustsTable, { where: eq("id", id) });

    if (row) await this.unindexCiTrust(row.owner_id, row.repo_id, orgId);
  }

  /**
   * Mints the short-lived credential a verified workflow gets. Same KV shape as
   * an API key, so the request path is unchanged, but it expires on its own and
   * has no row anywhere: nothing to revoke, nothing to leak.
   */
  async mintCiToken(input: {
    orgId: string;
    repoId: string;
    ttlSeconds: number;
  }): Promise<{ token: string; expiresIn: number }> {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const token = `zci_${randomHex}`;

    const kvValue: ApiKeyKVValue = {
      v: 2,
      orgId: input.orgId,
      userId: `ci:github:${input.repoId}`,
    };
    await this.env.APIKEYS.put(await hashApiKey(token), JSON.stringify(kvValue), {
      expirationTtl: input.ttlSeconds,
    });

    return { token, expiresIn: input.ttlSeconds };
  }

  private async indexCiTrust(ownerId: string, repoId: string, orgId: string): Promise<void> {
    const key = ciTrustIndexKey(ownerId, repoId);
    const raw = await this.env.APIKEYS.get(key);
    const orgIds = raw ? (JSON.parse(raw) as string[]) : [];
    if (!orgIds.includes(orgId)) orgIds.push(orgId);
    await this.env.APIKEYS.put(key, JSON.stringify(orgIds));
  }

  private async unindexCiTrust(ownerId: string, repoId: string, orgId: string): Promise<void> {
    const key = ciTrustIndexKey(ownerId, repoId);
    const raw = await this.env.APIKEYS.get(key);
    if (!raw) return;
    const orgIds = (JSON.parse(raw) as string[]).filter((id) => id !== orgId);
    if (orgIds.length === 0) await this.env.APIKEYS.delete(key);
    else await this.env.APIKEYS.put(key, JSON.stringify(orgIds));
  }

  // ============================================================================
  // Project Registry Operations
  // ============================================================================

  listProjects(): { id: string; name: string; createdAt: string }[] {
    const rows = this.db.select(projectsTable, ["id", "name", "created_at"]);
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  /**
   * Registers a project. Returns null (409-signal) when the name already exists.
   * Creates only the registry row — default environments live in
   * ProjectVaultDO.initialize().
   */
  createProject(
    name: string,
  ): { id: string; name: string; createdAt: string } | null {
    const existing = this.db.get(projectsTable, { where: eq("name", name) });
    if (existing) return null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.insert(projectsTable, { id, name, created_at: now });

    console.log({ event: "org.project_created", projectName: name });

    return { id, name, createdAt: now };
  }

  /**
   * Deletes the registry row. Returns whether it existed (so the route knows
   * whether to shred the project's ProjectVaultDO).
   */
  deleteProject(name: string): boolean {
    const project = this.db.get(projectsTable, { where: eq("name", name) });
    if (!project) return false;

    this.db.delete(projectsTable, { where: eq("id", project.id) });
    return true;
  }
}
