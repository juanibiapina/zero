#!/usr/bin/env node

/**
 * ============================================================================
 * ZeroVault CLI — `zv`
 * ============================================================================
 *
 * Command-line interface for ZeroVault secrets manager.
 *
 * Auth (first match wins): --api-key flag > context bound to the current
 * directory (see `zv context`) > ZEROVAULT_API_KEY env. Base URL resolves the
 * same way (--base-url > context.baseUrl > ZEROVAULT_API_URL > default).
 */

import { Command } from "commander";
import { ZeroVaultClient } from "./client.js";
import { exportVault, importVault, type VaultExport } from "./vault-transfer.js";
import {
  loadConfig,
  saveConfig,
  resolveContextForDir,
  resolveAuth,
  addContext,
  removeContext,
  bindContext,
  unbindContext,
  configPath,
  DEFAULT_BASE_URL,
} from "./config.js";

/**
 * Single place that reads flags / env / config and applies the auth
 * precedence. Every command goes through here so precedence lives in one spot.
 */
function getClient(): ZeroVaultClient {
  const opts = program.opts<{ apiKey?: string; baseUrl?: string }>();
  const auth = resolveAuth({
    flags: { apiKey: opts.apiKey, baseUrl: opts.baseUrl },
    env: { apiKey: process.env.ZEROVAULT_API_KEY, apiUrl: process.env.ZEROVAULT_API_URL },
    context: resolveContextForDir(loadConfig(), process.cwd()),
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
  if (!auth) {
    console.error(
      "Error: no API key. Set ZEROVAULT_API_KEY, pass --api-key, or bind this " +
        "directory to a context with `zv context use`. " +
        "See https://docs.zeroapps.dev/vault/getting-started/ to create one.",
    );
    process.exit(1);
  }
  return new ZeroVaultClient(auth.baseUrl, auth.apiKey);
}

const program = new Command();

program
  .name("zv")
  .description("ZeroVault secrets manager CLI")
  .version("0.2.1")
  .option("--api-key <key>", "API key (overrides env and context)")
  .option("--base-url <url>", "API base URL (overrides env and context)");

program.addHelpText("after", "\nDocs: https://docs.zeroapps.dev/vault/cli/");

// ============================================================================
// whoami
// ============================================================================

program
  .command("whoami")
  .description("Validate API key and show user info")
  .action(async () => {
    const client = getClient();
    const info = await client.whoami();
    console.log(`User ID: ${info.userId}`);
    console.log(`Org ID: ${info.orgId}`);
  });

// ============================================================================
// context — named, kubectl-style contexts stored in a local config file
// ============================================================================

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
    const { apiKey, baseUrl } = program.opts<{ apiKey?: string; baseUrl?: string }>();
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

// ============================================================================
// projects
// ============================================================================

const projects = program
  .command("projects")
  .description("Manage projects");

projects
  .command("list")
  .description("List all projects")
  .action(async () => {
    const client = getClient();
    const { projects } = await client.listProjects();
    if (projects.length === 0) {
      console.log("No projects");
      return;
    }
    for (const p of projects) {
      console.log(`${p.name}  (created ${p.createdAt})`);
    }
  });

projects
  .command("create")
  .argument("<name>", "Project name")
  .description("Create a new project")
  .action(async (name: string) => {
    const client = getClient();
    const project = await client.createProject(name);
    console.log(`Created project: ${project.name}`);
    console.log(`Environments: ${project.environments.map((e) => e.name).join(", ")}`);
  });

projects
  .command("delete")
  .argument("<name>", "Project name")
  .description("Delete a project")
  .action(async (name: string) => {
    const client = getClient();
    await client.deleteProject(name);
    console.log(`Deleted project: ${name}`);
  });

// ============================================================================
// env
// ============================================================================

const env = program
  .command("env")
  .description("Manage environments");

env
  .command("list")
  .requiredOption("-p, --project <name>", "Project name")
  .description("List environments")
  .action(async (opts: { project: string }) => {
    const client = getClient();
    const { environments } = await client.listEnvironments(opts.project);
    if (environments.length === 0) {
      console.log("No environments");
      return;
    }
    for (const e of environments) {
      console.log(e.name);
    }
  });

env
  .command("create")
  .argument("<name>", "Environment name")
  .requiredOption("-p, --project <name>", "Project name")
  .description("Create an environment")
  .action(async (name: string, opts: { project: string }) => {
    const client = getClient();
    await client.createEnvironment(opts.project, name);
    console.log(`Created environment: ${name}`);
  });

env
  .command("delete")
  .argument("<name>", "Environment name")
  .requiredOption("-p, --project <name>", "Project name")
  .description("Delete an environment")
  .action(async (name: string, opts: { project: string }) => {
    const client = getClient();
    await client.deleteEnvironment(opts.project, name);
    console.log(`Deleted environment: ${name}`);
  });

// ============================================================================
// secrets
// ============================================================================

const secrets = program
  .command("secrets")
  .description("Manage secrets");

secrets
  .command("list")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-e, --env <name>", "Environment name")
  .description("List secret keys (values masked)")
  .action(async (opts: { project: string; env: string }) => {
    const client = getClient();
    const { secrets } = await client.getSecrets(opts.project, opts.env);
    if (secrets.length === 0) {
      console.log("No secrets");
      return;
    }
    for (const s of secrets.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`${s.key}=••••••••`);
    }
  });

secrets
  .command("get")
  .argument("<key>", "Secret key")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-e, --env <name>", "Environment name")
  .description("Get a single secret value")
  .action(async (key: string, opts: { project: string; env: string }) => {
    const client = getClient();
    const { secrets } = await client.getSecrets(opts.project, opts.env);
    const entry = secrets.find((s) => s.key === key);
    if (!entry) {
      console.error(`Secret '${key}' not found`);
      process.exit(1);
    }
    console.log(entry.value);
  });

secrets
  .command("set")
  .argument("<pairs...>", "KEY=VALUE pairs")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-e, --env <name>", "Environment name")
  .description("Set secrets")
  .action(async (pairs: string[], opts: { project: string; env: string }) => {
    const entries = pairs.map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        console.error(`Invalid format: ${pair} (expected KEY=VALUE)`);
        process.exit(1);
      }
      return { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });

    const client = getClient();
    await client.patchSecrets(opts.project, opts.env, entries);
    console.log(`Set ${entries.length} secret(s)`);
  });

secrets
  .command("delete")
  .argument("<key>", "Secret key")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-e, --env <name>", "Environment name")
  .description("Delete a secret")
  .action(async (key: string, opts: { project: string; env: string }) => {
    const client = getClient();
    await client.patchSecrets(opts.project, opts.env, [{ key, value: null }]);
    console.log(`Deleted secret: ${key}`);
  });

secrets
  .command("download")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption("-e, --env <name>", "Environment name")
  .option("-f, --format <format>", "Output format (env|json|yaml|shell)", "env")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .description("Download all secrets")
  .action(async (opts: { project: string; env: string; format: string; output?: string }) => {
    const client = getClient();
    const { secrets } = await client.getSecrets(opts.project, opts.env);
    const sorted = secrets.sort((a, b) => a.key.localeCompare(b.key));

    let output: string;
    switch (opts.format) {
      case "json":
        output = JSON.stringify(
          Object.fromEntries(sorted.map((s) => [s.key, s.value])),
          null,
          2,
        );
        break;
      case "yaml":
        output = sorted.map((s) => `${s.key}: "${s.value.replace(/"/g, '\\"')}"`).join("\n");
        break;
      case "shell":
        output = sorted.map((s) => `export ${s.key}="${s.value.replace(/"/g, '\\"')}"`).join("\n");
        break;
      case "env":
      default:
        output = sorted.map((s) => `${s.key}=${s.value}`).join("\n");
        break;
    }

    if (opts.output) {
      const fs = await import("fs");
      fs.writeFileSync(opts.output, output + "\n");
      console.error(`Written to ${opts.output}`);
    } else {
      console.log(output);
    }
  });

// ============================================================================
// export / import
// ============================================================================

program
  .command("export")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .description(
    "Export the whole vault (every project, environment and secret) as a " +
      "version:1 JSON document. WARNING: the output contains plaintext secret " +
      "values — delete the file after use.",
  )
  .action(async (opts: { output?: string }) => {
    const client = getClient();
    const data = await exportVault(client);
    const json = JSON.stringify(data, null, 2);

    if (opts.output) {
      const fs = await import("fs");
      fs.writeFileSync(opts.output, json + "\n");
      console.error(`Exported to ${opts.output}`);
    } else {
      console.log(json);
    }

    console.error(
      "WARNING: export contains plaintext secret values. Delete it after use.",
    );
  });

program
  .command("import")
  .argument("<file>", "Path to a vault export JSON file")
  .description(
    "Import a version:1 vault export: create each project and environment " +
      "(existing ones are left in place) and full-replace every environment's " +
      "secrets. Re-runnable — converges to the file's state.",
  )
  .action(async (file: string) => {
    const client = getClient();
    const fs = await import("fs");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as VaultExport;
    await importVault(client, data);
    console.error(`Imported ${data.projects.length} project(s)`);
  });

// ============================================================================
// keys
// ============================================================================

const keys = program
  .command("keys")
  .description("Manage API keys");

keys
  .command("create")
  .option("-l, --label <name>", "Key label")
  .description("Create a new API key")
  .action(async (opts: { label?: string }) => {
    const client = getClient();
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
    const client = getClient();
    const { keys } = await client.listKeys();
    if (keys.length === 0) {
      console.log("No API keys");
      return;
    }
    for (const k of keys) {
      const label = k.label ? ` (${k.label})` : "";
      console.log(`${k.id}: ${k.prefix}${k.suffix}${label}  created ${k.createdAt}`);
    }
  });

keys
  .command("revoke")
  .argument("<id>", "Key ID")
  .description("Revoke an API key")
  .action(async (id: string) => {
    const client = getClient();
    await client.revokeKey(parseInt(id, 10));
    console.log(`Revoked key ${id}`);
  });

program.parse();
