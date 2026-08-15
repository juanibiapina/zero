/**
 * ============================================================================
 * Zero CLI — client construction
 * ============================================================================
 *
 * Single place that reads flags / env / config and applies the auth
 * precedence, so every command agrees on which key and origin it uses:
 *
 *   --api-key flag > directory context (`zero context`, an API key or a
 *   browser sign-in) > ZERO_API_KEY env > GitHub Actions OIDC > `zero login`
 *   on this machine
 *
 * A directory bound to a sign-in resolves before all of that and never falls
 * back: the binding names one organization, and silently answering with
 * another one is the failure it exists to prevent.
 *
 * Inside a workflow that declares `permissions: id-token: write`, the CLI
 * authenticates itself with no secret at all. That sits below the env var so a
 * repository can still pin a key during a migration, and above a stored login
 * because a runner has no browser.
 *
 * The base URL resolves the same way (--base-url > context.baseUrl >
 * ZERO_API_URL > default) and is product-neutral; each client appends its own
 * `/vault/v1` or `/errors/v1` prefix.
 */

import { ErrorsClient } from "./clients/errors.js";
import { VaultClient } from "./clients/vault.js";
import {
  actionsEnvironment,
  exchangeCiToken,
  requestOidcToken,
  ZERO_OIDC_AUDIENCE,
} from "./ci-oidc.js";
import {
  contextLogin,
  isLoginContext,
  loadConfig,
  resolveContextEntryForDir,
  resolveAuth,
  resolveBaseUrl,
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
  const env = { apiKey: process.env.ZERO_API_KEY, apiUrl: process.env.ZERO_API_URL };
  const entry = resolveContextEntryForDir(config, process.cwd());
  const context = entry?.context ?? null;

  // A directory bound to a sign-in is answered here, before CI and before any
  // fallback: the binding names one organization, so a missing sign-in has to
  // stop the command rather than quietly resolve to a different org.
  if (context && isLoginContext(context) && !flags.apiKey) {
    const baseUrl = resolveBaseUrl({ flags, env, context, defaultBaseUrl: DEFAULT_BASE_URL });
    const { login } = contextLogin({ context, baseUrl, logins: config.logins });
    if (!login) {
      console.error(
        `Error: context "${entry!.name}" has no sign-in on this machine. ` +
          `Run \`zero login --context ${entry!.name}\`.`,
      );
      process.exit(1);
    }
    return withFreshLogin({
      ...resolveAuth({
        flags,
        env,
        context,
        logins: config.logins,
        defaultBaseUrl: DEFAULT_BASE_URL,
      })!,
      contextName: entry!.name,
    });
  }

  // Explicit credentials first, with no network call and no logins considered.
  const explicit = resolveAuth({ flags, env, context, defaultBaseUrl: DEFAULT_BASE_URL });
  if (explicit) {
    const fromContext = !flags.apiKey && context !== null && !isLoginContext(context);
    return fromContext ? { ...explicit, contextName: entry!.name } : explicit;
  }

  const actions = actionsEnvironment(process.env);
  if (actions) {
    const baseUrl = resolveBaseUrl({ flags, env, context, defaultBaseUrl: DEFAULT_BASE_URL });
    try {
      const oidcToken = await requestOidcToken(actions, ZERO_OIDC_AUDIENCE);
      const exchanged = await exchangeCiToken({
        baseUrl,
        oidcToken,
        ...(process.env.ZERO_ORG && { orgId: process.env.ZERO_ORG }),
      });
      return { apiKey: exchanged.accessToken, baseUrl, via: "ci", orgId: exchanged.orgId };
    } catch (err) {
      // Being in Actions with id-token: write is a deliberate choice, so a
      // failure here is a misconfiguration to report, not something to fall
      // back from silently.
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const auth = resolveAuth({
    flags,
    env,
    context,
    logins: config.logins,
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
  if (!auth) {
    console.error(
      "Error: no credentials. Run `zero login`, set ZERO_API_KEY, pass " +
        "--api-key, or bind this directory to a context with " +
        "`zero context use`. In GitHub Actions, add `permissions: id-token: " +
        "write` to the job. " +
        "See https://docs.zeroapps.dev/account/api-keys/ to create a key.",
    );
    process.exit(1);
  }

  return withFreshLogin(auth);
}

/**
 * Swap a stored sign-in for a usable one. An access token lives a day, so most
 * commands refresh nothing; when one does, the rotated pair is written back to
 * the key it came from, before it is used.
 */
async function withFreshLogin(auth: ResolvedAuth): Promise<ResolvedAuth> {
  if (auth.via !== "login" || !auth.login) return auth;

  const key = auth.loginKey ?? auth.baseUrl;
  const fresh = await freshAccessToken(auth.login, {
    save: (login) => {
      const latest = loadConfig();
      latest.logins = { ...latest.logins, [key]: login };
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
