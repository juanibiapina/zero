/**
 * ============================================================================
 * Zero CLI — client construction
 * ============================================================================
 *
 * Single place that reads flags / env / config and applies the auth
 * precedence, so every command agrees on which key and origin it uses:
 *
 *   --api-key flag > directory context (`zero context`) > ZERO_API_KEY env
 *   > `zero login` on this machine
 *
 * The base URL resolves the same way (--base-url > context.baseUrl >
 * ZERO_API_URL > default) and is product-neutral; each client appends its own
 * `/vault/v1` or `/errors/v1` prefix.
 */

import { ErrorsClient } from "./clients/errors.js";
import { VaultClient } from "./clients/vault.js";
import {
  loadConfig,
  resolveContextForDir,
  resolveAuth,
  saveConfig,
  DEFAULT_BASE_URL,
  type ResolvedAuth,
} from "./config.js";
import { freshAccessToken } from "./oauth.js";

export interface AuthFlags {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Resolve credentials or exit(1) with the message a user without a key reads
 * first. It ships inside a published binary, so it names the env var and the
 * doc page explicitly rather than pointing at a product page.
 */
export async function requireAuth(flags: AuthFlags): Promise<ResolvedAuth> {
  const config = loadConfig();
  const auth = resolveAuth({
    flags,
    env: { apiKey: process.env.ZERO_API_KEY, apiUrl: process.env.ZERO_API_URL },
    context: resolveContextForDir(config, process.cwd()),
    logins: config.logins,
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
  if (!auth) {
    console.error(
      "Error: no credentials. Run `zero login`, set ZERO_API_KEY, pass " +
        "--api-key, or bind this directory to a context with " +
        "`zero context use`. " +
        "See https://docs.zeroapps.dev/account/api-keys/ to create a key.",
    );
    process.exit(1);
  }

  if (auth.via !== "login" || !auth.login) return auth;

  // An access token lives a day, so most commands refresh nothing; when one
  // does, the rotated pair is written before it is used.
  const fresh = await freshAccessToken(auth.login, {
    save: (login) => {
      const latest = loadConfig();
      latest.logins = { ...latest.logins, [auth.baseUrl]: login };
      saveConfig(latest);
    },
  });
  if (!fresh) {
    console.error("Error: your sign-in has expired. Run `zero login` again.");
    process.exit(1);
  }

  return { ...auth, apiKey: fresh.accessToken, login: fresh };
}

export async function getVaultClient(flags: AuthFlags): Promise<VaultClient> {
  const { baseUrl, apiKey } = await requireAuth(flags);
  return new VaultClient(baseUrl, apiKey);
}

export async function getErrorsClient(flags: AuthFlags): Promise<ErrorsClient> {
  const { baseUrl, apiKey } = await requireAuth(flags);
  return new ErrorsClient(baseUrl, apiKey);
}
