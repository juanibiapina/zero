/**
 * ============================================================================
 * ZeroVault CLI — local config & named contexts
 * ============================================================================
 *
 * Owns persistence and resolution of named contexts and their per-directory
 * bindings. A context maps a name to an API key (and optional base URL); the
 * file also records which context each project directory is bound to. Running
 * `zv` in a bound directory (or a subdirectory) uses that context. This is the
 * single seam for reading/writing that state — `getClient()` and the
 * `zv context` commands are its only callers.
 *
 * The file lives at `~/.config/zerovault/config.json` (override with the
 * `ZEROVAULT_CONFIG` env var) and holds plaintext API keys, so it is always
 * written mode 0600 inside a 0700 directory — same tradeoff as `kubectl` /
 * `aws` credentials.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
}

/**
 * Resolve the config file path. Reads `ZEROVAULT_CONFIG` (used by tests to
 * point at a temp file) and otherwise defaults under the home directory.
 * Kept in one place so every caller agrees on the location.
 */
export function configPath(): string {
  const override = process.env.ZEROVAULT_CONFIG;
  if (override) return override;
  return path.join(os.homedir(), ".config", "zerovault", "config.json");
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
// In-memory mutations used by the `zv context` commands. Each returns the
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
 * Canonical console host the CLI targets when no flag/context/env overrides it.
 * A subdomain of the Clerk primary domain `apps.juanibiapina.dev`.
 */
export const DEFAULT_BASE_URL = "https://vault.apps.juanibiapina.dev";

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
}

/**
 * Pure key-resolution precedence, first match wins:
 *   flag > per-dir context > env > (none → null).
 * A directory binding is a deliberate per-project choice, so it beats the
 * ambient env var; a `--api-key` flag still overrides everything. `baseUrl`
 * resolves independently with the same precedence, defaulting to
 * `defaultBaseUrl` when no source supplies it. Kept pure (no process/env/fs)
 * so precedence is directly testable.
 */
export function resolveAuth(input: {
  flags: { apiKey?: string; baseUrl?: string };
  env: { apiKey?: string; apiUrl?: string };
  context: Context | null;
  defaultBaseUrl: string;
}): ResolvedAuth | null {
  const { flags, env, context, defaultBaseUrl } = input;

  const apiKey = flags.apiKey ?? context?.apiKey ?? env.apiKey;
  if (!apiKey) return null;

  const baseUrl = flags.baseUrl ?? context?.baseUrl ?? env.apiUrl ?? defaultBaseUrl;
  return { apiKey, baseUrl };
}
