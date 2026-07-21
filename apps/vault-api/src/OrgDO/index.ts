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
import { createDb, migrate, eq, type Database } from "do-orm";
import { migrations } from "./db/migrations";
import { projectsTable, apiKeysTable } from "./db/schema";
import type { Env } from "../types";
import { hashApiKey, type ApiKeyKVValue } from "@zero/auth";

export class OrgDO extends DurableObject<Env> {
  db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);

    ctx.blockConcurrencyWhile(async () => {
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
