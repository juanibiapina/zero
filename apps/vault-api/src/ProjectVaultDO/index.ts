/**
 * ============================================================================
 * ProjectVaultDO — Per-Project Secrets Storage
 * ============================================================================
 *
 * One ProjectVaultDO instance per project, keyed by `${orgId}:${projectName}`.
 * Holds this project's own DEK, its environments, and its encrypted secrets.
 * The DO IS the project — there is no `projects` table or `project_id`.
 *
 * Uses envelope encryption: a per-project DEK encrypted with the Worker's
 * MASTER_KEY. Each project's isolated DEK is what enables cryptographic shred
 * on delete (see `destroy()`).
 */

import { DurableObject } from "cloudflare:workers";
import { createDb, migrate, eq, and, type Database } from "do-orm";
import { migrations } from "./db/migrations";
import { vaultConfigTable, environmentsTable, secretsTable } from "./db/schema";
import type { Env } from "../types";
import {
  generateDek,
  encryptDek,
  decryptDek,
  deriveSubKeys,
  encryptValue,
  decryptValue,
  hmacKeyName,
} from "../crypto";

export class ProjectVaultDO extends DurableObject<Env> {
  db: Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(ctx.storage);

    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, migrations);
    });
  }

  // ============================================================================
  // DEK Management
  // ============================================================================

  private async getSubKeys(): Promise<{
    encryptionKey: CryptoKey;
    hmacKey: CryptoKey;
  }> {
    const existing = this.db.get(vaultConfigTable, {
      where: eq("key", "dek_encrypted"),
    });

    let dekBytes: Uint8Array;

    if (existing) {
      dekBytes = await decryptDek(existing.value, this.env.MASTER_KEY);
    } else {
      dekBytes = generateDek();
      const encryptedDek = await encryptDek(dekBytes, this.env.MASTER_KEY);
      const now = new Date().toISOString();

      this.db.insert(vaultConfigTable, { key: "dek_encrypted", value: encryptedDek });
      this.db.insert(vaultConfigTable, { key: "dek_created_at", value: now });
    }

    return deriveSubKeys(dekBytes);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Idempotent project initialization. Mints the DEK (via getSubKeys) and
   * creates default `development` + `production` environments if absent.
   * Called by the project-create route after OrgDO.createProject. Returns the
   * env list; if envs already exist, returns them without duplicating.
   */
  async initialize(): Promise<{ id: string; name: string; createdAt: string }[]> {
    await this.getSubKeys();

    const existing = this.db.select(environmentsTable, ["id", "name", "created_at"]);
    if (existing.length > 0) {
      return existing.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
    }

    const now = new Date().toISOString();
    const devId = crypto.randomUUID();
    const prodId = crypto.randomUUID();

    this.db.insert(environmentsTable, { id: devId, name: "development", created_at: now });
    this.db.insert(environmentsTable, { id: prodId, name: "production", created_at: now });

    return [
      { id: devId, name: "development", createdAt: now },
      { id: prodId, name: "production", createdAt: now },
    ];
  }

  /**
   * Cryptographic shred. Deletes the vault_config DEK row and all environments
   * and secrets. Because each project has its own DEK, deleting that DEK makes
   * this project's ciphertext permanently unrecoverable — even the retained
   * ciphertext bytes cannot be decrypted. Idempotent (safe to retry after a
   * crash); recreating the same project name mints a fresh DEK.
   */
  destroy(): void {
    this.db.delete(secretsTable, {});
    this.db.delete(environmentsTable, {});
    this.db.delete(vaultConfigTable, {});
  }

  // ============================================================================
  // Environment Operations
  // ============================================================================

  /**
   * Returns this project's environments. An empty/uninitialized vault returns
   * `[]` — this is how unknown/deleted projects yield an empty env list at the
   * route without an OrgDO lookup.
   */
  listEnvironments(): { id: string; name: string; createdAt: string }[] {
    const rows = this.db.select(environmentsTable, ["id", "name", "created_at"]);
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  createEnvironment(
    name: string,
  ): { id: string; name: string; createdAt: string } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.insert(environmentsTable, { id, name, created_at: now });

    return { id, name, createdAt: now };
  }

  deleteEnvironment(name: string): boolean {
    const env = this.db.get(environmentsTable, { where: eq("name", name) });
    if (!env) return false;

    // Cascade: delete secrets first
    this.db.delete(secretsTable, { where: eq("environment_id", env.id) });
    this.db.delete(environmentsTable, { where: eq("id", env.id) });
    return true;
  }

  // ============================================================================
  // Secret Operations
  // ============================================================================

  private resolveEnvironment(envName: string): string | null {
    const env = this.db.get(environmentsTable, { where: eq("name", envName) });
    return env?.id ?? null;
  }

  async getSecrets(
    envName: string,
  ): Promise<{ key: string; value: string }[] | null> {
    const envId = this.resolveEnvironment(envName);
    if (!envId) return null;

    const { encryptionKey } = await this.getSubKeys();

    const rows = this.db.select(secretsTable, ["key_encrypted", "value_encrypted"], {
      where: eq("environment_id", envId),
    });

    return Promise.all(
      rows.map(async (row) => ({
        key: await decryptValue(row.key_encrypted, encryptionKey),
        value: await decryptValue(row.value_encrypted, encryptionKey),
      })),
    );
  }

  async putSecrets(
    envName: string,
    secrets: { key: string; value: string }[],
  ): Promise<boolean> {
    const envId = this.resolveEnvironment(envName);
    if (!envId) return false;

    const { encryptionKey, hmacKey } = await this.getSubKeys();
    const now = new Date().toISOString();

    this.db.delete(secretsTable, { where: eq("environment_id", envId) });

    for (const s of secrets) {
      this.db.insert(secretsTable, {
        id: crypto.randomUUID(),
        environment_id: envId,
        key_encrypted: await encryptValue(s.key, encryptionKey),
        key_hash: await hmacKeyName(s.key, hmacKey),
        value_encrypted: await encryptValue(s.value, encryptionKey),
        updated_at: now,
      });
    }

    return true;
  }

  async patchSecrets(
    envName: string,
    entries: { key: string; value: string | null }[],
  ): Promise<boolean> {
    const envId = this.resolveEnvironment(envName);
    if (!envId) return false;

    const { encryptionKey, hmacKey } = await this.getSubKeys();
    const now = new Date().toISOString();

    for (const entry of entries) {
      const keyHashValue = await hmacKeyName(entry.key, hmacKey);

      if (entry.value === null) {
        this.db.delete(secretsTable, {
          where: and(eq("environment_id", envId), eq("key_hash", keyHashValue)),
        });
      } else {
        const existing = this.db.get(secretsTable, {
          where: and(eq("environment_id", envId), eq("key_hash", keyHashValue)),
        });

        const keyEnc = await encryptValue(entry.key, encryptionKey);
        const valEnc = await encryptValue(entry.value, encryptionKey);

        if (existing) {
          this.db.update(
            secretsTable,
            { key_encrypted: keyEnc, value_encrypted: valEnc, updated_at: now },
            { where: eq("id", existing.id) },
          );
        } else {
          this.db.insert(secretsTable, {
            id: crypto.randomUUID(),
            environment_id: envId,
            key_encrypted: keyEnc,
            key_hash: keyHashValue,
            value_encrypted: valEnc,
            updated_at: now,
          });
        }
      }
    }

    return true;
  }
}
