/**
 * `zero context` — named, kubectl-style contexts stored in a local config file.
 */

import type { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  resolveContextForDir,
  addContext,
  removeContext,
  bindContext,
  unbindContext,
  configPath,
} from "../config.js";
import type { AuthFlags } from "../auth.js";

export function register(program: Command): void {
  const context = program
    .command("context")
    .description(
      `Manage named contexts and per-directory bindings (config: ${configPath()}). ` +
        "Each context maps a name to an API key and optional base URL; a key is " +
        "the org binding, so contexts let one machine target several orgs. " +
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
      const current = resolveContextForDir(config, process.cwd());
      for (const name of names) {
        const marker = current === config.contexts[name] ? "*" : " ";
        console.log(`${marker} ${name}`);
      }
    });

  context
    .command("current")
    .description("Print the context bound to the current directory")
    .action(() => {
      const config = loadConfig();
      const current = resolveContextForDir(config, process.cwd());
      if (!current) {
        console.error("No context bound to the current directory");
        process.exit(1);
      }
      const name = Object.keys(config.contexts).find((n) => config.contexts[n] === current);
      console.log(name);
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
    .action((name: string) => {
      const config = loadConfig();
      if (!config.contexts[name]) {
        console.error(`Error: no such context: ${name}`);
        process.exit(1);
      }
      saveConfig(removeContext(config, name));
      console.log(`Removed context: ${name}`);
    });
}
