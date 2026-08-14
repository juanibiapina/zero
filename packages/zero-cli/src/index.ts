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
 * directory (see `zero context`) > ZERO_API_KEY env > GitHub Actions OIDC >
 * `zero login`. The base URL resolves the
 * same way (--base-url > context.baseUrl > ZERO_API_URL > default) and is a
 * bare origin; each client appends its own product prefix.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ApiError } from "./clients/http.js";
import { getVaultClient, requireAuth, type AuthFlags } from "./auth.js";
import type { ResolvedAuth } from "./config.js";
import * as ciCommands from "./commands/ci.js";
import * as contextCommands from "./commands/context.js";
import * as loginCommands from "./commands/login.js";
import * as errorsCommands from "./commands/errors.js";
import * as keysCommands from "./commands/keys.js";
import * as vaultCommands from "./commands/vault.js";

// Version is read at runtime from package.json so it can never drift from the
// published version. package.json sits one directory above this module in both
// the repo (src/index.ts) and the published tarball (dist/index.js).
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** How `whoami` names the credential that answered. */
function describeCredential(auth: ResolvedAuth): string {
  if (auth.via === "login") {
    return `signed in as ${auth.login?.email ?? auth.login?.userId}`;
  }
  if (auth.via === "ci") return "github actions";
  return "api key";
}

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
    const client = await getVaultClient(program.opts<AuthFlags>());
    const info = await client.whoami();
    console.log(`User ID: ${info.userId}`);
    console.log(`Org ID: ${info.orgId}`);
    // Which credential answered, because a stale ZERO_API_KEY silently
    // shadows a fresh `zero login` and nothing else would say so.
    const auth = await requireAuth(program.opts<AuthFlags>());
    console.log(`Credential: ${describeCredential(auth)}`);
  });

loginCommands.register(program);
ciCommands.register(program);
contextCommands.register(program);
keysCommands.register(program);
vaultCommands.register(program);
errorsCommands.register(program);

/**
 * Exit codes, per the Unix convention the docs promise:
 *   1  the API refused the request (bad credential, missing project, conflict)
 *   75 the API could not answer (unreachable, 5xx) — a retry may work
 *
 * A failed request is an ordinary outcome for a CLI, so it prints one line on
 * stderr. The stack is still there under ZERO_DEBUG, where a real bug needs it.
 */
function reportFailure(err: unknown): never {
  const debug = Boolean(process.env.ZERO_DEBUG);

  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    if (err.status === 401) {
      console.error(
        "Run `zero login`, or set ZERO_API_KEY to a valid key " +
          "(https://docs.zeroapps.dev/account/api-keys/).",
      );
    }
    if (debug) console.error(err.stack);
    process.exit(err.status >= 500 ? 75 : 1);
  }

  // fetch() rejects with a TypeError for DNS, connection refused and TLS
  // failures alike: the API never answered, so it is the retryable case.
  if (err instanceof TypeError) {
    console.error(`Error: could not reach the Zero API: ${err.message}`);
    if (debug) console.error(err.stack);
    process.exit(75);
  }

  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  if (debug && err instanceof Error) console.error(err.stack);
  process.exit(1);
}

program.parseAsync().catch(reportFailure);
