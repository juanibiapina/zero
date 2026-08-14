/**
 * `zero keys` — org-scoped API keys.
 *
 * Top-level, not under `zero vault`: one key authorizes every Zero product, so
 * a key is not a Vault object. The endpoint still lives at `/vault/v1/keys`,
 * which `VaultClient` owns.
 */

import type { Command } from "commander";
import { getVaultClient, type AuthFlags } from "../auth.js";

export function register(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage API keys (one key authorizes every Zero product)");

  keys
    .command("create")
    .option("-l, --label <name>", "Key label")
    .description("Create a new API key")
    .action(async (opts: { label?: string }) => {
      const client = getVaultClient(program.opts<AuthFlags>());
      const result = await client.createKey(opts.label);
      console.log(`API Key: ${result.key}`);
      console.log(`ID: ${result.id}`);
      if (result.label) console.log(`Label: ${result.label}`);
      console.log("\nSave this key now — it won't be shown again.");
    });

  keys
    .command("list")
    .description("List API keys")
    .action(async () => {
      const client = getVaultClient(program.opts<AuthFlags>());
      const { keys: list } = await client.listKeys();
      if (list.length === 0) {
        console.log("No API keys");
        return;
      }
      for (const k of list) {
        const label = k.label ? ` (${k.label})` : "";
        console.log(`${k.id}: ${k.prefix}${k.suffix}${label}  created ${k.createdAt}`);
      }
    });

  keys
    .command("revoke")
    .argument("<id>", "Key ID")
    .description("Revoke an API key")
    .action(async (id: string) => {
      const client = getVaultClient(program.opts<AuthFlags>());
      await client.revokeKey(parseInt(id, 10));
      console.log(`Revoked key ${id}`);
    });
}
