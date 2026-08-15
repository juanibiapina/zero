/**
 * `zero context` — named, kubectl-style contexts stored in a local config file.
 */

import type { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  resolveContextEntryForDir,
  addContext,
  removeContext,
  bindContext,
  unbindContext,
  configPath,
  isLoginContext,
  resolveBaseUrl,
  loginKey,
  DEFAULT_BASE_URL,
  type Config,
  type Context,
} from "../config.js";
import { revokeLogin } from "../oauth.js";
import type { AuthFlags } from "../auth.js";

/**
 * Where a context's credential lives: the same resolution every command uses,
 * so `--base-url` selects the same instance here as it does for a request.
 */
function contextBaseUrl(context: Context, flagBaseUrl?: string): string {
  return resolveBaseUrl({
    flags: { ...(flagBaseUrl ? { baseUrl: flagBaseUrl } : {}) },
    env: { ...(process.env.ZERO_API_URL ? { apiUrl: process.env.ZERO_API_URL } : {}) },
    context,
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
}

/** How `list` names what a context carries. */
function describeContext(context: Context, config: Config, flagBaseUrl?: string): string {
  if (!isLoginContext(context)) return "api key";
  const baseUrl = contextBaseUrl(context, flagBaseUrl);
  const login = config.logins?.[loginKey(baseUrl, context.login.orgId)];
  const who = login?.email ?? login?.userId;
  const suffix = login ? "" : " — no sign-in on this machine";
  return `login ${who ?? "?"} (org ${context.login.orgId})${suffix}`;
}

export function register(program: Command): void {
  const context = program
    .command("context")
    .description(
      `Manage named contexts and per-directory bindings (config: ${configPath()}). ` +
        "Each context maps a name to a credential and optional base URL: an API " +
        "key (`zero context add --api-key`) or a browser sign-in (`zero login " +
        "--context <name>`). Either one carries the org, so contexts let one " +
        "machine target several orgs. " +
        "`use` binds the current directory to a context; a binding applies to " +
        "subdirectories too.",
    );

  context
    .command("list")
    .description("List contexts, marking the one bound to the current directory")
    .action(() => {
      const config = loadConfig();
      const names = Object.keys(config.contexts).sort();
      if (names.length === 0) {
        console.log("(none)");
        return;
      }
      const current = resolveContextEntryForDir(config, process.cwd());
      for (const name of names) {
        const marker = current?.name === name ? "*" : " ";
        console.log(
          `${marker} ${name}\t${describeContext(
            config.contexts[name],
            config,
            program.opts<AuthFlags>().baseUrl,
          )}`,
        );
      }
    });

  context
    .command("current")
    .description("Print the context bound to the current directory")
    .action(() => {
      const config = loadConfig();
      const current = resolveContextEntryForDir(config, process.cwd());
      if (!current) {
        console.error("No context bound to the current directory");
        process.exit(1);
      }
      console.log(current.name);
    });

  context
    .command("use")
    .argument("<name>", "Context name")
    .description("Bind the current directory to a context")
    .action((name: string) => {
      const config = loadConfig();
      try {
        bindContext(config, process.cwd(), name);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
      saveConfig(config);
      console.log(`Bound ${process.cwd()} to context: ${name}`);
    });

  context
    .command("unset")
    .description("Remove the current directory's context binding")
    .action(() => {
      const config = loadConfig();
      const removed = unbindContext(config, process.cwd());
      if (!removed) {
        console.error("No context bound to the current directory");
        process.exit(1);
      }
      saveConfig(config);
      console.log(`Unbound ${process.cwd()}`);
    });

  context
    .command("add")
    .argument("<name>", "Context name")
    .description("Add or overwrite a context (provide --api-key, optional --base-url)")
    .action((name: string) => {
      // The API key and base URL come from the global --api-key / --base-url
      // flags (commander parses them at the root), so there is one flag spelling
      // for both auth override and storing a context.
      const { apiKey, baseUrl } = program.opts<AuthFlags>();
      if (!apiKey) {
        console.error("Error: --api-key is required to add a context");
        process.exit(1);
      }
      const config = loadConfig();
      saveConfig(
        addContext(config, name, {
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
        }),
      );
      console.log(`Added context: ${name}`);
    });

  context
    .command("remove")
    .argument("<name>", "Context name")
    .description("Remove a context (also drops any directory bindings to it)")
    .action(async (name: string) => {
      const config = loadConfig();
      const context = config.contexts[name];
      if (!context) {
        console.error(`Error: no such context: ${name}`);
        process.exit(1);
      }

      // A context's sign-in is reachable only through that context, so leaving
      // it behind would strand a live credential nobody can use or see.
      let signedOut: string | null = null;
      if (isLoginContext(context)) {
        const baseUrl = contextBaseUrl(context, program.opts<AuthFlags>().baseUrl);
        const key = loginKey(baseUrl, context.login.orgId);
        const stillUsed = Object.entries(config.contexts).some(
          ([other, value]) =>
            other !== name &&
            isLoginContext(value) &&
            value.login.orgId === context.login.orgId &&
            contextBaseUrl(value, program.opts<AuthFlags>().baseUrl) === baseUrl,
        );
        const login = config.logins?.[key];
        if (login && !stillUsed) {
          await revokeLogin(login);
          delete config.logins?.[key];
          signedOut = context.login.orgId;
        }
      }

      saveConfig(removeContext(config, name));
      console.log(
        signedOut
          ? `Removed context: ${name} (signed out of org ${signedOut})`
          : `Removed context: ${name}`,
      );
    });
}
