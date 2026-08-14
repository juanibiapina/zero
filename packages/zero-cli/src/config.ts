/**
 * ============================================================================
 * Zero CLI — local config & named contexts
 * ============================================================================
 *
 * Owns persistence and resolution of named contexts and their per-directory
 * bindings. A context maps a name to an API key (and optional base URL); the
 * file also records which context each project directory is bound to. Running
 * `zero` in a bound directory (or a subdirectory) uses that context. This is
 * the single seam for reading/writing that state — `auth.ts` and the
 * `zero context` commands are its only callers.
 *
 * The file lives at `~/.config/zero/config.json` (override with the
 * `ZERO_CONFIG` env var) and holds plaintext API keys, so it is always
 * written mode 0600 inside a 0700 directory — same tradeoff as `kubectl` /
 * `aws` credentials.
 *
 * There is no migration from the old `~/.config/zerovault/config.json` written
 * by the `zv` CLI: that file is never read, and a user re-runs
 * `zero context add`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Login } from "./oauth.js";

export interface Context {
  apiKey: string;
  /** Optional per-context base URL; falls back to env/default when absent. */
  baseUrl?: string;
  /** Optional cached org id (metadata only — resolution never depends on it). */
  orgId?: string;
}

export interface Config {
  /** Absolute directory path → context name. A binding applies to subdirs. */
  dirContexts?: Record<string, string>;
  contexts: Record<string, Context>;
  /**
   * Browser sign-ins, keyed by the API origin they authorize. Keyed by origin
   * because a login is only valid for the instance that issued it, and because
   * `--base-url` must be able to select one.
   */
  logins?: Record<string, Login>;
}

/**
 * Resolve the config file path. Reads `ZERO_CONFIG` (used by tests to point at
 * a temp file) and otherwise defaults under the home directory. Kept in one
 * place so every caller agrees on the location.
 */
export function configPath(): string {
  const override = process.env.ZERO_CONFIG;
  if (override) return override;
  return path.join(os.homedir(), ".config", "zero", "config.json");
}

/**
 * Read and parse the config. Returns an empty config when the file does not
 * exist. Throws a clear error on malformed JSON.
 */
export function loadConfig(): Config {
  const file = configPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { contexts: {} };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed config at ${file}: not valid JSON`);
  }

  const config = parsed as Config;
  if (!config.contexts) config.contexts = {};
  return config;
}

/**
 * Write the config. Creates the parent dir (0700) if missing and always
 * chmods the file to 0600, since it holds plaintext API keys.
 */
export function saveConfig(config: Config): void {
  const file = configPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * The context bound to `cwd`, or the nearest bound ancestor directory, or null
 * when no ancestor is bound (or the binding points at a missing context). Walks
 * up to the filesystem root, nearest binding wins — the same lookup shape as
 * git/direnv.
 */
export function resolveContextForDir(config: Config, cwd: string): Context | null {
  const bindings = config.dirContexts ?? {};
  let dir = path.resolve(cwd);
  for (;;) {
    const name = bindings[dir];
    if (name) return config.contexts[name] ?? null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ----------------------------------------------------------------------------
// In-memory mutations used by the `zero context` commands. Each returns the
// mutated config; the caller persists with saveConfig.
// ----------------------------------------------------------------------------

/** Add or overwrite a named context. */
export function addContext(config: Config, name: string, context: Context): Config {
  config.contexts[name] = context;
  return config;
}

/** Remove a context and prune any directory bindings that reference it. */
export function removeContext(config: Config, name: string): Config {
  delete config.contexts[name];
  if (config.dirContexts) {
    for (const dir of Object.keys(config.dirContexts)) {
      if (config.dirContexts[dir] === name) delete config.dirContexts[dir];
    }
  }
  return config;
}

/** Bind a directory to a context. Throws if the named context does not exist. */
export function bindContext(config: Config, dir: string, name: string): Config {
  if (!config.contexts[name]) {
    throw new Error(`No such context: ${name}`);
  }
  if (!config.dirContexts) config.dirContexts = {};
  config.dirContexts[path.resolve(dir)] = name;
  return config;
}

/** Remove a directory's binding. Returns whether a binding was removed. */
export function unbindContext(config: Config, dir: string): boolean {
  const key = path.resolve(dir);
  if (config.dirContexts && key in config.dirContexts) {
    delete config.dirContexts[key];
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Auth resolution
// ----------------------------------------------------------------------------

/**
 * Canonical public API origin when no flag/context/env overrides it. It is
 * product-neutral on purpose: each client appends its own product prefix
 * (`/vault/v1`, `/errors/v1`), so one base URL serves the whole CLI. A value
 * carrying a `/vault` suffix is passed through verbatim — the CLI does not
 * rewrite it — and will produce 404s.
 */
export const DEFAULT_BASE_URL = "https://api.zeroapps.dev";

export interface ResolvedAuth {
  /** Bearer credential: a `zv_` key, or a login's OAuth access token. */
  apiKey: string;
  baseUrl: string;
  /** Which credential answered. `whoami` reports it; nothing else branches. */
  via: "api_key" | "login" | "ci";
  /** Set for `via: "ci"`: the org the workflow's token was exchanged for. */
  orgId?: string;
  /** Present for `via: "login"`, so a caller can refresh and name the user. */
  login?: Login;
}

/**
 * Pure key-resolution precedence, first match wins:
 *   flag > per-dir context > env > stored login > (none → null).
 * A GitHub Actions sign-in sits between the env var and the stored login, but
 * it costs a network round trip, so `auth.ts` inserts it rather than this
 * function: `logins` is simply omitted when the caller wants to try CI first.
 * A directory binding is a deliberate per-project choice, so it beats the
 * ambient env var; a `--api-key` flag still overrides everything. A `zero
 * login` sits last because it is the most ambient of all: machine-wide state
 * the user set once, which must never silently shadow a key they just exported.
 * `baseUrl` resolves first and independently (flag > context > env > default),
 * since a login is only valid for the origin that issued it. Kept pure (no
 * process/env/fs) so precedence is directly testable.
 */
/**
 * Where requests go, decided independently of which credential is used:
 * flag > context > env > default. A login and a CI exchange are both bound to
 * one origin, so the origin has to be known before either is looked up.
 */
export function resolveBaseUrl(input: {
  flags: { baseUrl?: string };
  env: { apiUrl?: string };
  context: Context | null;
  defaultBaseUrl: string;
}): string {
  return (
    input.flags.baseUrl ?? input.context?.baseUrl ?? input.env.apiUrl ?? input.defaultBaseUrl
  );
}

export function resolveAuth(input: {
  flags: { apiKey?: string; baseUrl?: string };
  env: { apiKey?: string; apiUrl?: string };
  context: Context | null;
  logins?: Record<string, Login>;
  defaultBaseUrl: string;
}): ResolvedAuth | null {
  const { flags, env, context, logins, defaultBaseUrl } = input;

  const baseUrl = resolveBaseUrl({ flags, env, context, defaultBaseUrl });

  const apiKey = flags.apiKey ?? context?.apiKey ?? env.apiKey;
  if (apiKey) return { apiKey, baseUrl, via: "api_key" };

  const login = logins?.[baseUrl];
  if (login) return { apiKey: login.accessToken, baseUrl, via: "login", login };

  return null;
}
