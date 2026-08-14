#!/usr/bin/env node

/**
 * ============================================================================
 * Zero CLI — `zero`
 * ============================================================================
 *
 * One command line for the whole Zero suite: `zero vault ...` for ZeroVault
 * secrets, `zero errors ...` for ZeroErrors issues, and `zero keys` for the
 * org-scoped API key that authorizes both.
 *
 * Auth (first match wins): --api-key flag > context bound to the current
 * directory (see `zero context`) > ZERO_API_KEY env. The base URL resolves the
 * same way (--base-url > context.baseUrl > ZERO_API_URL > default) and is a
 * bare origin; each client appends its own product prefix.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { getVaultClient, type AuthFlags } from "./auth.js";
import * as contextCommands from "./commands/context.js";
import * as errorsCommands from "./commands/errors.js";
import * as keysCommands from "./commands/keys.js";
import * as vaultCommands from "./commands/vault.js";

// Version is read at runtime from package.json so it can never drift from the
// published version. package.json sits one directory above this module in both
// the repo (src/index.ts) and the published tarball (dist/index.js).
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("zero")
  .description("Zero CLI — ZeroVault secrets and ZeroErrors issues")
  .version(version)
  .option("--api-key <key>", "API key (overrides env and context)")
  .option("--base-url <url>", "API base URL (overrides env and context)");

program.addHelpText("after", "\nDocs: https://docs.zeroapps.dev/");

program
  .command("whoami")
  .description("Validate the API key and show user info")
  .action(async () => {
    const client = getVaultClient(program.opts<AuthFlags>());
    const info = await client.whoami();
    console.log(`User ID: ${info.userId}`);
    console.log(`Org ID: ${info.orgId}`);
  });

contextCommands.register(program);
keysCommands.register(program);
vaultCommands.register(program);
errorsCommands.register(program);

program.parse();
