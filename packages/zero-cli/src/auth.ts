/**
 * ============================================================================
 * Zero CLI — client construction
 * ============================================================================
 *
 * Single place that reads flags / env / config and applies the auth
 * precedence, so every command agrees on which key and origin it uses:
 *
 *   --api-key flag > directory context (`zero context`) > ZERO_API_KEY env
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
  DEFAULT_BASE_URL,
  type ResolvedAuth,
} from "./config.js";

export interface AuthFlags {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Resolve credentials or exit(1) with the message a user without a key reads
 * first. It ships inside a published binary, so it names the env var and the
 * doc page explicitly rather than pointing at a product page.
 */
function requireAuth(flags: AuthFlags): ResolvedAuth {
  const auth = resolveAuth({
    flags,
    env: { apiKey: process.env.ZERO_API_KEY, apiUrl: process.env.ZERO_API_URL },
    context: resolveContextForDir(loadConfig(), process.cwd()),
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
  if (!auth) {
    console.error(
      "Error: no API key. Set ZERO_API_KEY, pass --api-key, or bind this " +
        "directory to a context with `zero context use`. " +
        "See https://docs.zeroapps.dev/account/api-keys/ to create one.",
    );
    process.exit(1);
  }
  return auth;
}

export function getVaultClient(flags: AuthFlags): VaultClient {
  const { baseUrl, apiKey } = requireAuth(flags);
  return new VaultClient(baseUrl, apiKey);
}

export function getErrorsClient(flags: AuthFlags): ErrorsClient {
  const { baseUrl, apiKey } = requireAuth(flags);
  return new ErrorsClient(baseUrl, apiKey);
}
