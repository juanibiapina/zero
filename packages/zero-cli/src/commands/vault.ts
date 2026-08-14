/**
 * `zero vault` — ZeroVault projects, environments, secrets, and whole-vault
 * export/import.
 *
 * Flag spellings are load-bearing: scripts pipe
 * `zero vault secrets download --format json` into other tools, so only the
 * command path moved when `zv` was retired.
 */

import type { Command } from "commander";
import { getVaultClient, type AuthFlags } from "../auth.js";
import { exportVault, importVault, type VaultExport } from "../vault-transfer.js";

interface ProjectEnvOpts {
  project: string;
  env: string;
}

export function register(program: Command): void {
  const vault = program
    .command("vault")
    .description("Manage secrets in ZeroVault");

  const client = () => getVaultClient(program.opts<AuthFlags>());

  // --------------------------------------------------------------------------
  // projects
  // --------------------------------------------------------------------------

  const projects = vault
    .command("projects")
    .description("Manage projects");

  projects
    .command("list")
    .description("List all projects")
    .action(async () => {
      const { projects: list } = await client().listProjects();
      if (list.length === 0) {
        console.log("No projects");
        return;
      }
      for (const p of list) {
        console.log(`${p.name}  (created ${p.createdAt})`);
      }
    });

  projects
    .command("create")
    .argument("<name>", "Project name")
    .description("Create a new project")
    .action(async (name: string) => {
      const project = await client().createProject(name);
      console.log(`Created project: ${project.name}`);
      console.log(`Environments: ${project.environments.map((e) => e.name).join(", ")}`);
    });

  projects
    .command("delete")
    .argument("<name>", "Project name")
    .description("Delete a project")
    .action(async (name: string) => {
      await client().deleteProject(name);
      console.log(`Deleted project: ${name}`);
    });

  // --------------------------------------------------------------------------
  // env
  // --------------------------------------------------------------------------

  const env = vault
    .command("env")
    .description("Manage environments");

  env
    .command("list")
    .requiredOption("-p, --project <name>", "Project name")
    .description("List environments")
    .action(async (opts: { project: string }) => {
      const { environments } = await client().listEnvironments(opts.project);
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
      await client().createEnvironment(opts.project, name);
      console.log(`Created environment: ${name}`);
    });

  env
    .command("delete")
    .argument("<name>", "Environment name")
    .requiredOption("-p, --project <name>", "Project name")
    .description("Delete an environment")
    .action(async (name: string, opts: { project: string }) => {
      await client().deleteEnvironment(opts.project, name);
      console.log(`Deleted environment: ${name}`);
    });

  // --------------------------------------------------------------------------
  // secrets
  // --------------------------------------------------------------------------

  const secrets = vault
    .command("secrets")
    .description("Manage secrets");

  secrets
    .command("list")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-e, --env <name>", "Environment name")
    .description("List secret keys (values masked)")
    .action(async (opts: ProjectEnvOpts) => {
      const { secrets: list } = await client().getSecrets(opts.project, opts.env);
      if (list.length === 0) {
        console.log("No secrets");
        return;
      }
      for (const s of list.sort((a, b) => a.key.localeCompare(b.key))) {
        console.log(`${s.key}=••••••••`);
      }
    });

  secrets
    .command("get")
    .argument("<key>", "Secret key")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-e, --env <name>", "Environment name")
    .description("Get a single secret value")
    .action(async (key: string, opts: ProjectEnvOpts) => {
      const { secrets: list } = await client().getSecrets(opts.project, opts.env);
      const entry = list.find((s) => s.key === key);
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
    .action(async (pairs: string[], opts: ProjectEnvOpts) => {
      const entries = pairs.map((pair) => {
        const eq = pair.indexOf("=");
        if (eq === -1) {
          console.error(`Invalid format: ${pair} (expected KEY=VALUE)`);
          process.exit(1);
        }
        return { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
      });

      await client().patchSecrets(opts.project, opts.env, entries);
      console.log(`Set ${entries.length} secret(s)`);
    });

  secrets
    .command("delete")
    .argument("<key>", "Secret key")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-e, --env <name>", "Environment name")
    .description("Delete a secret")
    .action(async (key: string, opts: ProjectEnvOpts) => {
      await client().patchSecrets(opts.project, opts.env, [{ key, value: null }]);
      console.log(`Deleted secret: ${key}`);
    });

  secrets
    .command("download")
    .requiredOption("-p, --project <name>", "Project name")
    .requiredOption("-e, --env <name>", "Environment name")
    .option("-f, --format <format>", "Output format (env|json|yaml|shell)", "env")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .description("Download all secrets")
    .action(async (opts: ProjectEnvOpts & { format: string; output?: string }) => {
      const { secrets: list } = await client().getSecrets(opts.project, opts.env);
      const sorted = list.sort((a, b) => a.key.localeCompare(b.key));

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

  // --------------------------------------------------------------------------
  // export / import
  // --------------------------------------------------------------------------

  vault
    .command("export")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .description(
      "Export the whole vault (every project, environment and secret) as a " +
        "version:1 JSON document. WARNING: the output contains plaintext secret " +
        "values — delete the file after use.",
    )
    .action(async (opts: { output?: string }) => {
      const data = await exportVault(client());
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

  vault
    .command("import")
    .argument("<file>", "Path to a vault export JSON file")
    .description(
      "Import a version:1 vault export: create each project and environment " +
        "(existing ones are left in place) and full-replace every environment's " +
        "secrets. Re-runnable — converges to the file's state.",
    )
    .action(async (file: string) => {
      const fs = await import("fs");
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as VaultExport;
      await importVault(client(), data);
      console.error(`Imported ${data.projects.length} project(s)`);
    });
}
